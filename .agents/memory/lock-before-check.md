---
name: Guard reads must take the row lock before the check, not before the write
description: Why an unlocked status/quota read followed by an UPDATE silently loses the concurrent write, and where this pattern keeps recurring in this codebase.
---

# Take the lock before the read the decision depends on

Any endpoint shaped *read state → decide → write* must lock the row it reads, at
the moment it reads it. Locking later, or relying on the UPDATE's implicit lock,
does not work.

**Why:** under read-committed, an UPDATE that blocks on another transaction's
lock re-evaluates its `WHERE` clause after that transaction commits — but a
`WHERE id = ...` still matches, so the update proceeds and overwrites the
committed change. The Python-side status check that "protected" it ran against
the stale pre-block read. The check appears to be there, the lock appears to be
there, and the guard still does nothing.

This was found by an adversarial concurrency test, not by review: revoking an
invitation checked `status != "pending"` and then wrote `status = "revoked"`.
Concurrently accepting the same invitation produced a *revoked invitation whose
membership was still live* — access the workspace believed it had withdrawn.
Adding a lock to the accept path alone did not fix it; the revoke path had to
take the lock before its own status read.

**How to apply:**
- `select(...).with_for_update()` first, then check, then write. Never
  `db.get()` → check → mutate on anything another request can transition.
- If the caller loaded the row earlier in the request, refresh the decisive
  columns after taking the lock — the in-session object predates the lock.
- The lock must still be held when the guarded write commits. A guard helper
  that commits, or whose caller commits before inserting, has already released
  it.
- Pick the lock granularity to match what the rule is *about*: a per-member
  spend cap serializes on that membership row, a per-project research gate on
  the project row. Every transition that could invalidate the gate must take the
  same row, or they simply do not contend.

# Test locks by asserting the conflicting call blocks

Hold a transaction open at the point the guard takes its lock, then run the
conflicting operation under `asyncio.wait_for` and assert it times out. Blocking
*is* the guarantee, so the timeout is the assertion rather than a flake. Always
finish by releasing the lock and confirming the operation then completes, so the
test cannot pass because the second operation was simply broken.

Pair it with an outcome-invariant test that runs both operations under
`asyncio.gather` and asserts the forbidden end state is unreachable. The
contention test proves serialization; only the invariant test catches a guard
that serializes correctly and still reaches a wrong answer — which is exactly
what happened here.

# Fixing one instance is not fixing the pattern

When this shape turns up once, sweep every handler in the module before moving
on. The first fix here was the obvious one (revoking an invitation); review then
found the same defect in two paths nobody had thought of — issuing a
*replacement* invitation, which supersedes pending ones and so performs the same
status transition, and patching a pre-registration draft, where a concurrent
registration meant the edit landed on a document that had already been frozen
and hashed.

**Why:** these paths are easy to miss because their *purpose* is something else
entirely (invite someone, edit a draft); the dangerous transition is incidental
to what the endpoint is named after.

**How to apply:** grep the module for every write to the column the guard
protects, not just the endpoint named after it. Ask of each: "if this commits
between another request's check and its write, what breaks?" Any handler that
mutates a status/quota column another handler *reads to decide* belongs in the
same lock discipline.
