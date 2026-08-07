/**
 * The container sandbox.
 *
 * This is the actual security boundary of the bridge worker. Everything else --
 * the narrow tool set, the read-only skill, the instructions in the brief -- is
 * defence in depth around this. Prime Agent's Python tool executes
 * model-generated code, and the frozen evidence it reads is untrusted text that
 * a third party may have authored, so the operating assumption is that
 * arbitrary code will run inside this container and that it may be hostile.
 *
 * The flags below are chosen against that assumption:
 *
 * ``--user`` a fixed non-root uid, plus ``--security-opt no-new-privileges``,
 *   so a setuid binary inside the image cannot be used to climb back to root.
 * ``--cap-drop ALL`` because nothing here needs a capability; the agent writes
 *   files and makes one HTTP call.
 * ``--read-only`` with tmpfs for ``/tmp`` and the agent's home, so a break-in
 *   cannot persist anything into the image layer, and ``--tmpfs`` carries
 *   ``noexec`` where the runtime allows it.
 * ``--network`` a per-job *internal* network with no route off the host. The
 *   model is reached only through a sidecar proxy on that network. There is
 *   deliberately no mode that attaches the job container to the default bridge:
 *   that would give model-generated code the operator's LAN, their router's
 *   admin page, and on a cloud box the instance metadata endpoint.
 * ``--memory``/``--cpus``/``--pids-limit`` so a runaway loop degrades into a
 *   failed job rather than an unusable machine.
 * No bind mount of the host home, no docker socket, no ``--privileged``. The
 *   only mounts are this attempt's input (read-only) and output directories.
 *
 * The wall-clock limit is enforced twice: ``--stop-timeout`` plus a host timer
 * that kills the container. A sandbox that could outlive its own limit would
 * make the studio's runtime cap advisory.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { log } from "../logging.js";
import { safeErrorMessage } from "../redact.js";
import type { ModelConfig } from "../config.js";
import { modelApiKey } from "../config.js";
import { startModelProxy } from "./model-proxy.js";
import type { ModelProxyHandle } from "./model-proxy.js";
import { collectChild } from "./process.js";
import type { JobSandbox, SandboxOutcome, SandboxRunOptions } from "./types.js";

export interface ContainerSandboxOptions {
  engine: string;
  image: string;
  network: "proxy" | "none";
  memory: string;
  cpus: string;
  pidsLimit: number;
}

/** Fixed, unprivileged, and matching the image's own user. */
const CONTAINER_UID = "10001:10001";
const CONTAINER_INPUT = "/job/input";
const CONTAINER_OUTPUT = "/job/output";

