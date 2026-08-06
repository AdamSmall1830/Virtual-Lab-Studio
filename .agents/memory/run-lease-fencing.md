---
name: Run lease fencing
description: How the meeting-run worker keeps two workers from writing the same turn, and why the fence must share the writes' transaction.
---

# Run lease fencing

A meeting run is owned by one worker via a lease (owner + expiry) that a sweeper
reclaims when it goes stale. Three rules keep a second worker from replaying a turn.

## 1. A provider call cannot be bounded by a fixed lease — heartbeat it

Once the provider adapter retries on rate limits, one logical call can span many
timeouts plus backoff. Do **not** widen the lease by a computed worst case: the
estimate is always beatable, and it also delays recovery of genuinely dead workers
by the same amount.

Instead run a background heartbeat task that renews the lease on a timer for the
duration of the call. It must use **its own session** — an `AsyncSession` is not
safe to share across tasks. Transient heartbeat DB errors should be retried, not
fatal, because the fenced commit below is the real authority.

## 2. Renewal must be owner-conditional, and claiming must not steal

Renewal is `WHERE id = :run AND lease_owner = :worker AND lease_expires_at > now()`,
returning rows-affected. An unconditional renewal lets a worker that already lost
the run reassert ownership and resume writing.

The initial claim is the one place ownership changes hands, and it is only allowed
when the run is unowned, already ours, or expired — never from a worker holding a
live lease.

**Why:** a duplicate dispatch, a delayed task, or a direct call would otherwise
produce two live writers for the same run.

## 3. The fence must commit in the same transaction as the writes it protects

Checking ownership and *then* committing is still a race: any stall between the
check and the commit reopens the window. Split renewal into a no-commit
`_fence_lease` (conditional UPDATE) and a committing `_renew_lease`. Before
persisting a turn and its usage counters, run the fence inside that same
transaction — zero rows affected means roll back and abandon. Fence and writes
then land atomically or not at all, and stall duration stops mattering.

**How to apply:** any new write that mutates run state after a provider call needs
the same in-transaction fence, not a preceding check.

## Gotcha: no ORM attribute access after rollback

Building the abandon message from `run.id` after `await db.rollback()` raises
`MissingGreenlet` — rollback expires every attribute, and the implicit reload is
IO that asyncio cannot service from attribute access. Use the plain `run_id`
value (or capture fields before rolling back).

## Testing note

Tests invoke the run executor directly, so their fixtures must lease the run to
the worker id they then execute as — that mirrors the atomic queue claim in
production. To exercise the takeover window, patch the renewal helper to hand the
run to another worker right after the post-call re-assert, then assert no turn row
and no counter movement survive.
