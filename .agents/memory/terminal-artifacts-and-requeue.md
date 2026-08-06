---
name: Terminal artifacts vs. requeuing a run
description: Why any transition that un-terminals a run must serialize with terminal-artifact writes, and why a stale summary is worse than a missing one.
---

# Terminal artifacts vs. requeuing a run

A run's terminal status is committed in one transaction; its summary and
manifest are written in a **separate, later** transaction (and for direct
cancellation, in a different session entirely). Any operation that moves a run
*out* of a terminal status — resume/retry — therefore races that second write.

**Rule:** the un-terminalling transition and the terminal-artifact write must
both take the run's row lock (`SELECT ... FOR UPDATE` on `runs`), and the
artifact writer must re-read the status under that lock and write nothing if the
run is no longer terminal. Signal that skip distinctly from failure — a skip is
not an error, and callers must not announce an artifact that was never written.

**Why:** the completion path *reuses* an existing summary rather than
regenerating it (deliberately, so a crash between "summary written" and "run
marked completed" cannot double-insert). That makes a stale summary far more
dangerous than a missing one: a resumed run that finds the abandoned attempt's
terminal-outcome summary will finish and keep it, presenting a truncated
prefix — or an outright "this run failed" placeholder — as the final result of a
successful meeting. Provenance is the product's core claim, so this is a
correctness bug, not cosmetics.

**How to apply:** when adding any run state transition, ask whether it can run
concurrently with a terminal handler. The lock protocol only works if *both*
sides take it; a new caller that skips the lock silently reopens the race. When
changing the artifact writer's return contract, every caller must be updated —
they are spread across the engine's terminal handlers and several API endpoints,
not just one place.

**Related:** replaying completed turns is free (the engine rebuilds the
transcript from stored `response_text` and skips the provider call), but the
*remaining* turns still send the accumulated transcript as input, so their input
tokens are billed normally. Say so plainly rather than implying a resume is free.
