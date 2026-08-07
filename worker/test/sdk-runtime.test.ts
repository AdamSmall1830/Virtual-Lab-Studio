/**
 * Integration tests for the Prime Agent SDK adapter.
 *
 * These drive the *real* pinned SDK -- the same import a container run makes --
 * against a fake OpenAI-compatible server standing in for the operator's local
 * model. Nothing about the adapter's configuration is asserted by reading the
 * adapter's own source: every claim is checked against what the model actually
 * received on the wire.
 *
 * That is the point. An adapter written against a guessed API typechecks
 * perfectly and fails only in front of a real model, and a restricted tool set
 * that was never exercised is a claim, not a control. So the tests here ask:
 * did a session complete, was the system prompt the meeting's, and was the tool
 * list the model saw exactly the reviewed one -- no bash, no file access.
 *
 * If the optional SDK is absent the whole suite skips with a message saying so,
 * because a silent skip is how "the SDK path works" gets believed.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { SdkRuntime, SdkUnavailable } from "../src/runner/runtime/sdk.js";
import { AgentLimitExceeded } from "../src/runner/runtime/types.js";
import { FakeModelServer } from "./helpers/fake-model.js";
import type { RuntimeSessionOptions, RuntimeTool } from "../src/runner/runtime/types.js";

const TOKEN_ENV = "VLS_TEST_MODEL_TOKEN";
const TOKEN = "test-job-token";
const MODEL_ID = "vls-test-model";

/** Every file under a directory, so nothing the SDK wrote goes unchecked. */
function listFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) found.push(...listFiles(path));
    else found.push(path);
  }
  return found;
}

/** The reviewed tool set, in the shape tools.ts produces. */
function reviewedTools(calls: string[]): RuntimeTool[] {
  return [
    {
      name: "vls_python",
      description: "Run Python.",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "The code to run." } },
        required: ["code"],
        additionalProperties: false,
      },
      handler: async (input: unknown) => {
        calls.push(`vls_python:${JSON.stringify(input)}`);
        return { content: "stdout: 4" };
      },
    },
    {
      name: "vls_evidence_search",
      description: "Search the frozen evidence set.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to look for." } },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (input: unknown) => {
        calls.push(`vls_evidence_search:${JSON.stringify(input)}`);
        return { content: "No matching evidence.", isError: true };
      },
    },
  ];
}

const SYSTEM_PROMPT = "You are a Virtual Lab participant. Cite evidence keys exactly.";

const sdkPresent = await SdkRuntime.probe();

