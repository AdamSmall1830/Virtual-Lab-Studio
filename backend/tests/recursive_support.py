"""Scaffolding shared by the recursive test suites.

The broker, the provenance record and the hostile-input tests all need the
same thing: a real workspace-consistent meeting with one recursive
participant, a real enrolled worker, and a way to remove both again. Sharing
one copy keeps the three suites describing the same system -- a second,
slightly different scaffold is how a suite ends up proving something about a
world the application never runs in.

Rows are created for real and removed afterwards, because the broker commits
at every state transition and a savepoint would roll the whole story back.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import delete, select, text, update
from sqlalchemy import inspect as sa_inspect

from app.config import get_settings
from app.models import (
    AgentVersion,
    MeetingDefinition,
    MeetingDefinitionAgent,
    Project,
    RecursiveAgentJob,
    RecursiveAgentNode,
    RecursiveWorker,
    Run,
    RunEvent,
    RunTurn,
)
from app.recursive import tokens

PROXY = "http://localhost:80"
PEPPER = "recursive-test-pepper-" + "z" * 32


@dataclass
class Planned:
    """Stand-in for engine.PlannedTurn; the broker only reads these fields."""

    call_index: int = 0
    round_number: int = 1
    is_final: bool = True
    role_type: str = "lead"
    agent_position: int = 0
    position_in_round: int = 0


@pytest.fixture()
def recursive_settings(monkeypatch):
    """Turn the feature on for this test only, through the real config path."""
    monkeypatch.setenv("RECURSIVE_AGENTS_ENABLED", "true")
    monkeypatch.setenv("RECURSIVE_AGENTS_ALLOW_FAKE_WORKER", "true")
    monkeypatch.setenv("RECURSIVE_WORKER_TOKEN_PEPPER", PEPPER)
    monkeypatch.setenv("APP_ENV", "development")
    get_settings.cache_clear()
    try:
        yield get_settings()
    finally:
        get_settings.cache_clear()


def catalog(model_key: str) -> list[dict]:
    return [
        {
            "model_key": model_key,
            "display_name": "Test coordinator",
            "provider_kind": "ollama",
            "context_window": 32_000,
            "supports_recursive_agents": True,
            "supports_tools": True,
            "pricing": {
                "input_usd_per_1m": 0.0,
                "cached_input_usd_per_1m": 0.0,
                "output_usd_per_1m": 0.0,
            },
        }
    ]


def capabilities() -> dict:
    return {
        "sandbox_mode": "process",
        "supports_recursive_agents": True,
        "supports_python": True,
        "supports_evidence_search": True,
        "allow_web": False,
        "max_children": 8,
        "max_depth": 2,
        "profiles": ["research_read_only"],
    }


async def scaffold(
    db,
    *,
    model_key: str,
    adapter_version: str = "test",
    display_name: str | None = None,
    evidence: list[dict] | None = None,
):
    """A workspace-consistent definition with one recursive participant."""
    project = (await db.execute(select(Project).limit(1))).scalars().first()
    version = (await db.execute(select(AgentVersion).limit(1))).scalars().first()
    if project is None or version is None:
        pytest.skip("development database has no project or agent version")

    minted = tokens.mint(tokens.WORKER_PREFIX)
    worker = RecursiveWorker(
        workspace_id=project.workspace_id,
        display_name=display_name or f"broker-test-{uuid.uuid4().hex[:8]}",
        status="online",
        enabled=True,
        token_prefix=minted.prefix,
        token_hash=minted.token_hash,
        adapter_version=adapter_version,
        prime_agent_version="test",
        sandbox_mode="process",
        capabilities=capabilities(),
        model_catalog=catalog(model_key),
        last_seen_at=datetime.now(UTC),
    )
    db.add(worker)
    await db.flush()

    definition_json = {
        "title": "Recursive broker test",
        "meeting_type": "team",
        "agenda": "Prove the broker moves a turn through an external worker.",
        "questions": ["Does the lease hold?"],
        "rules": [],
        "contexts": [],
        "rounds": 1,
        "agents": [],
        "evidence": evidence or [],
        "schema_version": "1.0",
    }
    definition = MeetingDefinition(
        workspace_id=project.workspace_id,
        project_id=project.id,
        title=definition_json["title"],
        meeting_type="team",
        agenda=definition_json["agenda"],
        questions=definition_json["questions"],
        rules=[],
        contexts=[],
        rounds=1,
        default_temperature=Decimal("0.200"),
        budget={},
        definition_json=definition_json,
        definition_sha256=uuid.uuid4().hex * 2,
        created_by=project.created_by,
    )
    db.add(definition)
    await db.flush()

    da = MeetingDefinitionAgent(
        meeting_definition_id=definition.id,
        position=0,
        role_type="lead",
        agent_version_id=version.id,
        execution_mode="recursive_rlm",
        recursive_worker_id=worker.id,
        recursive_model_key=model_key,
        recursive_execution_config={
            "schema_version": "1.0",
            "capability_profile": "research_read_only",
            "coordinator_model_key": model_key,
            "child_model_key": None,
            "allowed_skill_ids": ["vls_evidence"],
            "max_children": 3,
            "max_depth": 1,
            "max_agent_turns": 8,
            "max_tokens": 32_000,
            "max_runtime_seconds": 900,
            "max_cost_usd": 2.0,
        },
        tool_definition_ids=[],
    )
    db.add(da)

    run = Run(
        workspace_id=project.workspace_id,
        project_id=project.id,
        meeting_definition_id=definition.id,
        status="running",
        demo_mode=False,
        created_by=project.created_by,
        lease_owner="broker-test",
        lease_expires_at=datetime.now(UTC) + timedelta(minutes=10),
    )
    db.add(run)
    await db.commit()
    return worker, definition, da, run, version


def pk(obj):
    """The primary key of a possibly-expired object, without triggering IO."""
    return sa_inspect(obj).identity[0]


async def cleanup(db, worker, definition, run):
    # Read the keys off the identity map and end whatever transaction the test
    # left behind: a failing test may have rolled back, and every attribute of
    # these objects would then be a lazy load that cannot run here.
    worker_id, definition_id, run_id = pk(worker), pk(definition), pk(run)
    await db.rollback()
    # Take the run terminal first. The development server's worker polls this
    # same database, and a run left queued would be picked up and executed
    # against a scaffolded definition while we are deleting it.
    await db.execute(
        update(Run)
        .where(Run.id == run_id)
        .values(status="cancelled", lease_owner=None, lease_expires_at=None)
    )
    await db.commit()
    await db.execute(delete(RecursiveAgentNode).where(
        RecursiveAgentNode.job_id.in_(
            select(RecursiveAgentJob.id).where(RecursiveAgentJob.run_id == run_id)
        )
    ))
    await db.execute(text(
        "DELETE FROM recursive_job_events WHERE job_id IN "
        "(SELECT id FROM recursive_agent_jobs WHERE run_id = :r)"
    ), {"r": run_id})
    await db.execute(delete(RecursiveAgentJob).where(RecursiveAgentJob.run_id == run_id))
    await db.execute(delete(RunEvent).where(RunEvent.run_id == run_id))
    await db.execute(delete(RunTurn).where(RunTurn.run_id == run_id))
    await db.execute(text("DELETE FROM run_citations WHERE run_id = :r"), {"r": run_id})
    await db.execute(text("DELETE FROM run_summaries WHERE run_id = :r"), {"r": run_id})
    await db.execute(text("DELETE FROM run_manifests WHERE run_id = :r"), {"r": run_id})
    await db.execute(delete(Run).where(Run.id == run_id))
    await db.execute(delete(MeetingDefinitionAgent).where(
        MeetingDefinitionAgent.meeting_definition_id == definition_id
    ))
    await db.execute(delete(MeetingDefinition).where(MeetingDefinition.id == definition_id))
    await db.execute(delete(RecursiveWorker).where(RecursiveWorker.id == worker_id))
    await db.commit()
