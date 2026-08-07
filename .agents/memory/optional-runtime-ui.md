---
name: Surfacing an optional, off-by-default runtime in the UI
description: Rules for showing a feature that may be absent, unpermitted, unenrolled or offline without lying to the researcher or silently changing their choice.
---

# Surfacing an optional, off-by-default runtime in the UI

The recursive-agent runtime may be missing at four different layers at once:
not deployed (the router is unregistered, so every path 404s), deployed but the
caller lacks the admin role, deployed with no machine enrolled, or enrolled with
nothing online. The UI has to distinguish all four, because the researcher's
next action is different in each case.

## Derive availability from one query, by status code

**Rule:** collapse the whole availability question into the *single* workers-list
query — 404 means the runtime is not deployed, 401/403 means not permitted, 200
with no live worker means none enrolled or none online, and a live worker whose
catalogue advertises no compatible model is its own state.

**Why:** any second probe can disagree with the first, and a UI that shows two
contradictory explanations of why a button is disabled is worse than one that
shows a vaguer single one.

**How to apply:** keep this as a pure function over `{isLoading, error, workers,
now}` so it is testable without a query client, and give every state a headline
plus a one-line detail written for a researcher, not an operator.

## Losing availability must never rewrite a choice the user made

**Rule:** when the runtime becomes unavailable *after* a seat was configured for
it, leave the seat on that runtime and turn the unavailability into a launch
blocker. Disable the option only for seats that never chose it.

**Why:** silently demoting a seat back to the default would run a different
experiment than the one the researcher configured and still call it theirs. A
blocked launch costs a few minutes; a quietly substituted method corrupts the
record. Say so explicitly on screen ("nothing will be run on a standard provider
in its place") — the absence of a fallback is not self-evident to the reader.

**How to apply:** the default config object should start with nothing selected,
so an unconfigured seat also surfaces as a blocker rather than picking a machine
on the researcher's behalf.

## A live tree must be re-read from the server, never accumulated from events

**Rule:** treat the stream as a *notification* that something changed, and the
read endpoint as the only source of node content. Debounce the refetch, and force
one on every reconnect.

**Why:** a browser that dropped its connection cannot know which events it
missed, so a client-accumulated tree silently diverges from the record and there
is no point at which it notices. This matters more than the extra requests.

**How to apply:** bump a nonce on each reconnect after the first and depend on it
in the refetch effect; reset the debounce watermark at the same time.

## A ceiling and a projection must not be added together

**Rule:** show bounds for the delegating runtime in their own panel, separate
from the estimate for the standard one, every figure prefixed to read as a
maximum.

**Why:** summing "what we expect this to cost" with "the most this is allowed to
cost" yields a number that is neither, and researchers quote pre-launch figures
in write-ups. For the same reason an unpriced self-hosted model renders as
unknown, never as zero, and a simulated run says so inside the bounds panel
itself rather than relying on a banner elsewhere on the page.
