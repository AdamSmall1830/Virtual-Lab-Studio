"""Retry endpoint: a run that stopped early resumes from its saved transcript.

The engine already replays completed turns out of the database instead of
re-calling the provider (durable resume after a lease expiry or a worker
restart). These tests pin the API contract that lets a *user* reach that path
once a run has gone terminal: requeueing a stopped run must charge only for the
turns that are still missing, must not duplicate the ones already persisted,
and must drop the summary/manifest written at the stop so they are rebuilt over
the finished transcript rather than a truncated prefix.
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.api.v1 as v1_module  # noqa: E402
import app.engine as engine_module  # noqa: E402
from app.api.v1 import cancel_run, retry_run  # noqa: E402
from app.engine import execute_run  # noqa: E402
from app.models import (  # noqa: E402
    Run,
    RunEvent,
    RunManifest,
    RunSummary,
    RunTurn,
    User,
    WorkspaceMembership,
)
from app.providers import get_demo_provider  # noqa: E402
from app.seed import seed  # noqa: E402
from tests.test_resume_recovery import CrashAfter  # noqa: E402
from tests.test_seed_and_run import _make_demo_run  # noqa: E402


class CountingProvider:
    """Demo provider that records how many calls actually reach it."""

    def __init__(self) -> None:
        self.inner = get_demo_provider()
        self.calls = 0

    async def complete(self, request, **kwargs):
        self.calls += 1
        return await self.inner.complete(request, **kwargs)


async def _member_of(db, workspace_id) -> User:
    """A user with write access to the run's workspace."""
    user = User(
        auth_provider="dev",
        auth_subject=f"retry-{uuid.uuid4()}",
        email=f"retry-{uuid.uuid4().hex[:8]}@test.dev",
        display_name="Retry Tester",
    )
    db.add(user)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=workspace_id, user_id=user.id, role="owner"))
    await db.commit()
    return user


async def _completed_turns(db, run_id) -> dict[int, RunTurn]:
    rows = (
        await db.execute(
            select(RunTurn)
            .where(RunTurn.run_id == run_id, RunTurn.status == "completed")
            .order_by(RunTurn.sequence)
        )
    ).scalars()
    return {t.sequence: t for t in rows}


async def test_retry_resumes_without_repaying_for_completed_turns(sessionmaker, monkeypatch):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=2, lease_owner="worker-a")
        run_id, workspace_id = run.id, run.workspace_id

    # Crash after two calls: a terminal, unfinished run with real turns behind it.
    monkeypatch.setattr(
        engine_module, "build_provider",
        lambda pc, key, pricing=None: CrashAfter(get_demo_provider(), 2),
    )
    with pytest.raises(RuntimeError, match="simulated worker crash"):
        await execute_run(sessionmaker, run_id, "worker-a")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "failed", f"expected a failed run, got {run.status}"
        calls_before = run.provider_call_count
        assert calls_before == 2
        turns_before = {
            seq: (t.response_text, t.completed_at) for seq, t in (await _completed_turns(db, run_id)).items()
        }
        assert len(turns_before) == 2
        # The stop wrote terminal artefacts describing only that prefix.
        assert await db.get(RunSummary, run_id) is not None
        user = await _member_of(db, workspace_id)

    async with sessionmaker() as db:
        out = await retry_run(run_id, user, db)
        assert out.status == "queued"
        assert out.failure_code is None
        assert out.completed_at is None

    async with sessionmaker() as db:
        assert await db.get(RunSummary, run_id) is None, "stale summary must be dropped"
        assert await db.get(RunManifest, run_id) is None, "stale manifest must be dropped"

    # Second attempt: only the turns that never completed may hit the provider.
    counting = CountingProvider()
    monkeypatch.setattr(engine_module, "build_provider", lambda pc, key, pricing=None: counting)
    await execute_run(sessionmaker, run_id, "worker-b")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed", f"resumed run did not finish: {run.status}"

        total_planned = run.provider_call_count
        assert counting.calls == total_planned - calls_before, (
            f"resume made {counting.calls} provider calls; "
            f"only {total_planned - calls_before} were still missing"
        )

        turns_after = await _completed_turns(db, run_id)
        sequences = [t.sequence for t in turns_after.values()]
        assert len(sequences) == len(set(sequences)), "resume duplicated turn rows"

        for sequence, (text_before, completed_before) in turns_before.items():
            after = turns_after[sequence]
            assert after.completed_at == completed_before, f"turn {sequence} was re-run"
            assert after.response_text == text_before, f"turn {sequence} text changed"

        # Rebuilt over the whole transcript, not the prefix left at the stop.
        assert await db.get(RunSummary, run_id) is not None
        assert await db.get(RunManifest, run_id) is not None


