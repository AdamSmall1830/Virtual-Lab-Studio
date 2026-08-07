/**
 * The containerised runtime smoke test.
 *
 * This runs the real runner image: a real container with the real lockdown
 * flags, the real model proxy and relay, and the real Prime Agent SDK adapter
 * inside it. The only stand-in is the model itself -- a scripted
 * OpenAI-compatible server on the host, so the run is deterministic and needs
 * no GPU.
 *
 * That boundary is the point, and it is worth being precise about what this
 * does and does not prove. It proves the image builds with the pinned SDK, that
 * the adapter can configure that SDK and complete a session inside the
 * container, that only the reviewed tools reach the model, and that a result
 * comes back through the output mount. It does not prove anything about a real
 * model's judgement; that needs `smoke.real.test.ts` on a machine with one.
 *
 * Skipped unless the image exists and the operator asks for it:
 *
 *   docker build -f docker/Dockerfile -t vls-bridge-runner:0.1.0 .
 *   VLS_CONTAINER_SMOKE=1 npm test
 *
 * The skip message says what was not exercised, because a green suite that
 * quietly skipped the only test of the production runtime is how an untested
 * adapter ships.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { readBundle } from "../src/bundle.js";
import type { ModelConfig } from "../src/config.js";
import type { RunnerEvent } from "../src/runtime-events.js";
import { ContainerSandbox } from "../src/sandbox/container.js";
import { createJobWorkspace } from "../src/workspace.js";
import type { RunnerJobSpec } from "../src/workspace.js";
import { FakeModelServer } from "./helpers/fake-model.js";
import { buildFixtureBundle, makeLease } from "./helpers/fake-server.js";

const IMAGE = process.env["VLS_CONTAINER_SMOKE_IMAGE"] ?? "vls-bridge-runner:0.1.0";
const ENGINE = process.env["VLS_CONTAINER_SMOKE_ENGINE"] ?? "docker";
const MODEL_ID = "smoke-model";

/** The answer the scripted model gives, in the format the prompt asks for. */
const FINAL_ANSWER = [
  "The assay yield is reported as 42 percent under standard conditions.",
  "",
  "## Citations",
  "- E1 | p. 1 | The assay reported a 42 percent yield. | supports",
  "",
  "## Limitations",
  "- A single source; no replication was available.",
].join("\n");

function skipReason(): string | false {
  if (process.env["VLS_CONTAINER_SMOKE"] !== "1") {
    return (
      "VLS_CONTAINER_SMOKE is not set to 1. The containerised Prime Agent runtime was NOT " +
      "exercised by this run."
    );
  }
  try {
    execFileSync(ENGINE, ["image", "inspect", IMAGE], { stdio: "ignore" });
  } catch {
    return `The runner image ${IMAGE} is not built, so the containerised runtime was NOT exercised. Build it with: docker build -f docker/Dockerfile -t ${IMAGE} .`;
  }
  return false;
}

describe("containerised Prime Agent runtime", { skip: skipReason() }, () => {
  const upstream = new FakeModelServer(MODEL_ID);
  let workspaceRoot = "";

  before(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "vls-container-smoke-"));
    await upstream.start("0.0.0.0");
  });

  after(async () => {
    await upstream.stop();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("runs a real SDK session inside the container and returns a result", async () => {
    upstream.setScript(
      [
        { kind: "tool", tool: "vls_evidence_search", args: { query: "assay yield" } },
        { kind: "text", text: FINAL_ANSWER },
      ],
      { kind: "text", text: FINAL_ANSWER },
    );

    const fixture = buildFixtureBundle();
    const lease = makeLease({ request_sha256: fixture.requestSha });
    const bundle = readBundle(fixture.bytes, lease.job_id, fixture.requestSha);

    const model: ModelConfig = {
      modelKey: "local-test",
      displayName: "Scripted local model",
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      providerModelId: MODEL_ID,
      apiKeyEnv: null,
      contextWindow: 32_768,
      maxTokens: 2_048,
      supportsTools: true,
      pricing: { input_per_million_usd: 0, output_per_million_usd: 0 },
    };

    const spec: RunnerJobSpec = {
      schema_version: "1.0",
      job_id: lease.job_id,
      attempt: lease.attempt,
      request_sha256: fixture.requestSha,
      capability_profile: lease.capability_profile,
      model_key: model.modelKey,
      child_model_key: null,
      allowed_skill_ids: lease.allowed_skill_ids,
      limits: lease.limits,
      model_endpoint: {
        base_url: model.baseUrl,
        model_id: model.providerModelId,
        child_model_id: null,
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
      },
    };

    const workspace = createJobWorkspace(workspaceRoot, lease, bundle, spec);
    const sandbox = new ContainerSandbox({
      engine: ENGINE,
      image: IMAGE,
      network: "proxy",
      memory: "1g",
      cpus: "1",
      pidsLimit: 256,
    });

    const events: RunnerEvent[] = [];
    const diagnostics: string[] = [];
    const outcome = await sandbox.run({
      model,
      jobId: lease.job_id,
      workspace,
      maxRuntimeSeconds: 180,
      // Forced, not "auto": a smoke test that silently fell back to the CLI
      // runtime would report success without touching the code under test.
      env: { VLS_AGENT_RUNTIME: "sdk" },
      budget: { maxTokens: 32_000, maxCalls: 32, maxConcurrent: 4 },
      onEvent: (event) => events.push(event),
      onDiagnostic: (line) => diagnostics.push(line),
      signal: new AbortController().signal,
    });

    assert.equal(
      outcome.status,
      "completed",
      `container run did not complete: ${JSON.stringify(outcome)}\n${diagnostics.join("\n")}`,
    );

    const ready = events.find((event) => event.kind === "runner.ready");
    assert.ok(ready, "the runner never announced itself");
    assert.equal(
      (ready as { adapter: string }).adapter,
      "sdk",
      "the container did not run the Prime Agent SDK adapter",
    );

    const result = JSON.parse(readFileSync(workspace.resultPath, "utf8")) as Record<string, unknown>;
    assert.equal(result["failure"], null, `the runner reported a failure: ${String(result["failure"])}`);
    assert.equal(result["is_simulation"], false);
    assert.equal(result["runtime_adapter"], "sdk");
    assert.match(String(result["final_text"]), /42 percent/);
    assert.deepEqual(
      (result["citations"] as Array<Record<string, unknown>>).map((c) => c["evidence_key"]),
      ["E1"],
    );

    // What the model was actually offered, read off the wire rather than
    // asserted from the adapter's own source.
    const first = upstream.requests[0]!.body as Record<string, any>;
    const toolNames = ((first["tools"] ?? []) as Array<Record<string, any>>)
      .map((tool) => String(tool["function"]?.["name"] ?? tool["name"]))
      .sort();
    assert.ok(toolNames.includes("vls_python"), "the participant lost its Python tool");
    for (const forbidden of ["bash", "read", "write", "edit", "grep", "web_search"]) {
      assert.ok(!toolNames.includes(forbidden), `${forbidden} was offered inside the container`);
    }

    // The proxy metered the same traffic the runner reported.
    assert.ok((outcome.usage?.model_call_count ?? 0) >= 2, "the proxy did not meter the model calls");
  });
});
