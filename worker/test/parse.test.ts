import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { citedKeys, parseResponse } from "../src/runner/parse.js";

describe("parsing the participant's final message", () => {
  it("splits prose from the machine-readable appendix", () => {
    const text = [
      "The assay reports a 42% yield under standard conditions.",
      "",
      "## Citations",
      "- E1 | p. 4 | 42% yield under standard conditions | supports",
      "- E2 | - | the reaction is temperature sensitive | uncertain",
      "",
      "## Limitations",
      "- Only two sources were attached.",
      "- No replication data was available.",
    ].join("\n");
    const parsed = parseResponse(text);
    assert.equal(parsed.finalText, "The assay reports a 42% yield under standard conditions.");
    assert.equal(parsed.citations.length, 2);
    assert.deepEqual(parsed.citations[0], {
      evidence_key: "E1",
      locator: "p. 4",
      claim: "42% yield under standard conditions",
      support_type: "supports",
    });
    assert.equal(parsed.citations[1]?.locator, null);
    assert.equal(parsed.citations[1]?.support_type, "uncertain");
    assert.equal(parsed.limitations.length, 2);
  });

  it("defaults an unknown support type to context rather than guessing", () => {
    const parsed = parseResponse("Answer.\n\n## Citations\n- E1 | p. 1 | claim | definitely");
    assert.equal(parsed.citations[0]?.support_type, "context");
  });

  it("drops a citation line it cannot read instead of inventing one", () => {
    // A prose line here would otherwise become a citation with a nonsense key,
    // which the validator would then reject with a confusing message.
    const parsed = parseResponse(
      "Answer.\n\n## Citations\n- I based this on the first source we were given.",
    );
    assert.equal(parsed.citations.length, 0);
  });

  it("handles a response with no appendix at all", () => {
    const parsed = parseResponse("Just the answer, no sections.");
    assert.equal(parsed.finalText, "Just the answer, no sections.");
    assert.deepEqual(parsed.citations, []);
    assert.deepEqual(parsed.limitations, []);
  });

  it("keeps the original text when the model produced only an appendix", () => {
    const parsed = parseResponse("## Citations\n- E1 | p. 1 | claim | supports");
    assert.ok(parsed.finalText.length > 0);
  });

  it("accepts headings at any level and with trailing punctuation", () => {
    const parsed = parseResponse("Answer.\n\n### Citations:\n- E1 | p.1 | c | supports");
    assert.equal(parsed.citations.length, 1);
  });

  it("uses the last appendix when the model repeats a heading", () => {
    const parsed = parseResponse(
      ["Answer.", "", "## Citations", "- E1 | a | b | supports", "", "## Citations", "- E2 | c | d | supports"].join("\n"),
    );
    assert.deepEqual(citedKeys(parsed.citations), ["E2"]);
  });

  it("deduplicates cited keys", () => {
    const parsed = parseResponse(
      ["Answer.", "", "## Citations", "- E1 | a | b | supports", "- E1 | c | d | context"].join("\n"),
    );
    assert.deepEqual(citedKeys(parsed.citations), ["E1"]);
  });
});
