"""Terminal-phase recovery: crash after summary commit, before run completion.

Simulates a worker dying in the interval between persisting run_summaries and
marking the run completed, then exercises the worker's actual lease-recovery
path and verifies the second attempt completes idempotently: one summary, no
duplicate summary events, run completed.
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import select, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import execute_run  # noqa: E402
from app.models import Run, RunEvent, RunSummary, RunTurn  # noqa: E402
from app.seed import seed  # noqa: E402
from app.worker import _recover_expired_leases as recover_expired_leases  # noqa: E402
from tests.test_seed_and_run import _make_demo_run  # noqa: E402


async def test_crash_after_summary_before_completion_recovers(sessionmaker, monkeypatch):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=1, lease_owner="worker-a")  # 3 calls
        run_id = run.id

    # Attempt 1 completes normally...
    await execute_run(sessionmaker, run_id, "worker-a")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        summary_sha = (await db.get(RunSummary, run_id)).summary_sha256
        events_before = (
            await db.execute(
                select(RunEvent.event_type).where(RunEvent.run_id == run_id)
            )
        ).scalars().all()

        # ...then simulate the crash window: summary row exists but the run was
        # never marked completed and its lease has expired (worker died).
        await db.execute(
            text(
                "UPDATE runs SET status = 'running', completed_at = NULL, wall_seconds = 0, "
                "lease_owner = 'worker-a', lease_expires_at = now() - interval '5 minutes' "
                "WHERE id = :rid"
            ),
            {"rid": str(run_id)},
        )
        await db.commit()

    # Real lease recovery requeues the run...
    async with sessionmaker() as db:
        await recover_expired_leases(db)
        status = (
            await db.execute(text("SELECT status FROM runs WHERE id = :rid"), {"rid": str(run_id)})
        ).scalar_one()
        assert status == "queued"
        # Re-lease it to the test worker so the live app worker cannot race us.
        await db.execute(
            text(
                "UPDATE runs SET status = 'leased', lease_owner = 'worker-b', "
                "lease_expires_at = now() + interval '1 hour' WHERE id = :rid"
            ),
            {"rid": str(run_id)},
        )
        await db.commit()

    # ...and the second attempt must finish idempotently, not integrity-error.
    await execute_run(sessionmaker, run_id, "worker-b")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        assert run.completed_at is not None
        # Exactly one summary, unchanged content.
        summaries = (
            await db.execute(select(RunSummary).where(RunSummary.run_id == run_id))
        ).scalars().all()
        assert len(summaries) == 1
        assert summaries[0].summary_sha256 == summary_sha
        # Turns not duplicated.
        turns = (
            await db.execute(select(RunTurn.sequence).where(RunTurn.run_id == run_id))
        ).scalars().all()
        assert sorted(turns) == [0, 1, 2]
        # No duplicate summary event from the recovery attempt.
        events_after = (
            await db.execute(select(RunEvent.event_type).where(RunEvent.run_id == run_id))
        ).scalars().all()
        assert events_after.count("summary.completed") == 1
        assert events_after.count("summary.completed") == list(events_before).count("summary.completed")
        # Recovery emits a second run.completed marker at most once per attempt.
        assert events_after.count("run.completed") <= 2


async def test_terminal_run_is_noop_on_duplicate_reclaim(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=1, lease_owner="worker-a")
        run_id = run.id

    await execute_run(sessionmaker, run_id, "worker-a")
    async with sessionmaker() as db:
        events_before = (
            await db.execute(select(text("count(*)")).select_from(RunEvent).where(RunEvent.run_id == run_id))
        ).scalar_one()

    # A duplicate reclaim of an already-completed run must be a no-op.
    await execute_run(sessionmaker, run_id, "worker-b")
    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        events_after = (
            await db.execute(select(text("count(*)")).select_from(RunEvent).where(RunEvent.run_id == run_id))
        ).scalar_one()
        assert events_after == events_before