describe(
  "Prime Agent SDK adapter (real SDK, fake model)",
  {
    skip: sdkPresent
      ? false
      : "The Prime Agent SDK is not installed, so the production runtime path was NOT exercised by this run.",
  },
  () => {
    const upstream = new FakeModelServer(MODEL_ID);
    let workRoot = "";
    let toolCalls: string[] = [];

    const optionsFor = (overrides: Partial<RuntimeSessionOptions> = {}): RuntimeSessionOptions => ({
      model: MODEL_ID,
      baseUrl: upstream.baseUrl,
      contextWindow: 32_768,
      maxOutputTokens: 2_048,
      apiKeyEnv: TOKEN_ENV,
      systemPrompt: SYSTEM_PROMPT,
      tools: reviewedTools(toolCalls),
      maxTurns: 6,
      cwd: join(workRoot, "work"),
      agentDir: join(workRoot, "agent"),
      ...overrides,
    });

    before(async () => {
      process.env[TOKEN_ENV] = TOKEN;
      workRoot = mkdtempSync(join(tmpdir(), "vls-sdk-test-"));
      mkdirSync(join(workRoot, "work"), { recursive: true });
      mkdirSync(join(workRoot, "agent"), { recursive: true });
      await upstream.start();
    });

    after(async () => {
      await upstream.stop();
      delete process.env[TOKEN_ENV];
      rmSync(workRoot, { recursive: true, force: true });
    });

    it("completes a session and returns the assistant's answer", async () => {
      toolCalls = [];
      upstream.setScript([{ kind: "text", text: "The estimate is 4." }]);
      const session = await new SdkRuntime().createSession(optionsFor());
      try {
        const seen: string[] = [];
        const answer = await session.prompt("What is two plus two?", {
          onAssistantText: (text) => seen.push(text),
        });
        assert.match(answer, /The estimate is 4\./);
        assert.equal(seen.length, 1);

        const usage = session.usage();
        assert.equal(usage.model_call_count, 1);
        assert.equal(usage.input_tokens, 101);
        assert.equal(usage.output_tokens, 7);

        assert.equal(upstream.requests.length, 1);
        const request = upstream.requests[0]!;
        assert.equal(request.path, "/v1/chat/completions");
        assert.equal(request.authorization, `Bearer ${TOKEN}`);
        assert.equal(request.body["model"], MODEL_ID);
      } finally {
        await session.dispose();
      }
    });

    it("sends the meeting's system prompt and nothing from the operator's agent directory", async () => {
      toolCalls = [];
      upstream.setScript([{ kind: "text", text: "Understood." }]);
      const session = await new SdkRuntime().createSession(optionsFor());
      try {
        await session.prompt("Introduce yourself.", {});
        const messages = upstream.requests[0]!.body["messages"] as Array<Record<string, unknown>>;
        const system = messages.filter((m) => m["role"] === "system" || m["role"] === "developer");
        assert.equal(system.length, 1, "expected exactly one system message");
        assert.equal(system[0]!["role"], "system", "a local server must not be sent the developer role");
        const content = String(system[0]!["content"]);
        // The SDK appends the working directory; everything before that must be
        // the meeting's prompt, with none of pi's own coding-agent preamble.
        assert.ok(content.startsWith(SYSTEM_PROMPT), `unexpected system prompt: ${content}`);
        assert.ok(
          content.length < SYSTEM_PROMPT.length + 200,
          `the default agent prompt leaked into the participant's instructions: ${content}`,
        );
      } finally {
        await session.dispose();
      }
    });

    it("offers the model only the reviewed tools", async () => {
      toolCalls = [];
      upstream.setScript([{ kind: "text", text: "Nothing to run." }]);
      const session = await new SdkRuntime().createSession(optionsFor());
      try {
        await session.prompt("List your tools.", {});
        const tools = (upstream.requests[0]!.body["tools"] ?? []) as Array<Record<string, any>>;
        const names = tools.map((tool) => String(tool["function"]?.["name"] ?? tool["name"])).sort();
        assert.deepEqual(names, ["vls_evidence_search", "vls_python"]);
        for (const forbidden of ["bash", "read", "write", "edit", "grep", "find", "ls", "web_search"]) {
          assert.ok(!names.includes(forbidden), `${forbidden} must not be offered to a participant`);
        }
      } finally {
        await session.dispose();
      }
    });

    it("executes a reviewed tool and feeds its output back to the model", async () => {
      toolCalls = [];
      upstream.setScript([
        { kind: "tool", tool: "vls_python", args: { code: "print(2 + 2)" } },
        { kind: "text", text: "Two plus two is 4." },
      ]);
      const session = await new SdkRuntime().createSession(optionsFor());
      try {
        const started: string[] = [];
        const ended: Array<{ name: string; isError: boolean }> = [];
        const answer = await session.prompt("Compute two plus two.", {
          onToolStart: (call) => started.push(call.name),
          onToolEnd: (call, result) => ended.push({ name: call.name, isError: result.isError === true }),
        });

        assert.deepEqual(toolCalls, ['vls_python:{"code":"print(2 + 2)"}']);
        assert.deepEqual(started, ["vls_python"]);
        assert.deepEqual(ended, [{ name: "vls_python", isError: false }]);
        assert.match(answer, /Two plus two is 4\./);

        assert.equal(upstream.requests.length, 2);
        const followUp = JSON.stringify(upstream.requests[1]!.body["messages"]);
        assert.match(followUp, /stdout: 4/);
        assert.equal(session.usage().model_call_count, 2);
      } finally {
        await session.dispose();
      }
    });

    it("reports a failing tool as an error without ending the run", async () => {
      toolCalls = [];
      upstream.setScript([
        { kind: "tool", tool: "vls_evidence_search", args: { query: "unobtainium" } },
        { kind: "text", text: "I could not find supporting evidence." },
      ]);
      const session = await new SdkRuntime().createSession(optionsFor());
      try {
        const ended: Array<{ name: string; isError: boolean }> = [];
        const answer = await session.prompt("Find evidence for unobtainium.", {
          onToolEnd: (call, result) => ended.push({ name: call.name, isError: result.isError === true }),
        });
        assert.deepEqual(ended, [{ name: "vls_evidence_search", isError: true }]);
        assert.match(answer, /could not find supporting evidence/);
        assert.match(JSON.stringify(upstream.requests[1]!.body["messages"]), /No matching evidence\./);
      } finally {
        await session.dispose();
      }
    });

    it("fails a looping participant at its turn limit instead of answering", async () => {
      toolCalls = [];
      // The model never stops asking for the tool. Only the turn cap ends this.
      upstream.setScript([], { kind: "tool", tool: "vls_python", args: { code: "pass" } });
      const session = await new SdkRuntime().createSession(optionsFor({ maxTurns: 3 }));
      try {
        await assert.rejects(
          () => session.prompt("Keep going forever.", {}),
          (error: unknown) =>
            error instanceof AgentLimitExceeded && /3-turn limit/.test((error as Error).message),
        );
        assert.ok(
          upstream.requests.length <= 4,
          `expected the cap to stop the loop, saw ${upstream.requests.length} model calls`,
        );
      } finally {
        await session.dispose();
      }
    });

    it("does not hand back the half-written answer of a capped participant", async () => {
      toolCalls = [];
      // Prose first, then an endless tool loop: the text reads like a finished
      // answer, which is exactly why it must not be returned as one.
      upstream.setScript([], {
        kind: "both",
        text: "The evidence shows a 42 percent yield, therefore",
        tool: "vls_python",
        args: { code: "pass" },
      });
      const seen: string[] = [];
      const session = await new SdkRuntime().createSession(optionsFor({ maxTurns: 2 }));
      try {
        await assert.rejects(
          () => session.prompt("Keep going forever.", { onAssistantText: (t) => seen.push(t) }),
          (error: unknown) => error instanceof AgentLimitExceeded,
        );
        assert.deepEqual(seen, [], "a capped run leaked partial text to the host");
      } finally {
        await session.dispose();
      }
    });

    it("refuses to build a session when the model credential is missing", async () => {
      toolCalls = [];
      await assert.rejects(
        () => new SdkRuntime().createSession(optionsFor({ apiKeyEnv: "VLS_TEST_ABSENT_TOKEN" })),
        (error: unknown) => error instanceof SdkUnavailable && /credential is missing/.test((error as Error).message),
      );
    });

    it("never writes the job's model credential to disk", async () => {
      toolCalls = [];
      upstream.setScript([{ kind: "text", text: "Noted." }]);
      const agentDir = join(workRoot, "agent");
      const session = await new SdkRuntime().createSession(optionsFor({ agentDir }));
      try {
        await session.prompt("Say something.", {});
        assert.equal(upstream.requests[0]!.authorization, `Bearer ${TOKEN}`);
        for (const file of listFiles(agentDir)) {
          const contents = readFileSync(file, "utf8");
          assert.ok(!contents.includes(TOKEN), `${file} contains the job's model credential`);
        }
      } finally {
        await session.dispose();
      }
    });
  },
);

