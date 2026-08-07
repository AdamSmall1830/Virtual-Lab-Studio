---
name: Output legitimacy in generated research records
description: Rules for what may appear in a structured meeting summary — no application-authored judgements, validation as a gate, prompt restrictions are not enforcement.
---

# Nothing in a research record may be authored by the application

Every judgement in a structured meeting summary — the recommendation, the
per-question answers, and above all the confidence numbers — must come from the
model that actually held the meeting. Where a value cannot be obtained, the
record says so explicitly and reports confidence `0.0` with a `basis` string
explaining that no model-derived confidence exists.

**Why:** the summary is what researchers read, quote, export and cite. A
hardcoded confidence of `0.5` on every answer reads as a real, scored judgement
and is indistinguishable from one — it is the single most misleading thing this
product could emit. An honest "not extracted" is always better than a plausible
placeholder. The same applies to cost: an unpriced model must not render as
`$0.00`, which is indistinguishable from a genuinely free run.

**How to apply:** whenever adding a field to a generated record, ask where the
value comes from. If the answer is "we make it up when the model doesn't supply
one," that field must instead be empty, null, or explicitly labelled as not
extracted. Never pick a middling default for a numeric score.

# Schema validation is a gate, not a label

A model record that fails the summary JSON schema must be discarded and replaced
with the honest not-extracted record (valid by construction), with the rejection
recorded as a run event. Persisting the invalid document and merely setting a
`validation_status` field is not enough.

**Why:** downstream consumers — exports, comparisons, citation extraction —
read the document, not the status flag. A status field that nothing enforces is
decoration.

**How to apply:** validate immediately after building the record and before it
is persisted, then fall back. Assume no reader checks the flag.

# A prompt is not an enforcement mechanism

Instructing the model to cite only the evidence frozen into the meeting does not
prevent it from inventing identifiers. Filter every model-supplied reference
against the frozen key set server-side and drop anything unrecognised, noting
the count in the record's limitations.

**Why:** a citation pointing at a source that was never attached is the most
damaging thing a research summary can carry — it manufactures the appearance of
grounding. Note also that "validated" in this system only means the cited key
was frozen into the definition; it has never meant the claim is supported by the
source.

**How to apply:** any place model output crosses into persisted structure
(citations, identifiers, enum values, references to rows), constrain it against
data we own. Resolve entity IDs from our own roster by matching a human-readable
title, so the model can never mint an identifier.

# Blind-safe fields still have to be sent

In a blinded comparison, `run_id` is withheld, so anything the client recovers by
cross-referencing the run breaks exactly when blinding is on. Fields that warn a
reviewer — simulated output, failed validation — are not identifying and must be
sent on every item regardless of blinding.

**Why:** a reviewer scoring a blinded set was ranking simulated demo output
against real findings with no warning.

# A document that leaves the app carries its provenance on every page

Anything exported as a standalone file — PDF, printout, slide paste — loses the
surrounding UI. Authorship (model-generated), human review status, and
simulated/demo status must appear in the page furniture of *every* page, not
only on a cover sheet or in a header block.

**Why:** pages get photocopied, pasted into decks and quoted in email. A cover
disclaimer protects only the reader who received the whole file, which is the
reader least likely to be misled.

**How to apply:** put the three facts in the running footer, and assert them
per-page in a test rather than searching the whole extracted text — a
whole-document match passes even when the warning appears exactly once.

# One definition for any value shown both on screen and on paper

A figure that appears in the UI and in an exported document must come from a
single shared rule, copied verbatim if the two live in different languages.
Independently "improving" the export's formatting or wording is a defect.

**Why:** a reader holding the printout beside the screen and seeing two
different numbers, or two different explanations for a missing one, has no way
to tell which is authoritative. Extra precision in one place is still a
disagreement.

**How to apply:** when porting a display rule across the stack, copy the
placeholder and the explanatory hint character-for-character and say in a
comment that the two are kept in step.

# A renderer of a stored record must survive shapes it did not expect

Records are validated on write, but a validator change, a hand-edited row or a
migration can leave stored data whose shape the renderer does not expect.
Coerce what is coercible, skip what is not, and state on the page how many
entries were skipped and why.

**Why:** a record that has drifted off-schema is exactly the record a reader
most needs to see. Raising instead turns the problem into a failed export,
which reads as a bug in the exporter rather than a defect in the data. Silently
dropping the bad entries is worse — the reader assumes the omissions were
deliberate.

**How to apply:** never call `.get` on an element of a parsed JSON list without
first filtering to mappings, and return the count of what was dropped alongside
the good entries so the caller can disclose it.
