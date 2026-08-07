/**
 * The in-sandbox entrypoint.
 *
 * This is PID 1 inside the container. It reads the job from the read-only
 * input mount, drives the agent, streams framed events on stdout, and writes
 * ``result.json`` to the output mount. It has no network beyond the model
 * proxy, no credentials beyond a job-scoped bearer token, and no idea that a
 * Virtual Lab Studio server exists.
 *
 * That last point is the design: everything this process produces is treated
 * as a claim by the host, which re-validates bounds, re-checks citations and
 * re-scrubs text before anything reaches the studio. So the code here can be
 * straightforward about the agent and leave suspicion to the other side of the
 * boundary.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PINNED_AGENT_VERSION } from "../protocol.js";
import type { EvidenceManifest } from "../protocol.js";
import { encodeRunnerEvent } from "../runtime-events.js";
import type { RunnerEvent } from "../runtime-events.js";
import type { RunnerJobSpec } from "../workspace.js";
import { buildChildPrompt, buildSystemPrompt } from "./prompt.js";
import { citedKeys, parseResponse } from "./parse.js";
import { FakeRuntime } from "./runtime/fake.js";
import { SdkRuntime, SdkUnavailable } from "./runtime/sdk.js";
import { AgentLimitExceeded } from "./runtime/types.js";
import type { AgentRuntime, RuntimeSession, RuntimeTool } from "./runtime/types.js";
import { createDelegateTool, createEvidenceTool, createPythonTool } from "./tools.js";

const INPUT_DIR = process.env["VLS_INPUT_DIR"] ?? "/job/input";
const OUTPUT_DIR = process.env["VLS_OUTPUT_DIR"] ?? "/job/output";
const SCRATCH_DIR = process.env["TMPDIR"] ?? "/tmp";
const MODEL_TOKEN_ENV = "VLS_MODEL_TOKEN";

function emit(event: RunnerEvent): void {
  process.stdout.write(encodeRunnerEvent(event));
}

function note(level: "debug" | "info" | "warn" | "error", message: string): void {
  emit({ kind: "diagnostic", level, message });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function selectRuntime(preference: string): Promise<AgentRuntime> {
  if (preference === "fake") return new FakeRuntime();
  if (preference === "sdk") return new SdkRuntime();
  // auto: the SDK or nothing. The fake is never selected automatically -- a
  // simulated participant has to be asked for, or a missing dependency would
  // quietly turn real research into a scripted answer -- and there is no
  // second real runtime to try, because the agent's CLI cannot be given this
  // worker's reviewed tools and would offer its own shell and file tools
  // instead.
  if (await SdkRuntime.probe()) return new SdkRuntime();
  throw new SdkUnavailable(
    `The Prime Agent SDK (${PINNED_AGENT_VERSION}) is not installed in this sandbox, so no real participant can run.`,
  );
}

interface ChildBudget {
  used: number;
  readonly max: number;
}

async function main(): Promise<number> {
  const spec = readJson<RunnerJobSpec>(join(INPUT_DIR, "job.json"));
  const manifest = readJson<EvidenceManifest>(join(INPUT_DIR, "evidence-manifest.json"));
  const task = readFileSync(join(INPUT_DIR, "task.md"), "utf8");
  const skillDir = join(INPUT_DIR, "skills", "vls_evidence");
  const evidenceKeys = manifest.evidence.map((entry) => entry.evidence_key);

  const scratch = join(SCRATCH_DIR, "vls-work");
  mkdirSync(scratch, { recursive: true });
  const agentDir = join(SCRATCH_DIR, "vls-agent");
  mkdirSync(agentDir, { recursive: true });

  const preference = process.env["VLS_AGENT_RUNTIME"] ?? "auto";
  const runtime = await selectRuntime(preference);
  emit({ kind: "runner.ready", adapter: runtime.id, prime_agent_version: runtime.version });

  const baseUrl = process.env["VLS_MODEL_BASE_URL"] ?? spec.model_endpoint.base_url;
  const rootNodeId = "coordinator";
  const budget: ChildBudget = { used: 0, max: spec.limits.max_children };
  const sessions: RuntimeSession[] = [];

  const observerFor = (nodeId: string) => ({
    onToolStart: (call: { name: string }) => emit({ kind: "tool.started", node_id: nodeId, tool: call.name }),
    onToolEnd: (call: { name: string }, result: { isError?: boolean }) =>
      emit(
        result.isError
          ? { kind: "tool.failed", node_id: nodeId, tool: call.name }
          : { kind: "tool.completed", node_id: nodeId, tool: call.name },
      ),
    onUsage: (usage: { model_call_count: number; input_tokens: number; output_tokens: number }) =>
      emit({
        kind: "usage",
        node_id: nodeId,
        model_call_count: usage.model_call_count,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        // Local models are free to run. Cost is reported by the host from the
        // configured pricing, not guessed at here.
        cost_usd: 0,
        pricing_complete: true,
      }),
  });

  /** Run one specialist to completion and return its findings. */
  const runChild = async (request: { display_name: string; task: string }): Promise<string> => {
    if (budget.used >= budget.max) throw new Error("No specialists remain for this turn.");
    budget.used += 1;
    const childId = `child-${budget.used}`;
    emit({
      kind: "node.started",
      node_id: childId,
      parent_node_id: rootNodeId,
      display_name: request.display_name,
      task_summary: request.task.slice(0, 400),
      model_key: spec.child_model_key ?? spec.model_key,
      depth: 1,
    });
    const childTools: RuntimeTool[] = [
      createPythonTool(scratch),
      createEvidenceTool(skillDir, scratch, manifest),
    ];
    let session: RuntimeSession | null = null;
    try {
      session = await runtime.createSession({
        model: spec.model_endpoint.child_model_id ?? spec.model_endpoint.model_id,
        baseUrl,
        contextWindow: spec.model_endpoint.context_window,
        maxOutputTokens: spec.model_endpoint.max_tokens,
        apiKeyEnv: MODEL_TOKEN_ENV,
        systemPrompt: buildChildPrompt({
          displayName: request.display_name,
          evidenceKeys,
          // Children never delegate further in this build: depth 2 with
          // fan-out 8 is already 73 agents, and deeper trees produce noise
          // rather than insight.
          depthRemaining: 0,
        }),
        tools: childTools,
        maxTurns: Math.max(2, Math.floor(spec.limits.max_agent_turns / 2)),
        cwd: scratch,
        agentDir,
      });
      sessions.push(session);
      const findings = await session.prompt(request.task, observerFor(childId));
      emit({
        kind: "node.completed",
        node_id: childId,
        result_summary: findings.slice(0, 600),
        cited_evidence_keys: citedKeys(parseResponse(findings).citations),
      });
      return findings;
    } catch (error) {
      emit({
        kind: "node.failed",
        node_id: childId,
        // A specialist that ran out of turns did not fail at its work; naming
        // it as a bound keeps the researcher's reading of the tree honest.
        failure_category: error instanceof AgentLimitExceeded ? "limit_exceeded" : "specialist_error",
        message: error instanceof Error ? error.message : "The specialist failed.",
      });
      throw error;
    } finally {
      await session?.dispose().catch(() => undefined);
    }
  };

  const tools: RuntimeTool[] = [
    createPythonTool(scratch),
    createEvidenceTool(skillDir, scratch, manifest),
  ];
  if (spec.limits.max_children > 0 && spec.limits.max_depth > 0) {
    tools.push(
      createDelegateTool(spec.limits.max_children, () => budget.max - budget.used, runChild),
    );
  }

  emit({
    kind: "node.started",
    node_id: rootNodeId,
    parent_node_id: null,
    display_name: "Participant",
    model_key: spec.model_key,
    depth: 0,
  });

  let finalText = "";
  let failure: string | null = null;
  const root = await runtime.createSession({
    model: spec.model_endpoint.model_id,
    baseUrl,
    contextWindow: spec.model_endpoint.context_window,
    maxOutputTokens: spec.model_endpoint.max_tokens,
    apiKeyEnv: MODEL_TOKEN_ENV,
    systemPrompt: buildSystemPrompt({
      spec,
      evidenceKeys,
      childrenAllowed: spec.limits.max_depth > 0 ? spec.limits.max_children : 0,
    }),
    tools,
    maxTurns: spec.limits.max_agent_turns,
    cwd: scratch,
    agentDir,
  });
  sessions.push(root);

  let failureCategory = "runtime_error";
  try {
    finalText = await root.prompt(task, observerFor(rootNodeId));
  } catch (error) {
    failure = error instanceof Error ? error.message : "The participant failed.";
    if (error instanceof AgentLimitExceeded) failureCategory = "limit_exceeded";
    // Nothing the participant had written is carried forward: a run stopped at
    // a bound has no conclusion, and half of one would be published as though
    // it were the answer.
    finalText = "";
  }

  const parsed = parseResponse(finalText);
  if (failure) {
    emit({ kind: "node.failed", node_id: rootNodeId, failure_category: failureCategory, message: failure });
  } else {
    emit({
      kind: "node.completed",
      node_id: rootNodeId,
      result_summary: parsed.finalText.slice(0, 600),
      cited_evidence_keys: citedKeys(parsed.citations),
    });
  }

  const usage = root.usage();
  const result = {
    schema_version: "1.0",
    request_sha256: spec.request_sha256,
    final_text: parsed.finalText,
    citations: parsed.citations,
    limitations: parsed.limitations,
    is_simulation: runtime.isSimulation,
    runtime_adapter: runtime.id,
    prime_agent_version: runtime.version,
    usage: {
      model_call_count: usage.model_call_count,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    },
    nodes: [
      {
        external_node_id: rootNodeId,
        parent_external_node_id: null,
        display_name: "Participant",
        status: failure ? "failed" : "completed",
        model_key: spec.model_key,
        result_summary: parsed.finalText.slice(0, 600),
        cited_evidence_keys: citedKeys(parsed.citations),
        failure_safe_message: failure,
      },
    ],
    failure,
  };
  writeFileSync(join(OUTPUT_DIR, "result.json"), JSON.stringify(result, null, 2), "utf8");

  for (const session of sessions) await session.dispose().catch(() => undefined);
  return failure ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "The runner failed to start.";
    if (error instanceof SdkUnavailable) note("error", message);
    else note("error", message);
    try {
      writeFileSync(
        join(OUTPUT_DIR, "result.json"),
        JSON.stringify({ schema_version: "1.0", failure: message }, null, 2),
        "utf8",
      );
    } catch {
      // The output mount may be unwritable; the framed diagnostic above is
      // still on stdout, which is where the host will look.
    }
    process.exitCode = 1;
  });
