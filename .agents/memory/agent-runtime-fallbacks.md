---
name: Agent runtime fallbacks
description: Why the bridge worker has exactly two agent runtimes (real SDK, explicit fake) and no automatic fallback to a second real one.
---

# There is no second real agent runtime

A runtime that runs the participant must be able to register the worker's own
reviewed tools. If it cannot, do not ship it as a fallback — fail the job
instead.

**Why:** the coding agent's CLI looked like a usable second runtime (it has a
real RPC mode), but custom in-process tools can only be registered through the
SDK. A CLI fallback would have silently swapped the reviewed tool set for the
agent's own built-in shell and file tools — a strictly worse security posture,
reached automatically, at exactly the moment something was already wrong. An
untested fallback also hides the real defect: the operator sees a run that
"worked" instead of a missing dependency.

**How to apply:** runtime selection is SDK-or-explicit-fake. `auto` means the
SDK or a loud failure; the fake is never selected automatically, or a missing
dependency turns real research into a scripted answer. Any future third runtime
must prove the on-wire tool list against a fake model server before it is
selectable, and must never be reachable by silent fallback.

# A sandbox is handed the resolved model, never a way to pick one

Whatever sits in the path of the model calls must receive the exact model
config the job was leased for. Do not give it a resolver, a key to look up, or
a default.

**Why:** a resolver that returns "the first configured model" is invisible on a
single-model worker and silently wrong on a multi-model one: the job runs on
the wrong endpoint, one model's credential is sent to another's server, and the
result is billed and attributed to the model named in the spec, which never saw
the question. Nothing errors.

**How to apply:** one selection site (where the lease is accepted), carried
through as data. Prove it with two configured endpoints and two credentials,
leasing the *second* one, then assert the first server was never contacted — a
single-model test passes either way.

# A bound is a failure, not a return value

When a participant hits a turn/token/time ceiling, throw. Never return the text
it had produced so far.

**Why:** a looping model writes confident, answer-shaped prose before it is
stopped. Returned as a value — even with a bracketed "was interrupted" note —
the caller treats it as a completed contribution and publishes it, with
citations, into a research record. Partial text must also not reach the
progress observer, or the host renders half an answer as the answer.

**How to apply:** the ceiling raises a dedicated error; the runner clears any
accumulated text, marks the node failed with a category that says it was a
bound rather than a defect, and the host submits a failure instead of a
completion. Test this end to end with a model that never stops: assert zero
completions, not just that the loop stopped.
