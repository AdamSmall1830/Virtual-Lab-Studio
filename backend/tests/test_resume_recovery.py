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


async def test_interrupted_run_resumes_without_duplicates(sessionmaker, monkeypatch):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=2)  # team, 1 member -> 5 calls
        run_id = run.id

    # Attempt 1: crash after 2 provider calls (mid-round).
    crashing = CrashAfter(get_demo_provider(), crash_after=2)
    monkeypatch.setattr(engine_module, "get_provider", lambda ptype: crashing)
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
    monkeypatch.setattr(engine_module, "get_provider", lambda ptype: get_demo_provider())
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
        run = await _make_demo_run(db, rounds=1)  # 3 calls
        run_id = run.id

    # Crash after 1 call but *during* turn 1: crash_after=1 raises before the
    # provider call, after the turn row was already inserted as 'streaming'.
    crashing = CrashAfter(get_demo_provider(), crash_after=1)
    monkeypatch.setattr(engine_module, "get_provider", lambda ptype: crashing)
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

    monkeypatch.setattr(engine_module, "get_provider", lambda ptype: get_demo_provider())
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
