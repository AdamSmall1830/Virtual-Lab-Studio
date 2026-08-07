import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { BundleError, readBundle } from "../src/bundle.js";
import { buildFixtureBundle, buildZip } from "./helpers/fake-server.js";

describe("job bundle reading", () => {
  it("reads a well-formed bundle", () => {
    const fixture = buildFixtureBundle();
    const bundle = readBundle(fixture.bytes, fixture.jobId, fixture.requestSha);
    assert.equal(bundle.manifest.evidence.length, 1);
    assert.match(bundle.taskMarkdown, /Your turn/);
    assert.equal(bundle.manifest.evidence[0]?.evidence_key, "E1");
    assert.ok(bundle.evidence.get("evidence/source-0.txt")?.includes("42 percent"));
  });

  it("refuses entry names outside the closed set", () => {
    // Each of these is a real archive-extraction escape. The reader does not
    // sanitise them into something safe; it refuses the bundle.
    const hostile = [
      "../../../../etc/passwd",
      "/etc/passwd",
      "evidence/../../escape.txt",
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
      "evidence/nested/deep.txt",
      "evidence/source.txt\u0000.png",
      "task.md.exe",
    ];
    for (const name of hostile) {
      const bytes = buildZip([{ name, content: Buffer.from("x") }]);
      assert.throws(
        () => readBundle(bytes, "job-1", "0".repeat(64)),
        BundleError,
        `expected refusal for ${name}`,
      );
    }
  });

  it("refuses a bundle whose manifest points at a different job", () => {
    const fixture = buildFixtureBundle({ jobId: "job-1" });
    assert.throws(
      () => readBundle(fixture.bytes, "job-2", fixture.requestSha),
      /different job/,
    );
  });

  it("refuses a bundle that does not match the leased request hash", () => {
    const fixture = buildFixtureBundle();
    assert.throws(
      () => readBundle(fixture.bytes, fixture.jobId, "f".repeat(64)),
      /leased request hash/,
    );
  });

  it("refuses a bundle missing a required file", () => {
    const bytes = buildZip([{ name: "task.md", content: Buffer.from("hi") }]);
    assert.throws(() => readBundle(bytes, "job-1", "0".repeat(64)), /missing a required file/);
  });

  it("refuses a manifest that references a file the archive lacks", () => {
    const manifest = {
      schema_version: "1.0",
      job_id: "job-1",
      request_sha256: "0".repeat(64),
      meeting_definition_sha256: "0".repeat(64),
      evidence: [
        {
          evidence_key: "E1",
          file: "evidence/missing.txt",
          title: null,
          citation: null,
          content_sha256: null,
          chunk_count: 0,
          truncated: false,
          trust: "untrusted_data",
        },
      ],
    };
    const bytes = buildZip([
      { name: "request.json", content: Buffer.from("{}") },
      { name: "task.md", content: Buffer.from("t") },
      { name: "evidence-manifest.json", content: Buffer.from(JSON.stringify(manifest)) },
    ]);
    assert.throws(() => readBundle(bytes, "job-1", "0".repeat(64)), /does not contain/);
  });

  it("refuses a duplicated entry name", () => {
    const requestJson = "{}";
    const sha = createHash("sha256").update(requestJson).digest("hex");
    const bytes = buildZip([
      { name: "task.md", content: Buffer.from("a") },
      { name: "task.md", content: Buffer.from("b") },
    ]);
    assert.throws(() => readBundle(bytes, "job-1", sha), /duplicate entry/);
  });

  it("refuses something that is not an archive at all", () => {
    assert.throws(
      () => readBundle(new Uint8Array(Buffer.from("not a zip file")), "job-1", "0".repeat(64)),
      /not a readable archive/,
    );
  });
});
