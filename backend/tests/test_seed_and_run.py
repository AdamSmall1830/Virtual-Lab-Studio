"""Integration tests against the development database.

- seed runs twice without duplicates
- launching a demo meeting executes asynchronously with live events,
  pause/resume and cancel honored at checkpoints

Requires DATABASE_URL (Replit development database) with migrations applied.
"""
from __future__ import annotations

import asyncio
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import func, select, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import execute_run  # noqa: E402
from app.models import (  # noqa: E402
    AgentProfile,
    AgentVersion,
    MeetingDefinition,
    MeetingDefinitionAgent,
    ProviderConfig,
    ProviderModel,
    Project,
    Run,
    RunEvent,
    RunSummary,
    RunTurn,
    TemplateProfile,
    Workspace,
)
from app.seed import seed  # noqa: E402
from app.engine import canonical_json, sha256_text  # noqa: E402


async def _counts(db) -> dict[str, int]:
    out = {}
    for name, model in {
        "agents": AgentProfile, "agent_versions": AgentVersion,
        "templates": TemplateProfile, "workspaces": Workspace, "projects": Project,
        "providers": ProviderConfig, "models": ProviderModel,
    }.items():
        out[name] = (await db.execute(select(func.count()).select_from(model))).scalar_one()
    return out


async def test_seed_is_idempotent(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        before = await _counts(db)
    async with sessionmaker() as db:
        await seed(db)
        after = await _counts(db)
    assert before == after
    assert after["agents"] >= 12
    assert after["templates"] >= 10


async def _make_demo_run(db, rounds: int = 1, budget: dict | None = None) -> Run:
    workspace = (await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))).scalar_one()
    project = (
        await db.execute(select(Project).where(Project.workspace_id == workspace.id).limit(1))
    ).scalar_one()
    provider = (
        await db.execute(
            select(ProviderConfig).where(
                ProviderConfig.workspace_id == workspace.id, ProviderConfig.provider_type == "demo"
            )
        )
    ).scalar_one()
    model = (
        await db.execute(select(ProviderModel).where(ProviderModel.provider_config_id == provider.id))
    ).scalar_one()

    async def version_for(slug: str) -> AgentVersion:
        profile = (
            await db.execute(
                select(AgentProfile).where(AgentProfile.workspace_id.is_(None), AgentProfile.slug == slug)
            )
        ).scalar_one()
        return (
            await db.execute(
                select(AgentVersion).where(AgentVersion.agent_profile_id == profile.id)
                .order_by(AgentVersion.version_number.desc()).limit(1)
            )
        ).scalar_one()

    lead = await version_for("principal-investigator")
    member = await version_for("scientific-critic")

    definition_json = {"test": str(uuid.uuid4())}
    definition = MeetingDefinition(
        workspace_id=workspace.id, project_id=project.id, title="Test run",
        meeting_type="team", agenda="Test agenda", questions=["Q1"], rules=[],
        contexts=[], rounds=rounds, default_temperature=0.2,
        budget=budget or {"max_provider_calls": 50, "max_cost_usd": 5},
        definition_json=definition_json,
        definition_sha256=sha256_text(canonical_json(definition_json)),
    )
    db.add(definition)
    await db.flush()
    db.add(MeetingDefinitionAgent(
        meeting_definition_id=definition.id, position=0, role_type="lead",
        agent_version_id=lead.id, provider_config_id=provider.id, provider_model_id=model.id,
    ))
    db.add(MeetingDefinitionAgent(
        meeting_definition_id=definition.id, position=1, role_type="member",
        agent_version_id=member.id, provider_config_id=provider.id, provider_model_id=model.id,
    ))
    # Lease the run to the test worker with a far-future expiry so the live
    # application worker (polling the same development database) cannot claim
    # it concurrently — that race caused duplicate (run_id, sequence) inserts.
    run = Run(
        workspace_id=workspace.id, project_id=project.id,
        meeting_definition_id=definition.id, status="leased", demo_mode=True,
        lease_owner="test-worker",
        lease_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    db.add(run)
    await db.commit()
    return run


async def test_demo_run_executes_with_events_and_summary(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=1)
        run_id = run.id

    await execute_run(sessionmaker, run_id, "test-worker")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        # team, 1 round, 1 member -> 1*(1+1)+1 = 3 calls
        assert run.provider_call_count == 3
        turns = list(
            (await db.execute(select(RunTurn).where(RunTurn.run_id == run_id).order_by(RunTurn.sequence))).scalars()
        )
        assert [t.role_type for t in turns] == ["lead", "member", "lead"]
        assert all(t.status == "completed" and t.response_text for t in turns)
        events = list(
            (await db.execute(select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.run_sequence))).scalars()
        )
        types = [e.event_type for e in events]
        for expected in ("run.validating", "run.started", "round.started", "turn.started",
                         "turn.delta", "turn.completed", "usage.updated",
                         "summary.completed", "run.completed"):
            assert expected in types, f"missing event {expected}"
        seqs = [e.run_sequence for e in events]
        assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
        summary = await db.get(RunSummary, run_id)
        assert summary is not None
        assert summary.validation_status == "valid"
        assert "Simulation" in summary.summary_markdown or "simulated" in summary.summary_markdown


async def test_pause_resume_and_cancel(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=2)
        run_id = run.id
        # Request pause before execution starts: engine honors it at first checkpoint.
        run = await db.get(Run, run_id)
        run.control_requested = "pause"
        await db.commit()

    task = asyncio.create_task(execute_run(sessionmaker, run_id, "test-worker"))
    try:
        # Wait for the run to pause.
        for _ in range(100):
            await asyncio.sleep(0.1)
            async with sessionmaker() as db:
                status = (
                    await db.execute(text("SELECT status FROM runs WHERE id = :rid"), {"rid": str(run_id)})
                ).scalar_one()
            if status == "paused":
                break
        assert status == "paused"
        # Resume.
        async with sessionmaker() as db:
            await db.execute(
                text("UPDATE runs SET control_requested = 'resume' WHERE id = :rid"), {"rid": str(run_id)}
            )
            await db.commit()
        # Wait until the engine actually resumed before requesting cancel,
        # otherwise the cancel overwrites the un-consumed resume request.
        for _ in range(100):
            await asyncio.sleep(0.1)
            async with sessionmaker() as db:
                status = (
                    await db.execute(text("SELECT status FROM runs WHERE id = :rid"), {"rid": str(run_id)})
                ).scalar_one()
            if status != "paused":
                break
        # Then cancel at a later checkpoint (run may already be finishing).
        async with sessionmaker() as db:
            await db.execute(
                text("UPDATE runs SET control_requested = 'cancel' WHERE id = :rid"), {"rid": str(run_id)}
            )
            await db.commit()
        await asyncio.wait_for(task, timeout=30)
    finally:
        if not task.done():
            task.cancel()

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status in {"cancelled", "completed"}
        events = [
            e.event_type for e in (
                await db.execute(select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.run_sequence))
            ).scalars()
        ]
        assert "run.paused" in events
        assert "run.resumed" in events
        if run.status == "cancelled":
            assert "run.cancelled" in events


async def test_budget_stop(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db, rounds=2, budget={"max_provider_calls": 2, "max_cost_usd": 5})
        run_id = run.id
    await execute_run(sessionmaker, run_id, "test-worker")
    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "budget_stopped"
        assert run.failure_code == "budget_exceeded"
        assert run.provider_call_count == 2