async def test_retry_during_terminal_finalization_wins_over_the_stale_attempt(
    sessionmaker, monkeypatch
):
    """The worker writes a stopped run's artifacts after committing its status.

    A retry landing in that window used to leave the abandoned attempt's summary
    attached to the run — and because the completion path reuses any summary it
    finds, the resumed run would finish carrying a summary of its own truncated
    prefix. Both sides now take the run's row lock, so the requeue wins and the
    stale attempt writes nothing.
    """
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=2, lease_owner="worker-a")
        run_id, workspace_id = run.id, run.workspace_id
        user = await _member_of(db, workspace_id)

    real_ensure = engine_module.ensure_manifest_safe

    async def retry_then_finalize(db, run):
        # The user hits retry after the terminal status is committed but before
        # the summary/manifest for that attempt are written.
        async with sessionmaker() as other:
            await retry_run(run_id, user, other)
        return await real_ensure(db, run)

    monkeypatch.setattr(engine_module, "ensure_manifest_safe", retry_then_finalize)
    monkeypatch.setattr(
        engine_module, "build_provider",
        lambda pc, key, pricing=None: CrashAfter(get_demo_provider(), 2),
    )
    with pytest.raises(RuntimeError, match="simulated worker crash"):
        await execute_run(sessionmaker, run_id, "worker-a")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "queued", "the requeue must survive the stale finalizer"
        assert await db.get(RunSummary, run_id) is None, "stale summary landed on a live run"
        assert await db.get(RunManifest, run_id) is None, "stale manifest landed on a live run"

    # The resumed run must finish with a summary of the whole meeting, not the
    # terminal-outcome placeholder the failed attempt would have left behind.
    monkeypatch.setattr(engine_module, "ensure_manifest_safe", real_ensure)
    monkeypatch.setattr(
        engine_module, "build_provider", lambda pc, key, pricing=None: CountingProvider()
    )
    await execute_run(sessionmaker, run_id, "worker-b")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        summary = await db.get(RunSummary, run_id)
        assert summary is not None
        assert "No scientific conclusions were produced" not in (
            summary.summary_json.get("executive_summary", "")
        ), "the resumed run inherited the failed attempt's terminal summary"


async def test_retry_during_direct_cancel_does_not_announce_a_missing_manifest(
    sessionmaker, monkeypatch
):
    """Cancelling a queued run finalizes it from its own session, not the worker.

    That path commits the cancellation and then builds the manifest separately,
    so it has the same window as the worker: a retry can land in between. It
    must read the skip signal rather than announcing a manifest that was never
    written.
    """
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=1, lease_owner=None)
        run.status = "queued"
        await db.commit()
        run_id, workspace_id = run.id, run.workspace_id
        user = await _member_of(db, workspace_id)

    real_ensure = v1_module.ensure_manifest_safe

    async def retry_then_finalize(db, run):
        async with sessionmaker() as other:
            await retry_run(run_id, user, other)
        return await real_ensure(db, run)

    monkeypatch.setattr(v1_module, "ensure_manifest_safe", retry_then_finalize)
    # The direct-cancel path finalizes through the app-global sessionmaker,
    # whose engine is bound to whichever event loop created it first. Pin it to
    # this test's loop-local one.
    monkeypatch.setattr(v1_module, "get_sessionmaker", lambda: sessionmaker)
    async with sessionmaker() as db:
        await cancel_run(run_id, user, db)

    async with sessionmaker() as db:
        assert await db.get(RunManifest, run_id) is None, "no manifest should exist"
        events = list(
            (
                await db.execute(
                    select(RunEvent.event_type).where(RunEvent.run_id == run_id)
                )
            ).scalars()
        )
        assert "manifest.created" not in events, (
            "cancel announced a manifest that was never written"
        )


async def test_retry_is_refused_once_a_run_has_finished(sessionmaker, monkeypatch):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=1, lease_owner="worker-a")
        run_id, workspace_id = run.id, run.workspace_id

    monkeypatch.setattr(
        engine_module, "build_provider", lambda pc, key, pricing=None: get_demo_provider()
    )
    await execute_run(sessionmaker, run_id, "worker-a")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        user = await _member_of(db, workspace_id)

        with pytest.raises(HTTPException) as exc:
            await retry_run(run_id, user, db)
        assert exc.value.status_code == 409
