import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EventNormalizer } from "../src/events.js";
import type { EvidenceManifest, JobLimits } from "../src/protocol.js";
import { ResultRejected, buildCompletion } from "../src/result.js";
import type { ExtractionContext } from "../src/result.js";

const LIMITS: JobLimits = {
  max_children: 2,
  max_depth: 1,
  max_agent_turns: 8,
  max_tokens: 32_000,
  max_runtime_seconds: 120,
  max_cost_usd: 2,
};

const MANIFEST: EvidenceManifest = {
  schema_version: "1.0",
  job_id: "job-1",
  request_sha256: "a".repeat(64),
  meeting_definition_sha256: "0".repeat(64),
  evidence: [
    {
      evidence_key: "E1",
      file: "evidence/source-0.txt",
      title: "Source",
      citation: "Source (2026)",
      content_sha256: null,
      chunk_count: 1,
      truncated: false,
      trust: "untrusted_data",
    },
  ],
};

function context(overrides: Partial<ExtractionContext> = {}): ExtractionContext {
  const normalizer = new EventNormalizer({ jobId: "job-1", limits: LIMITS });
  normalizer.ingest({
    kind: "node.started",
    node_id: "coordinator",
    parent_node_id: null,
    display_name: "Participant",
    depth: 0,
  });
  return {
    requestSha256: "a".repeat(64),
    limits: LIMITS,
    manifest: MANIFEST,
    ledger: normalizer.ledger,
    usage: {
      model_call_count: 2,
      input_tokens: 500,
      output_tokens: 200,
      cost_usd: 0,
      pricing_complete: true,
    },
    nodeUsage: new Map(),
    runtime: {
      adapter_version: "0.1.0",
      prime_agent_version: "0.84.0",
      model_key: "local-test",
      child_model_key: null,
      elapsed_ms: 1_000,
      is_simulation: false,
      session_reference_hash: "b".repeat(64),
    },
    ...overrides,
  };
}

const GOOD_RESULT = {
  request_sha256: "a".repeat(64),
  final_text: "The assay reported a 42% yield.",
  citations: [
    { evidence_key: "E1", locator: "p. 1", claim: "42% yield", support_type: "supports" },
  ],
  limitations: ["Only one source was attached."],
  nodes: [
    {
      external_node_id: "coordinator",
      display_name: "Participant",
      status: "completed",
      result_summary: "Summarised the assay.",
      cited_evidence_keys: ["E1"],
      tool_labels: ["Frozen evidence search"],
    },
  ],
};

describe("result validation", () => {
  it("accepts a well-formed result", () => {
    const completion = buildCompletion(GOOD_RESULT, context());
    assert.equal(completion.final_text, "The assay reported a 42% yield.");
    assert.equal(completion.citations.length, 1);
    assert.equal(completion.nodes.length, 1);
    assert.equal(completion.limitations[0], "Only one source was attached.");
  });

  it("fails the turn when a citation cannot be resolved", () => {
    // The alternative -- dropping the citation -- would leave the claim in the
    // final text with its support silently removed.
    const result = {
      ...GOOD_RESULT,
      citations: [
        ...GOOD_RESULT.citations,
        { evidence_key: "E9", locator: null, claim: "invented", support_type: "supports" },
      ],
    };
    assert.throws(
      () => buildCompletion(result, context()),
      (error: unknown) =>
        error instanceof ResultRejected &&
        error.failureCode === "invalid_result" &&
        /not\s+attached/.test(error.message),
    );
  });

  it("refuses a result that does not echo this turn's request hash", () => {
    const result = { ...GOOD_RESULT, request_sha256: "c".repeat(64) };
    assert.throws(
      () => buildCompletion(result, context()),
      (error: unknown) => error instanceof ResultRejected && error.retryable === false,
    );
  });

  it("refuses an empty response", () => {
    assert.throws(
      () => buildCompletion({ ...GOOD_RESULT, final_text: "   " }, context()),
      /no response text/,
    );
  });

  it("refuses a result that duplicates a node identifier", () => {
    const result = {
      ...GOOD_RESULT,
      nodes: [GOOD_RESULT.nodes[0], GOOD_RESULT.nodes[0]],
    };
    assert.throws(() => buildCompletion(result, context()), /same agent twice/);
  });

  it("drops nodes the event stream never announced", () => {
    const result = {
      ...GOOD_RESULT,
      nodes: [
        ...GOOD_RESULT.nodes,
        { external_node_id: "smuggled", display_name: "Ghost", status: "completed" },
      ],
    };
    const completion = buildCompletion(result, context());
    assert.deepEqual(
      completion.nodes.map((node) => node.external_node_id),
      ["coordinator"],
    );
  });

  it("refuses a result when the ledger recorded a bounds breach", () => {
    const normalizer = new EventNormalizer({ jobId: "job-1", limits: LIMITS });
    normalizer.ingest({
      kind: "node.started",
      node_id: "coordinator",
      parent_node_id: null,
      display_name: "Participant",
      depth: 0,
    });
    for (const id of ["a", "b", "c"]) {
      normalizer.ingest({
        kind: "node.started",
        node_id: id,
        parent_node_id: "coordinator",
        display_name: id,
        depth: 1,
      });
    }
    assert.throws(
      () => buildCompletion(GOOD_RESULT, context({ ledger: normalizer.ledger })),
      (error: unknown) => error instanceof ResultRejected && error.failureCode === "limit_exceeded",
    );
  });

  it("refuses a turn that spent more tokens than the meeting allows", () => {
    assert.throws(
      () =>
        buildCompletion(
          GOOD_RESULT,
          context({
            usage: {
              model_call_count: 5,
              input_tokens: 30_000,
              output_tokens: 30_000,
              cost_usd: 0,
              pricing_complete: true,
            },
          }),
        ),
      (error: unknown) =>
        error instanceof ResultRejected &&
        error.failureCode === "limit_exceeded" &&
        error.retryable === false,
    );
  });

  it("carries the simulation flag through untouched", () => {
    const completion = buildCompletion(
      GOOD_RESULT,
      context({
        runtime: { ...context().runtime, is_simulation: true },
      }),
    );
    assert.equal(completion.runtime.is_simulation, true);
  });

  it("scrubs node summaries but leaves the final text intact", () => {
    const result = {
      ...GOOD_RESULT,
      final_text: "Yield was 42% (E1, p. 4/tab 2).",
      nodes: [
        {
          ...GOOD_RESULT.nodes[0],
          result_summary: "wrote /home/adam/out.txt",
        },
      ],
    };
    const completion = buildCompletion(result, context());
    assert.equal(completion.final_text, "Yield was 42% (E1, p. 4/tab 2).");
    assert.ok(!completion.nodes[0]?.result_summary?.includes("adam"));
  });
});
