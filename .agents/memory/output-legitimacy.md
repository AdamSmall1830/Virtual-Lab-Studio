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
