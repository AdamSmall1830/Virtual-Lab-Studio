"""Deterministic worker-interruption / lease-recovery coverage.

Simulates a worker dying mid-run (provider raises after N calls), then a
second attempt re-executing the same run. The engine must resume from the
persisted turns — never re-inserting a (run_id, sequence) duplicate, never
double-counting usage — and complete the meeting with an intact transcript.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import select, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.engine as engine_module  # noqa: E402
from app.engine import execute_run  # noqa: E402
from app.models import Run, RunEvent, RunTurn  # noqa: E402
from app.providers import get_demo_provider  # noqa: E402
from app.seed import seed  # noqa: E402
from tests.test_seed_and_run import _make_demo_run  # noqa: E402


class CrashAfter:
    """Provider wrapper that raises after N successful calls."""

    def __init__(self, inner, crash_after: int) -> None:
        self.inner = inner
        self.crash_after = crash_after
        self.calls = 0

    async def complete(self, request, **kwargs):
        if self.calls >= self.crash_after:
            raise RuntimeError("simulated worker crash")
        self.calls += 1
        return await self.inner.complete(request, **kwargs)


class LeaseStealer:
    """Simulates the recovery sweeper reclaiming the run while a call is in flight."""

    def __init__(self, inner, sessionmaker, run_id, steal_after: int) -> None:
        self.inner = inner
        self.sessionmaker = sessionmaker
        self.run_id = run_id
        self.steal_after = steal_after
        self.calls = 0

    async def complete(self, request, **kwargs):
        result = await self.inner.complete(request, **kwargs)
        self.calls += 1
        if self.calls == self.steal_after:
            async with self.sessionmaker() as db:
                await db.execute(
                    text(
                        "UPDATE runs SET status = 'queued', lease_owner = NULL, "
                        "lease_expires_at = NULL WHERE id = :rid"
                    ),
                    {"rid": str(self.run_id)},
                )
                await db.commit()
        return result


async def test_takeover_after_recheck_cannot_persist_a_stale_turn(
    sessionmaker, monkeypatch
):
    """The post-call ownership re-check is not enough on its own.

    If another worker takes over in the window between that re-check and the
    commit, the turn's writes must still be rejected — they are fenced inside
    the same transaction that persists them.
    """
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=2, lease_owner="worker-a")
        run_id = run.id

    real_renew = engine_module._renew_lease
    seen = {"renewals": 0}

    async def renew_then_steal(db, rid, worker_id, lease_seconds):
        held = await real_renew(db, rid, worker_id, lease_seconds)
        seen["renewals"] += 1
        # Renewal 1 is the first checkpoint; renewal 2 is the post-call
        # re-assert. Steal immediately after it, before the turn is committed.
        if seen["renewals"] == 2:
            async with sessionmaker() as other:
                await other.execute(
                    text(
                        "UPDATE runs SET lease_owner = 'worker-b', "
                        "lease_expires_at = now() + interval '1 hour' WHERE id = :rid"
                    ),
                    {"rid": str(rid)},
                )
                await other.commit()
        return held

    monkeypatch.setattr(engine_module, "_renew_lease", renew_then_steal)
    await execute_run(sessionmaker, run_id, "worker-a")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.lease_owner == "worker-b", "the new owner must keep the run"
        assert run.status != "failed", "the stale worker must not fail the new owner's run"
        assert run.provider_call_count == 0, "stale usage counters must not land"
        completed = list(
            (
                await db.execute(
                    select(RunTurn).where(
                        RunTurn.run_id == run_id, RunTurn.status == "completed"
                    )
                )
            ).scalars()
        )
        assert completed == [], "no turn may be persisted after losing the lease"


async def test_lost_lease_abandons_attempt_without_clobbering_new_owner(
    sessionmaker, monkeypatch
):
    """A long provider call can outlive the lease; the old worker must not write.

    Otherwise the sweeper requeues the run, a second worker starts it, and both
    workers persist the same turn — duplicate transcript entries and charges.
    """
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=2, lease_owner="worker-a")
        run_id = run.id

    stealer = LeaseStealer(get_demo_provider(), sessionmaker, run_id, steal_after=2)
    monkeypatch.setattr(engine_module, "build_provider", lambda pc, key, pricing=None: stealer)

    # Must return quietly rather than raising or failing the run.
    await execute_run(sessionmaker, run_id, "worker-a")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "queued", "the new owner's requeue must survive"
        assert run.failure_code is None
        completed = list(
            (
                await db.execute(
                    select(RunTurn).where(
                        RunTurn.run_id == run_id, RunTurn.status == "completed"
                    )
                )
            ).scalars()
        )
        # The call that was in flight when the lease was stolen is discarded:
        # only the turn persisted before the steal survives.
        assert len(completed) == 1
        assert completed[0].sequence == 0


async def test_interrupted_run_resumes_without_duplicates(sessionmaker, monkeypatch):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=2, lease_owner="worker-a")  # team, 1 member -> 5 calls
        run_id = run.id

    # Attempt 1: crash after 2 provider calls (mid-round).
    crashing = CrashAfter(get_demo_provider(), crash_after=2)
    monkeypatch.setattr(engine_module, "build_provider", lambda pc, key, pricing=None: crashing)
    with pytest.raises(RuntimeError, match="simulated worker crash"):
        await execute_run(sessionmaker, run_id, "worker-a")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "failed"
        completed_first = run.provider_call_count
        assert completed_first == 2
        first_turns = {
            t.sequence: t.response_sha256
            for t in (
                await db.execute(select(RunTurn).where(RunTurn.run_id == run_id, RunTurn.status == "completed"))
            ).scalars()
        }
        assert set(first_turns) == {0, 1}
        # Requeue as a lease-recovery would (attempt 2 by another worker).
        await db.execute(
            text(
                "UPDATE runs SET status = 'leased', failure_code = NULL, failure_safe_message = NULL, "
                "completed_at = NULL, lease_owner = 'worker-b', "
                "lease_expires_at = now() + interval '1 hour', attempt_count = attempt_count + 1 "
                "WHERE id = :rid"
            ),
            {"rid": str(run_id)},
        )
        await db.commit()

    # Attempt 2: healthy provider resumes and finishes.
    monkeypatch.setattr(engine_module, "build_provider", lambda pc, key, pricing=None: get_demo_provider())
    await execute_run(sessionmaker, run_id, "worker-b")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        turns = list(
            (await db.execute(select(RunTurn).where(RunTurn.run_id == run_id).order_by(RunTurn.sequence))).scalars()
        )
        # team, 2 rounds, 1 member -> 2*(1+1)+1 = 5 unique turns, no duplicates.
        assert [t.sequence for t in turns] == [0, 1, 2, 3, 4]
        assert all(t.status == "completed" for t in turns)
        # Replayed turns kept their original responses (not re-generated).
        for seq, sha in first_turns.items():
            assert turns[seq].response_sha256 == sha
        # Usage counted once per unique provider call.
        assert run.provider_call_count == 5
        events = [
            e.event_type for e in (
                await db.execute(select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.run_sequence))
            ).scalars()
        ]
        assert events.count("run.completed") == 1
        # Only the 3 remaining turns started in attempt 2 (2 replayed silently).
        assert events.count("turn.completed") == 5  # 2 from attempt 1 + 3 from attempt 2


async def test_inflight_streaming_turn_is_reused_not_duplicated(sessionmaker, monkeypatch):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=1, lease_owner="worker-a")  # 3 calls
        run_id = run.id

    # Crash after 1 call but *during* turn 1: crash_after=1 raises before the
    # provider call, after the turn row was already inserted as 'streaming'.
    crashing = CrashAfter(get_demo_provider(), crash_after=1)
    monkeypatch.setattr(engine_module, "build_provider", lambda pc, key, pricing=None: crashing)
    with pytest.raises(RuntimeError):
        await execute_run(sessionmaker, run_id, "worker-a")

    async with sessionmaker() as db:
        stale = list(
            (await db.execute(select(RunTurn).where(RunTurn.run_id == run_id, RunTurn.status != "completed"))).scalars()
        )
        stale_ids = {t.id for t in stale}
        assert stale, "expected an in-flight streaming turn from the crash"
        await db.execute(
            text(
                "UPDATE runs SET status = 'leased', failure_code = NULL, completed_at = NULL, "
                "lease_owner = 'worker-b', lease_expires_at = now() + interval '1 hour' WHERE id = :rid"
            ),
            {"rid": str(run_id)},
        )
        await db.commit()

    monkeypatch.setattr(engine_module, "build_provider", lambda pc, key, pricing=None: get_demo_provider())
    await execute_run(sessionmaker, run_id, "worker-b")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        turns = list(
            (await db.execute(select(RunTurn).where(RunTurn.run_id == run_id).order_by(RunTurn.sequence))).scalars()
        )
        assert [t.sequence for t in turns] == [0, 1, 2]
        assert all(t.status == "completed" for t in turns)
        # The stale streaming row was reused in place, not duplicated.
        assert stale_ids <= {t.id for t in turns}
