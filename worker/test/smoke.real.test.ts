/**
 * The opt-in real-bridge smoke test.
 *
 * Everything else in this suite runs against fakes. This one runs the real
 * thing: a real container, real Prime Agent, a real local model, and a real
 * Virtual Lab Studio. It is the only test that can prove recursion actually
 * works, and it can only run on a machine that has all four.
 *
 * It is skipped by default -- and the skip message says exactly what is
 * missing. That wording matters more than it looks. A skipped test that reports
 * as a pass is how "recursive agents work" ends up in a release note when
 * nobody has ever seen one run. Anyone reading this suite's output should be
 * able to tell, without opening the file, whether real recursion was exercised
 * or not.
 *
 * To run it:
 *
 *   VLS_SMOKE=1 \
 *   VLS_SMOKE_SERVER=https://your-studio.example.com \
 *   VLS_SMOKE_TOKEN=<worker token> \
 *   VLS_SMOKE_MODEL_URL=http://127.0.0.1:11434/v1 \
 *   VLS_SMOKE_MODEL_ID=qwen3:32b \
 *   npm test
 *
 * It then waits for the studio to hand it a real job, so a researcher has to
 * launch a meeting with a recursive participant while it is running.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";

import { StudioClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { ContainerSandbox } from "../src/sandbox/container.js";
import { BridgeWorker } from "../src/worker.js";

interface SmokeEnv {
  server: string;
  token: string;
  modelUrl: string;
  modelId: string;
  image: string;
  waitSeconds: number;
}

/** Returns the environment, or a sentence naming precisely what is absent. */
function readSmokeEnv(): SmokeEnv | { missing: string } {
  if (process.env["VLS_SMOKE"] !== "1") {
    return {
      missing:
        "VLS_SMOKE is not set to 1. Real recursion was NOT exercised by this run; " +
        "only the fake-server tests ran.",
    };
  }
  const required = {
    VLS_SMOKE_SERVER: process.env["VLS_SMOKE_SERVER"],
    VLS_SMOKE_TOKEN: process.env["VLS_SMOKE_TOKEN"],
    VLS_SMOKE_MODEL_URL: process.env["VLS_SMOKE_MODEL_URL"],
    VLS_SMOKE_MODEL_ID: process.env["VLS_SMOKE_MODEL_ID"],
  };
  const absent = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (absent.length > 0) {
    return {
      missing: `VLS_SMOKE=1 but ${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} not set. Real recursion was NOT exercised.`,
    };
  }
  return {
    server: required.VLS_SMOKE_SERVER as string,
    token: required.VLS_SMOKE_TOKEN as string,
    modelUrl: required.VLS_SMOKE_MODEL_URL as string,
    modelId: required.VLS_SMOKE_MODEL_ID as string,
    image: process.env["VLS_SMOKE_IMAGE"] ?? "vls-bridge-runner:0.1.0",
    waitSeconds: Number.parseInt(process.env["VLS_SMOKE_WAIT"] ?? "900", 10),
  };
}

describe("real bridge smoke test", () => {
  const env = readSmokeEnv();

  if ("missing" in env) {
    it("runs a real recursive job end to end", { skip: env.missing }, () => {
      // Deliberately unreachable. The skip reason above is the whole point.
    });
    return;
  }

  it(
    "runs a real recursive job end to end",
    { timeout: (env.waitSeconds + 120) * 1_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vls-smoke-"));
      try {
        const config = parseConfig(
          {
            serverUrl: env.server,
            displayName: "Smoke test worker",
            concurrency: 1,
            workspaceRoot: join(root, "jobs"),
            workerTokenFile: join(root, "token"),
            sandbox: { kind: "container", image: env.image, network: "proxy" },
            models: [
              {
                modelKey: env.modelId,
                displayName: env.modelId,
                baseUrl: env.modelUrl,
                providerModelId: env.modelId,
                contextWindow: 32_768,
                maxTokens: 8_192,
                pricing: { input_per_million_usd: 0, output_per_million_usd: 0 },
              },
            ],
          },
          join(root, "worker.config.json"),
        );

        const sandbox = new ContainerSandbox({
          engine: config.sandbox.engine,
          image: config.sandbox.image,
          network: config.sandbox.network,
          memory: config.sandbox.memory,
          cpus: config.sandbox.cpus,
          pidsLimit: config.sandbox.pidsLimit,
        });
        const preflight = await sandbox.preflight();
        assert.ok(preflight.ok, `the container sandbox is not ready: ${preflight.detail}`);

        const client = new StudioClient({
          baseUrl: config.serverUrl,
          token: env.token,
          userAgent: "vls-bridge-worker/smoke",
        });
        const worker = new BridgeWorker({ config, client, sandbox });

        process.stdout.write(
          `\nWaiting up to ${env.waitSeconds}s for a real job. Launch a meeting with a ` +
            `recursive participant in the studio now.\n`,
        );

        const running = worker.run();
        const deadline = Date.now() + env.waitSeconds * 1_000;
        let sawJob = false;
        while (Date.now() < deadline) {
          if (worker.activeCount > 0) sawJob = true;
          if (sawJob && worker.activeCount === 0) break;
          await sleep(1_000);
        }
        worker.stop();
        await running;

        assert.ok(
          sawJob,
          "No job arrived within the wait window, so real recursion was not exercised. " +
            "This is not a pass: launch a meeting with a recursive participant and run it again.",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