function run(
  engine: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(engine, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: safeErrorMessage(error) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export class ContainerSandbox implements JobSandbox {
  readonly mode = "docker" as const;

  constructor(private readonly options: ContainerSandboxOptions) {}

  async preflight(): Promise<{ ok: boolean; detail: string }> {
    const version = await run(this.options.engine, ["version", "--format", "{{.Server.Version}}"]);
    if (version.code !== 0) {
      return {
        ok: false,
        detail: `${this.options.engine} is not running or not on PATH. Start it, then run the doctor again.`,
      };
    }
    const image = await run(this.options.engine, ["image", "inspect", this.options.image]);
    if (image.code !== 0) {
      return {
        ok: false,
        detail: `The runner image ${this.options.image} is not built. Build it from docker/Dockerfile first.`,
      };
    }
    return { ok: true, detail: `${this.options.engine} ${version.stdout} with image ${this.options.image}.` };
  }

  /**
   * Create the isolated network for one job, if it does not already exist.
   *
   * ``--internal`` is what removes the default route; containers on this
   * network can reach each other and nothing else.
   */
  private async ensureNetwork(name: string): Promise<void> {
    const existing = await run(this.options.engine, ["network", "inspect", name]);
    if (existing.code === 0) return;
    const created = await run(this.options.engine, [
      "network",
      "create",
      "--internal",
      "--driver",
      "bridge",
      name,
    ]);
    if (created.code !== 0 && !created.stderr.includes("already exists")) {
      throw new Error(`Could not create the isolated job network: ${created.stderr}`);
    }
  }

  /**
   * The relay's outward-facing network.
   *
   * A per-job bridge rather than the engine's shared default one. The relay has
   * to be routable -- on Docker Desktop the host is only reachable that way --
   * but it has no business sitting on a network alongside whatever else the
   * operator happens to be running.
   */
  private async ensureRelayNetwork(name: string): Promise<void> {
    const existing = await run(this.options.engine, ["network", "inspect", name]);
    if (existing.code === 0) return;
    const created = await run(this.options.engine, [
      "network",
      "create",
      "--driver",
      "bridge",
      name,
    ]);
    if (created.code !== 0 && !created.stderr.includes("already exists")) {
      throw new Error(`Could not create the relay network: ${created.stderr}`);
    }
  }

  private async removeNetwork(name: string): Promise<void> {
    await run(this.options.engine, ["network", "rm", name]).catch(() => undefined);
  }

  async run(options: SandboxRunOptions): Promise<SandboxOutcome> {
    const short = randomBytes(5).toString("hex");
    const networkName = `vls-job-${short}`;
    const relayNetwork = `vls-out-${short}`;
    const containerName = `vls-run-${short}`;
    const proxyContainer = `vls-proxy-${short}`;
    const jobToken = randomBytes(32).toString("hex");

    let proxy: ModelProxyHandle | null = null;
    let networkCreated = false;
    let relayNetworkCreated = false;

    try {
      const args: string[] = [
        "run",
        "--rm",
        "--name",
        containerName,
        "--user",
        CONTAINER_UID,
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=512m",
        "--tmpfs",
        "/home/agent:rw,nosuid,size=256m",
        "--memory",
        this.options.memory,
        "--memory-swap",
        this.options.memory,
        "--cpus",
        this.options.cpus,
        "--pids-limit",
        String(this.options.pidsLimit),
        "--stop-timeout",
        "10",
        "-v",
        `${options.workspace.inputDir}:${CONTAINER_INPUT}:ro`,
        "-v",
        `${options.workspace.outputDir}:${CONTAINER_OUTPUT}:rw`,
        "-e",
        `VLS_INPUT_DIR=${CONTAINER_INPUT}`,
        "-e",
        `VLS_OUTPUT_DIR=${CONTAINER_OUTPUT}`,
        "-e",
        "VLS_SANDBOX_MODE=docker",
        "-e",
        "HOME=/home/agent",
        "-e",
        "TMPDIR=/tmp",
        // The agent must not phone home to its vendor, look for updates, or
        // load anything from the network at start-up.
        "-e",
        "PI_OFFLINE=1",
        "-e",
        "NO_COLOR=1",
      ];

      if (this.options.network === "proxy") {
        // The job's own model, decided when the lease was accepted. Never a
        // default: a worker advertising several models would otherwise run
        // every job against the first one it happens to have configured.
        const model = options.model;
        await this.ensureNetwork(networkName);
        networkCreated = true;

        // Bound to all interfaces because the sidecar reaches it over the
        // host gateway; the listener is short-lived, requires the job token,
        // and forwards only the allow-listed endpoints.
        proxy = await startModelProxy({
          target: { baseUrl: model.baseUrl, apiKey: modelApiKey(model) },
          jobToken,
          host: "0.0.0.0",
          // The model's own per-response ceiling is the honest size of one
          // call, so the proxy clamps to it rather than to a guess.
          ...(options.budget
            ? { budget: { ...options.budget, maxOutputPerCall: model.maxTokens } }
            : {}),
          onBudgetExceeded: (reason) => {
            // Refusing further calls would leave the agent spinning on 429s
            // until its wall clock ran out, burning the operator's GPU for a
            // job that can no longer be accepted.
            log.warn("The job spent its model allowance; stopping the container", {
              jobId: options.jobId,
              reason,
            });
            void run(this.options.engine, ["kill", containerName], 15_000).catch(() => undefined);
          },
        });

        // A one-line TCP forwarder inside the isolated network. It is the only
        // container attached to both networks, so it is the single, auditable
        // hole -- and it still cannot see the provider key, which is applied
        // on the host side of the proxy. It gets the same lockdown as the job
        // container, because "it is only a forwarder" is exactly the reasoning
        // that leaves a routable container running as root.
        const relay = await run(this.options.engine, [
          "run",
          "-d",
          "--rm",
          "--name",
          proxyContainer,
          "--user",
          CONTAINER_UID,
          "--security-opt",
          "no-new-privileges",
          "--cap-drop",
          "ALL",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=8m",
          "--memory",
          "256m",
          "--memory-swap",
          "256m",
          "--cpus",
          "0.5",
          "--pids-limit",
          "32",
          "--network",
          networkName,
          "--add-host",
          "host.docker.internal:host-gateway",
          "--entrypoint",
          "node",
          this.options.image,
          "/app/dist/runner/relay.js",
          `host.docker.internal:${proxy.port}`,
        ]);
        if (relay.code !== 0) {
          return {
            status: "failed",
            reason: `Could not start the model relay: ${relay.stderr}`,
          };
        }
        // Give the relay a route to the host, on a network of its own. The
        // engine's shared default bridge would work too and is what this used
        // to do, but it would also put the one routable container in the system
        // next to every other container on the machine.
        await this.ensureRelayNetwork(relayNetwork);
        relayNetworkCreated = true;
        const attached = await run(this.options.engine, [
          "network",
          "connect",
          relayNetwork,
          proxyContainer,
        ]);
        if (attached.code !== 0) {
          return {
            status: "failed",
            reason: `Could not give the model relay a route to the host: ${attached.stderr}`,
          };
        }

        args.push("--network", networkName);
        args.push("-e", `VLS_MODEL_BASE_URL=http://${proxyContainer}:8900/v1`);
        args.push("-e", `VLS_MODEL_TOKEN=${jobToken}`);
      } else {
        // Fully offline: used by the fake runtime and by any job that must not
        // touch a model at all.
        args.push("--network", "none");
      }

      for (const [key, value] of Object.entries(options.env)) {
        args.push("-e", `${key}=${value}`);
      }
      args.push(this.options.image);

      const child = spawn(this.options.engine, args, { stdio: ["ignore", "pipe", "pipe"] });
      const outcome = await collectChild(child, options);

      if (outcome.status === "timeout" || outcome.status === "cancelled") {
        // Killing the client does not kill the container; the engine must be
        // told, or the job keeps burning the operator's GPU after the studio
        // has already moved on.
        await run(this.options.engine, ["kill", containerName], 15_000).catch(() => undefined);
      }
      // What the proxy saw travels with the outcome. It is the only account of
      // the job's consumption that did not come from inside the sandbox.
      return {
        ...outcome,
        ...(proxy ? { usage: proxy.usage() } : {}),
        ...(proxy?.budgetExceeded() ? { budgetExceeded: proxy.budgetExceeded() as "tokens" | "calls" } : {}),
      };
    } catch (error) {
      return { status: "failed", reason: safeErrorMessage(error) };
    } finally {
      await run(this.options.engine, ["rm", "-f", proxyContainer], 15_000).catch(() => undefined);
      if (proxy) await proxy.close().catch(() => undefined);
      if (networkCreated) await this.removeNetwork(networkName);
      if (relayNetworkCreated) await this.removeNetwork(relayNetwork);
      log.debug("Container sandbox cleaned up", { jobId: options.jobId });
    }
  }
}
