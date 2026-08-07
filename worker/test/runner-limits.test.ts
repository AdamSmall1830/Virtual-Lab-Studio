/**
 * What happens to a participant that runs out of turns, from the wire in.
 *
 * This is the one path where a bug is invisible and expensive: a model that
 * loops produces text that reads like an answer, and if the runner hands that
 * text back as a result, the studio has no way to know it was an interrupted
 * train of thought. It would be filed as a finished research contribution,
 * with citations, in a record a researcher is meant to be able to trust.
 *
 * So this test runs the real runner process with the real SDK against a model
 * that writes a confident half-sentence and then loops forever, and asserts the
 * whole chain refuses it: the runner reports a bounded failure and no answer,
 * and the studio is told the job failed rather than being handed a completion.
 *
 * The agent runtime is pinned to ``sdk`` rather than ``auto`` so a missing
 * dependency fails the test instead of quietly running a simulation.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { StudioClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { collectChild } from "../src/sandbox/process.js";
import { SdkRuntime } from "../src/runner/runtime/sdk.js";
import type { JobSandbox, SandboxOutcome, SandboxRunOptions } from "../src/sandbox/types.js";
import { BridgeWorker } from "../src/worker.js";
import { FakeModelServer } from "./helpers/fake-model.js";
import { FakeStudio, buildFixtureBundle, makeLease } from "./helpers/fake-server.js";

const here = dirname(fileURLToPath(import.meta.url));
/** dist-test/test -> dist-test/src/runner/entrypoint.js */
const ENTRYPOINT = join(here, "..", "src", "runner", "entrypoint.js");
const MODEL_ID = "looping-model";
const TOKEN = "job-token-for-the-runner";

/**
 * The dev-only process runner, minus the safety refusals: the same spawn a
 * container does, so the runner under test is the shipped one.
 */
class SpawnSandbox implements JobSandbox {
  readonly mode = "process" as const;

  async preflight(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "test spawn" };
  }

  async run(options: SandboxRunOptions): Promise<SandboxOutcome> {
    const child = spawn(process.execPath, [ENTRYPOINT], {
      cwd: options.workspace.root,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: options.workspace.root,
        TMPDIR: options.workspace.root,
        NODE_ENV: "development",
        ...options.env,
        VLS_INPUT_DIR: options.workspace.inputDir,
        VLS_OUTPUT_DIR: options.workspace.outputDir,
        VLS_MODEL_TOKEN: TOKEN,
        VLS_AGENT_RUNTIME: "sdk",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return collectChild(child, options);
  }
}

const sdkPresent = await SdkRuntime.probe();

describe(
  "a participant that runs out of turns",
  {
    skip: sdkPresent
      ? false
      : "The Prime Agent SDK is not installed, so the real runner process was NOT exercised by this run.",
  },
  () => {
    const upstream = new FakeModelServer(MODEL_ID);
    let workspaceRoot = "";

    before(async () => {
      await upstream.start();
    });

    after(async () => {
      await upstream.stop();
    });

    beforeEach(() => {
      workspaceRoot = mkdtempSync(join(tmpdir(), "vls-limit-test-"));
    });

    afterEach(() => {
      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it("is reported as a failure, not published as an answer", async () => {
      // Answer-shaped prose on every turn, and a tool call so the turn never
      // ends the run. Only the turn ceiling stops this.
      upstream.setScript([], {
        kind: "both",
        text: [
          "The assay reported a 42 percent yield under standard conditions, so",
          "",
          "## Citations",
          "- E1 | p. 1 | The assay reported a 42 percent yield. | supports",
        ].join("\n"),
        tool: "vls_python",
        args: { code: "print(1)" },
      });

      const fixture = buildFixtureBundle();
      const studio = new FakeStudio({
        queue: [
          makeLease({
            request_sha256: fixture.requestSha,
            limits: {
              max_children: 0,
              max_depth: 0,
              max_agent_turns: 2,
              max_tokens: 32_000,
              max_runtime_seconds: 120,
              max_cost_usd: 2,
            },
          }),
        ],
        bundles: new Map([[fixture.jobId, fixture.bytes]]),
      });

      const config = parseConfig(
        {
          serverUrl: "https://studio.example.com",
          displayName: "Limit test worker",
          workspaceRoot,
          workerTokenFile: join(workspaceRoot, "token"),
          models: [
            {
              modelKey: "local-test",
              displayName: "Looping local model",
              baseUrl: upstream.baseUrl,
              providerModelId: MODEL_ID,
              contextWindow: 32_768,
              maxTokens: 2_048,
              pricing: { input_per_million_usd: 0, output_per_million_usd: 0 },
            },
          ],
        },
        join(workspaceRoot, "worker.config.json"),
      );

      const worker = new BridgeWorker({
        config,
        client: new StudioClient({
          baseUrl: config.serverUrl,
          token: "vlsw_test",
          userAgent: "test",
          fetchImpl: studio.fetch,
        }),
        sandbox: new SpawnSandbox(),
      });

      const running = worker.run();
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (
          studio.completions.length + studio.failures.length + studio.releases.length > 0 &&
          worker.activeCount === 0
        ) {
          break;
        }
        await sleep(50);
      }
      worker.stop();
      await running;

      assert.equal(
        studio.completions.length,
        0,
        `a bounded-out run was submitted as a completed answer: ${JSON.stringify(studio.completions)}`,
      );
      assert.equal(studio.failures.length, 1, "the studio was not told the job failed");
      const failure = studio.failures[0] as unknown as Record<string, unknown>;
      assert.match(String(failure["safe_message"] ?? failure["message"] ?? ""), /turn limit/i);

      // The progress the studio saw agrees: the participant is reported as
      // stopped at a bound, and never as having finished.
      const posted = studio.events.flatMap((batch) => batch.events) as unknown as Array<
        Record<string, unknown>
      >;
      const failed = posted.filter((event) => event["type"] === "recursive.agent.failed");
      assert.equal(failed.length, 1, `expected one failed node, saw ${JSON.stringify(posted)}`);
      const payload = failed[0]!["payload"] as Record<string, unknown>;
      assert.equal(payload["failure_category"], "limit_exceeded");
      assert.match(String(payload["failure_safe_message"]), /turn limit/i);
      assert.equal(
        posted.filter((event) => event["type"] === "recursive.agent.completed").length,
        0,
        "a node that was cut off was reported as completed",
      );

      // The model really did keep going until it was stopped, rather than the
      // run ending for some other reason that happens to look the same.
      assert.ok(
        upstream.requests.length >= 2,
        `expected the participant to loop, saw ${upstream.requests.length} model calls`,
      );
    });
  },
);
