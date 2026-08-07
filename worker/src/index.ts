#!/usr/bin/env node
/**
 * The command-line entry point.
 *
 * Four commands, each doing one thing an operator can reason about:
 *
 *   enroll   exchange a one-time token from the studio for this machine's
 *            credential
 *   doctor   check everything without leasing a job or spending a token
 *   run      poll for work and run it
 *   version  what this build is, and what upstream release it drives
 *
 * ``run`` is deliberately the only command that can execute a model's code, and
 * it refuses to start if the sandbox is not ready. A worker that half-starts --
 * enrolls, advertises models, then fails every job -- looks to the researcher
 * like a broken product rather than an unconfigured machine.
 */
import { ADAPTER_VERSION, PINNED_AGENT_VERSION } from "./protocol.js";
import { ConfigError, defaultConfigPath, loadConfig } from "./config.js";
import type { WorkerConfig } from "./config.js";
import { StudioClient } from "./client.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { log, setLogLevel } from "./logging.js";
import type { LogLevel } from "./logging.js";
import { safeErrorMessage } from "./redact.js";
import { ContainerSandbox } from "./sandbox/container.js";
import { ProcessSandbox, ProcessSandboxRefused } from "./sandbox/process.js";
import type { JobSandbox } from "./sandbox/types.js";
import { readWorkerToken, writeWorkerToken } from "./token-store.js";
import { BridgeWorker, buildWorkerReport } from "./worker.js";

const USAGE = `Virtual Lab Studio bridge worker ${ADAPTER_VERSION}

  vls-worker enroll --token <enrollment-token>   Register this machine with the studio
  vls-worker doctor                              Check configuration, sandbox, models, connection
  vls-worker run                                 Poll for work and run it
  vls-worker version                             Print version information

Options:
  --config <path>     Configuration file (default: worker.config.json, or $VLS_WORKER_CONFIG)
  --log-level <level> debug | info | warn | error (default: info)
`;

interface Args {
  command: string;
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] ?? "";
  const flags = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, "true");
    }
  }
  return { command, flags };
}

function buildSandbox(config: WorkerConfig): JobSandbox {
  if (config.sandbox.kind === "process") {
    return new ProcessSandbox({
      allowUnsafe: config.sandbox.allowUnsafeProcessRunner,
      nodeEnv: process.env["NODE_ENV"],
    });
  }
  return new ContainerSandbox({
    engine: config.sandbox.engine,
    image: config.sandbox.image,
    network: config.sandbox.network,
    memory: config.sandbox.memory,
    cpus: config.sandbox.cpus,
    pidsLimit: config.sandbox.pidsLimit,
  });
}

async function commandEnroll(config: WorkerConfig, flags: Map<string, string>): Promise<number> {
  const token = flags.get("token") ?? process.env["VLS_ENROLLMENT_TOKEN"] ?? "";
  if (!token || token === "true") {
    process.stderr.write(
      "Provide the enrollment token from the studio: vls-worker enroll --token <token>\n" +
        "You can also set VLS_ENROLLMENT_TOKEN so the token stays out of your shell history.\n",
    );
    return 2;
  }
  const sandbox = buildSandbox(config);
  const client = new StudioClient({
    baseUrl: config.serverUrl,
    userAgent: `vls-bridge-worker/${ADAPTER_VERSION}`,
  });
  const result = await client.enroll({
    ...buildWorkerReport(config, sandbox),
    enrollment_token: token,
    display_name: config.displayName,
  });
  writeWorkerToken(config.workerTokenFile, result.worker_token);
  log.info("Enrolled with the studio", {
    workerId: result.worker_id,
    displayName: result.display_name,
  });
  process.stdout.write(
    `\nThis machine is now registered as "${result.display_name}".\n` +
      `Its credential is stored at ${config.workerTokenFile} and is readable only by you.\n` +
      `Next: vls-worker doctor\n`,
  );
  return 0;
}

async function commandDoctor(config: WorkerConfig): Promise<number> {
  let sandbox: JobSandbox;
  try {
    sandbox = buildSandbox(config);
  } catch (error) {
    if (error instanceof ProcessSandboxRefused) {
      process.stdout.write(`FAIL  Sandbox: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const results = await runDoctor(config, sandbox, readWorkerToken(config.workerTokenFile));
  process.stdout.write(`${formatDoctor(results)}\n`);
  return results.some((result) => result.state === "fail") ? 1 : 0;
}

async function commandRun(config: WorkerConfig): Promise<number> {
  const token = readWorkerToken(config.workerTokenFile);
  if (!token) {
    process.stderr.write(
      "This machine is not enrolled yet. Run: vls-worker enroll --token <enrollment token>\n",
    );
    return 2;
  }
  const sandbox = buildSandbox(config);
  const preflight = await sandbox.preflight();
  if (!preflight.ok) {
    process.stderr.write(`The sandbox is not ready: ${preflight.detail}\n`);
    return 1;
  }
  if (sandbox.mode === "process") {
    log.warn(
      "Running WITHOUT a sandbox. Model-generated code has your user account's permissions.",
    );
  }

  const client = new StudioClient({
    baseUrl: config.serverUrl,
    token,
    userAgent: `vls-bridge-worker/${ADAPTER_VERSION}`,
  });
  const worker = new BridgeWorker({ config, client, sandbox });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      // A second interrupt means the operator wants out now, even at the cost
      // of a job that will have to be retried.
      process.exit(130);
    }
    stopping = true;
    log.info(`Received ${signal}; finishing in-flight work before exiting.`);
    worker.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info("Waiting for work from the studio", {
    server: config.serverUrl,
    concurrency: config.concurrency,
    sandbox: sandbox.mode,
  });
  await worker.run();
  log.info("Stopped.");
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const level = args.flags.get("log-level");
  if (level && ["debug", "info", "warn", "error"].includes(level)) {
    setLogLevel(level as LogLevel);
  }

  if (args.command === "version" || args.flags.has("version")) {
    process.stdout.write(
      `vls-bridge-worker ${ADAPTER_VERSION}\n` +
        `Prime Agent (pinned): ${PINNED_AGENT_VERSION}\n` +
        `Node: ${process.version}\n`,
    );
    return 0;
  }
  if (!args.command || args.command === "help" || args.flags.has("help")) {
    process.stdout.write(USAGE);
    return args.command ? 0 : 2;
  }

  const configPath = args.flags.get("config") ?? defaultConfigPath();
  let config: WorkerConfig;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  switch (args.command) {
    case "enroll":
      return commandEnroll(config, args.flags);
    case "doctor":
      return commandDoctor(config);
    case "run":
      return commandRun(config);
    default:
      process.stderr.write(`Unknown command "${args.command}".\n\n${USAGE}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ProcessSandboxRefused) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${safeErrorMessage(error)}\n`);
    }
    process.exitCode = 1;
  });
