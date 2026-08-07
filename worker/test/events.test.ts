import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EventNormalizer, NodeLedger } from "../src/events.js";
import type { JobLimits } from "../src/protocol.js";
import type { RunnerEvent } from "../src/runtime-events.js";

const LIMITS: JobLimits = {
  max_children: 2,
  max_depth: 1,
  max_agent_turns: 8,
  max_tokens: 32_000,
  max_runtime_seconds: 120,
  max_cost_usd: 2,
};

function normalizer(limits: JobLimits = LIMITS, clock = { now: 1_000 }): EventNormalizer {
  return new EventNormalizer({ jobId: "job-1", limits, now: () => clock.now });
}

function started(id: string, parent: string | null, depth = 0): RunnerEvent {
  return {
    kind: "node.started",
    node_id: id,
    parent_node_id: parent,
    display_name: `Agent ${id}`,
    depth,
  };
}

describe("node bounds are enforced on the host", () => {
  it("admits the coordinator and the allowed children", () => {
    const ledger = new NodeLedger(LIMITS);
    assert.deepEqual(ledger.admit("root", null), { ok: true, depth: 0 });
    assert.deepEqual(ledger.admit("a", "root"), { ok: true, depth: 1 });
    assert.deepEqual(ledger.admit("b", "root"), { ok: true, depth: 1 });
  });

  it("refuses a node nested deeper than the meeting allows", () => {
    const ledger = new NodeLedger(LIMITS);
    ledger.admit("root", null);
    ledger.admit("a", "root");
    assert.deepEqual(ledger.admit("grandchild", "a"), { ok: false, reason: "depth" });
  });

  it("refuses a node whose parent was never announced", () => {
    // Otherwise a runner could hide depth by simply not reporting the middle.
    const ledger = new NodeLedger(LIMITS);
    ledger.admit("root", null);
    assert.deepEqual(ledger.admit("orphan", "ghost"), { ok: false, reason: "cycle" });
  });

  it("refuses more nodes than max_children * max_depth + 1", () => {
    const ledger = new NodeLedger(LIMITS);
    ledger.admit("root", null);
    ledger.admit("a", "root");
    ledger.admit("b", "root");
    assert.deepEqual(ledger.admit("c", "root"), { ok: false, reason: "count" });
    assert.equal(ledger.snapshot().droppedForBounds, 1);
  });

  it("reports the breach up to the caller so the job can be stopped", () => {
    const events = normalizer();
    events.ingest(started("root", null));
    events.ingest(started("a", "root"));
    events.ingest(started("b", "root"));
    const verdict = events.ingest(started("c", "root"));
    assert.equal(verdict.boundsViolation, "count");
  });
});

describe("event normalisation", () => {
  it("maps the coordinator and children onto different event types", () => {
    const events = normalizer();
    events.ingest(started("root", null));
    events.ingest(started("a", "root"));
    const types = events.peek(10).map((event) => event.type);
    assert.deepEqual(types, ["recursive.agent.started", "recursive.subagent.started"]);
  });

  it("numbers events monotonically and gives each a stable id", () => {
    const events = normalizer();
    events.ingest(started("root", null));
    events.ingest(started("a", "root"));
    const batch = events.peek(10);
    assert.deepEqual(
      batch.map((event) => event.worker_sequence),
      [1, 2],
    );
    assert.deepEqual(
      batch.map((event) => event.external_event_id),
      ["job-1:1", "job-1:2"],
    );
  });

  it("coalesces repeated progress but never a lifecycle transition", () => {
    const clock = { now: 1_000 };
    const events = normalizer(LIMITS, clock);
    events.ingest(started("root", null));
    events.ingest({ kind: "node.progress", node_id: "root", result_summary: "one" });
    events.ingest({ kind: "node.progress", node_id: "root", result_summary: "two" });
    events.ingest({ kind: "node.progress", node_id: "root", result_summary: "three" });
    assert.equal(events.peek(50).filter((e) => e.type === "recursive.agent.updated").length, 1);

    clock.now += 10_000;
    events.ingest({ kind: "node.progress", node_id: "root", result_summary: "later" });
    assert.equal(events.peek(50).filter((e) => e.type === "recursive.agent.updated").length, 2);

    events.ingest({ kind: "node.completed", node_id: "root", result_summary: "done" });
    assert.ok(events.peek(50).some((e) => e.type === "recursive.agent.completed"));
  });

  it("drops tool activity outside the reviewed capability profile", () => {
    const events = normalizer();
    events.ingest(started("root", null));
    events.ingest({ kind: "tool.started", node_id: "root", tool: "bash" });
    events.ingest({ kind: "tool.started", node_id: "root", tool: "web_fetch" });
    assert.equal(events.peek(50).filter((e) => e.type === "recursive.tool.started").length, 0);
    events.ingest({ kind: "tool.started", node_id: "root", tool: "python" });
    const tool = events.peek(50).find((e) => e.type === "recursive.tool.started");
    assert.equal(tool?.payload.tool_label, "Python");
  });

  it("ignores events for nodes that were never admitted", () => {
    const events = normalizer();
    events.ingest({ kind: "node.completed", node_id: "phantom", result_summary: "done" });
    assert.equal(events.pending, 0);
  });

  it("rejects node ids that could carry markup or control bytes", () => {
    const events = normalizer();
    events.ingest({
      kind: "node.started",
      node_id: "<script>alert(1)</script>",
      parent_node_id: null,
      display_name: "x",
      depth: 0,
    });
    assert.equal(events.pending, 0);
  });

  it("scrubs summaries before they reach an outbound payload", () => {
    const events = normalizer();
    events.ingest({
      kind: "node.started",
      node_id: "root",
      parent_node_id: null,
      display_name: "Agent",
      task_summary: "reading /home/adam/notes.md with key sk-abcdefghijklmnopqrst",
      depth: 0,
    });
    const summary = events.peek(1)[0]?.payload.task_summary ?? "";
    assert.ok(!summary.includes("adam"));
    assert.ok(!summary.includes("sk-abcdef"));
  });

  it("accumulates usage across nodes", () => {
    const events = normalizer();
    events.ingest(started("root", null));
    events.ingest({
      kind: "usage",
      node_id: "root",
      model_call_count: 1,
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0,
      pricing_complete: true,
    });
    events.ingest({
      kind: "usage",
      node_id: "root",
      model_call_count: 1,
      input_tokens: 20,
      output_tokens: 5,
      cost_usd: 0,
      pricing_complete: true,
    });
    assert.equal(events.usage.total.input_tokens, 120);
    assert.equal(events.usage.total.output_tokens, 55);
    assert.equal(events.usage.total.model_call_count, 2);
  });

  it("never emits a terminal job event", () => {
    const events = normalizer();
    events.jobStarted("local-test");
    events.ingest(started("root", null));
    events.ingest({ kind: "node.completed", node_id: "root" });
    const terminal = events
      .peek(50)
      .filter((event) =>
        ["recursive.job.completed", "recursive.job.failed", "recursive.job.cancelled"].includes(
          event.type,
        ),
      );
    assert.equal(terminal.length, 0);
  });
});
