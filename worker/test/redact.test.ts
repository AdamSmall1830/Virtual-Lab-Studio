import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampText, redact, safeErrorMessage, safeText } from "../src/redact.js";

describe("outbound scrubbing", () => {
  it("removes credentials in the shapes that actually leak", () => {
    const cases = [
      "api_key: sk-abcdefghijklmnopqrstuvwx",
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      // The prefixes the server actually mints, bare rather than after a
      // "token=" label: a summary is far more likely to quote the value on its
      // own than to hand over a labelled field.
      "left over in a scratch file: rwk_0a1b2c3d4e5f_Zm9vYmFyc2VjcmV0",
      "the enrollment code is rwe_9f8e7d6c5b4a_c2VjcmV0Y29kZQ",
      "token=vlsw_9f8e7d6c5b4a3928",
      "the enrollment code is vlse_abc123def456",
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    ];
    for (const input of cases) {
      const output = redact(input);
      assert.ok(output.includes("[redacted]"), `expected a redaction in: ${output}`);
      assert.ok(
        !/sk-abcdef|eyJhbGciOi|rwk_0a1b|rwe_9f8e|vlsw_9f8e|vlse_abc123|ghp_0123/.test(output),
        output,
      );
    }
  });

  it("removes filesystem paths on both platforms", () => {
    assert.ok(!redact("failed at /home/adam/lab/run.py").includes("adam"));
    assert.ok(!redact("C:\\Users\\Adam\\virtual-lab\\out.txt").includes("Adam"));
    assert.ok(!redact("see \\\\FILESERVER\\share\\evidence").includes("FILESERVER"));
    assert.ok(!redact("reading /job/input/evidence/source-0.txt").includes("evidence/source"));
  });

  it("removes URLs and local addresses that disclose the operator's network", () => {
    assert.ok(!redact("posting to http://192.168.1.14:11434/v1").includes("192.168"));
    assert.ok(!redact("model at https://gpu-box.lan/v1/chat").includes("gpu-box"));
    assert.ok(!redact("connect 10.0.0.7:8080").includes("10.0.0.7"));
  });

  it("keeps ordinary research prose readable", () => {
    const prose =
      "The 2019 assay reports a 42% yield, which contradicts Smith et al. and suggests the " +
      "reaction is temperature-sensitive.";
    assert.equal(redact(prose), prose);
  });

  it("strips control characters that would survive JSON encoding", () => {
    const output = redact("summary\u0000with\u0007control\u001bchars");
    assert.ok(!/[\u0000-\u001f]/.test(output));
  });

  it("marks truncation rather than cutting silently", () => {
    const text = "a".repeat(500);
    const output = safeText(text, 100);
    assert.equal(output?.length, 100);
    assert.ok(output?.endsWith("\u2026"));
  });

  it("returns undefined when nothing survives the scrub", () => {
    assert.equal(safeText("/home/adam", 100), "[redacted]");
    assert.equal(safeText(42, 100), undefined);
    assert.equal(safeText("", 100), undefined);
  });

  it("does not scrub the research record itself, only clamps it", () => {
    // The final response is the scientific output. A locator like "p. 4/tab 2"
    // must survive intact even though it looks path-ish to the scrubber.
    const answer = "Yield was 42% (E1, p. 4/tab 2).";
    assert.equal(clampText(answer, 1_000), answer);
  });

  it("drops stack traces from error messages", () => {
    const error = new Error("ENOENT: no such file, open '/home/adam/.vls/worker-token'");
    const message = safeErrorMessage(error);
    assert.ok(!message.includes("adam"));
    assert.ok(!message.includes(".vls"));
  });
});
