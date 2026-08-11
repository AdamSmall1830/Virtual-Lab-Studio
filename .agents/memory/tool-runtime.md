---
name: Tool runtime rules
description: Invariants for letting agents actually execute tools — authorization, bounds, billing vs. lease fencing, and what belongs in the transcript.
---

# Authorization is the frozen per-agent allowlist, never "enabled tools"

The set of tools a participant may call is the id list frozen onto its
meeting-definition agent row at launch — not every enabled tool in the
workspace, and not a slug lookup.

**Why:** that frozen list is restored verbatim when a definition is rebuilt and
is reported in the provenance manifest as what the participant was equipped
with. Offering more makes the manifest describe a meeting that did not happen.
An empty list therefore means *no tools*, never *all tools*.

**How to apply:** resolve by frozen id, then constrain to system-scoped or
this workspace's own definitions. Slug-based resolution invites a shadowing
bug; ids do not. If a participant somehow has two definitions sharing one slug
and either needs approval, withhold the whole slug — the model addresses tools
by name, so resolving that ambiguity permissively runs exactly the handler a
reviewer meant to gate.

# Approval-gated means withheld, not executed

There is no mid-turn human approval prompt, so a tool flagged for approval is
simply not offered, and the withholding is written to the run record.

# Bounds raise; they never return partial work

Hitting the tool-iteration ceiling must raise and fail the turn.

**Why:** a looping participant writes confident, answer-shaped prose before it
is stopped. Returning that text publishes an interrupted fragment into a
research record as a finished contribution. Same reasoning as never trimming a
bounded tool result to an empty list: "found nothing" is a different and false
claim from "what it found was too large".

# The tool exchange stays out of the shared transcript

Tool and intermediate assistant messages live inside the turn; only the final
answer reaches the transcript. Audit lives in the tool-call rows.

**Why:** resume rebuilds the transcript from each turn's stored response text.
A live path carrying tool traffic would replay differently than it ran —
different prompts, different request hashes, a different meeting.

# Billing and lease fencing pull against each other

Bill each provider call as it returns *or* a failed turn silently eats tokens;
but bill without a fence and a worker that already lost the run corrupts the
new owner's counters. Both are real, and the naive fix for one breaks the other
(it broke the stale-turn invariant test).

**How to apply:** the answering call is billed inside the same fenced
transaction that persists the turn. Intermediate calls — which the caller never
sees and which would otherwise vanish when a loop exhausts — are billed inside
the loop, each behind its own owner-conditional fence, abandoning the attempt
if ownership is gone.

# A budget checked per turn stops binding once a turn can make many calls

Turn-boundary budget checks were equivalent to per-call checks only while one
turn meant one provider call. With tools, one turn can make several, so the
ceiling must be asserted before *every* call.

# Retire abandoned audit rows; do not delete them

When an interrupted turn is replayed on its existing row, mark the previous
attempt's in-flight tool calls cancelled rather than deleting them, and do not
decrement the run's tool total.

**Why:** those lookups really ran, external services really were queried, and
events already on the record reference those rows by id. Deleting strands the
events and makes the record claim less happened than did. The unique
(turn, sequence) key then requires the retry to continue the sequence past the
retired rows rather than restarting at zero.

# A malformed tool call must fail the call, not be skipped

Every requested call needs a reply keyed by its id, and the assistant message is
replayed verbatim. An entry with no id/name, or a duplicate id, cannot be
answered — skipping it builds a follow-up request the provider will reject, so
reject the response instead.
