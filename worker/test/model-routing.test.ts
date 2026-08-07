/**
 * A worker that offers several models must run each job on the one it was
 * leased for.
 *
 * This is a quiet failure if it is wrong. A job leased for the 70B runs
 * against the 8B endpoint, the 8B answers it, and every downstream record --
 * the run's model_key, the cost, the comparison a researcher is drawing
 * conclusions from -- attributes that answer to a model that never saw the
 * question. Nothing errors, and the second model's credential has meanwhile
 * been sent to the first model's server.
 *
 * So the test configures two model endpoints with two different credentials,
 * leases a job for the second one, and follows the model call all the way to
 * the wire: the sandbox is given the leased model, the runner's spec names the
 * same endpoint, the call arrives at that endpoint with that endpoint's key,
 * and the other server is never contacted at all.
 *
 * The proxy is the real one; only the container around it is stood in for,
 * since a Docker build is not available in every environment this runs in.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, it } from "node:test";

import { StudioClient } from "../src/client.js";
import { modelApiKey, parseConfig } from "../src/config.js";
import { startModelProxy } from "../src/sandbox/model-proxy.js";
import type { JobSandbox, SandboxOutcome, SandboxRunOptions } from "../src/sandbox/types.js";
import { BridgeWorker } from "../src/worker.js";
import { FakeModelServer } from "./helpers/fake-model.js";
import { FakeStudio, buildFixtureBundle, makeLease } from "./helpers/fake-server.js";

const KEY_ENV_A = "VLS_TEST_KEY_MODEL_A";
const KEY_ENV_B = "VLS_TEST_KEY_MODEL_B";
const KEY_A = "key-for-model-a";
const KEY_B = "key-for-model-b";

/**
 * Stands in for the container, doing the one thing this test is about: it
 * builds the model proxy the same way ContainerSandbox does -- from the model
 * the caller handed it -- and makes a single call through it, as the runner
 * would from inside the container.
 */
class ProxyingSandbox implements JobSandbox {
  readonly mode = "docker" as const;
  seenModelKey: string | null = null;
  specBaseUrl: string | null = null;

  async preflight(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "proxying stand-in" };
  }

  async run(options: SandboxRunOptions): Promise<SandboxOutcome> {
    this.seenModelKey = options.model.modelKey;
    const spec = JSON.parse(
      readFileSync(join(options.workspace.inputDir, "job.json"), "utf8"),
    ) as { model_endpoint: { base_url: string; model_id: string } };
    this.specBaseUrl = spec.model_endpoint.base_url;

    const jobToken = randomUUID();
    const proxy = await startModelProxy({
      target: { baseUrl: options.model.baseUrl, apiKey: modelApiKey(options.model) },
      jobToken,
      host: "127.0.0.1",
    });
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jobToken}` },
        body: JSON.stringify({
          model: spec.model_endpoint.model_id,
          stream: true,
          messages: [{ role: "user", content: "Which endpoint answered?" }],
        }),
      });
      await response.text();
    } finally {
      await proxy.close();
    }

    options.onEvent({
      kind: "node.started",
      node_id: "coordinator",
      parent_node_id: null,
      display_name: "Participant",
      depth: 0,
    });
    options.onEvent({
      kind: "node.completed",
      node_id: "coordinator",
      result_summary: "Answered.",
    });
    writeFileSync(
      options.workspace.resultPath,
      JSON.stringify({
        request_sha256: this.requestSha,
        final_text: "The assay reported a 42% yield.",
        citations: [
          { evidence_key: "E1", locator: "p. 1", quote: "42 percent yield", support: "supports" },
        ],
        is_simulation: false,
        adapter: "test",
      }),
      "utf8",
    );
    return { status: "completed", exitCode: 0 };
  }

  constructor(private readonly requestSha: string) {}
}

describe("a worker with more than one model", () => {
  const serverA = new FakeModelServer("model-a-id");
  const serverB = new FakeModelServer("model-b-id");
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "vls-routing-test-"));
    process.env[KEY_ENV_A] = KEY_A;
    process.env[KEY_ENV_B] = KEY_B;
    await serverA.start();
    await serverB.start();
    serverA.setScript([{ kind: "text", text: "A answered." }]);
    serverB.setScript([{ kind: "text", text: "B answered." }]);
  });

  afterEach(async () => {
    await serverA.stop();
    await serverB.stop();
    delete process.env[KEY_ENV_A];
    delete process.env[KEY_ENV_B];
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("runs a job on the model it was leased for, not the first one configured", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      // Leased for the *second* model, so a worker that defaults to the first
      // configured model fails this test rather than passing by coincidence.
      queue: [makeLease({ request_sha256: fixture.requestSha, model_key: "model-b" })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });

    const config = parseConfig(
      {
        serverUrl: "https://studio.example.com",
        displayName: "Two model worker",
        workspaceRoot,
        workerTokenFile: join(workspaceRoot, "token"),
        models: [
          {
            modelKey: "model-a",
            displayName: "Model A",
            baseUrl: serverA.baseUrl,
            providerModelId: "model-a-id",
            apiKeyEnv: KEY_ENV_A,
            contextWindow: 32_768,
            maxTokens: 2_048,
            pricing: { input_per_million_usd: 0, output_per_million_usd: 0 },
          },
          {
            modelKey: "model-b",
            displayName: "Model B",
            baseUrl: serverB.baseUrl,
            providerModelId: "model-b-id",
            apiKeyEnv: KEY_ENV_B,
            contextWindow: 32_768,
            maxTokens: 2_048,
            pricing: { input_per_million_usd: 0, output_per_million_usd: 0 },
          },
        ],
      },
      join(workspaceRoot, "worker.config.json"),
    );

    const sandbox = new ProxyingSandbox(fixture.requestSha);
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });

    const running = worker.run();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (
        studio.completions.length + studio.failures.length + studio.releases.length > 0 &&
        worker.activeCount === 0
      ) {
        break;
      }
      await sleep(20);
    }
    worker.stop();
    await running;

    assert.equal(studio.completions.length, 1, "the job did not complete");
    assert.equal(sandbox.seenModelKey, "model-b", "the sandbox was handed the wrong model");
    assert.equal(sandbox.specBaseUrl, serverB.baseUrl, "the runner's spec named the wrong endpoint");

    assert.equal(serverB.requests.length, 1, "the leased model's endpoint was not called");
    assert.equal(serverA.requests.length, 0, "the other model's endpoint was called");
    assert.equal(serverB.requests[0]!.authorization, `Bearer ${KEY_B}`);
    assert.ok(
      !JSON.stringify(serverB.requests[0]).includes(KEY_A),
      "the other model's credential was sent to this endpoint",
    );
  });
});
