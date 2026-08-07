"""The recursive job lifecycle, end to end against the real database.

Covers the promises the broker exists to keep:

* a parked run holds no lease, so the native worker cannot execute the turn
  while an external one owns it;
* a result is only accepted from the worker that holds a live lease, and only
  when it echoes back the exact request it was handed;
* a replayed completion is recognised rather than double-counted;
* nothing labelled as real analysis is produced by the simulator.

Rows are created for real and removed afterwards, because the broker commits
at every state transition and a savepoint would roll the whole story back.
"""
from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
import uuid
import zipfile
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
from app.recursive import broker, bundle, fake_worker, policy, tokens
from app.schemas import RecursiveExecutionConfigIn

PROXY = "http://localhost:80"
PEPPER = "recursive-test-pepper-" + "z" * 32


@dataclass
class _Planned:
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


def _catalog(model_key: str) -> list[dict]:
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


def _capabilities() -> dict:
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


async def _scaffold(
    db, *, model_key: str, adapter_version: str = "test", display_name: str | None = None
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
        capabilities=_capabilities(),
        model_catalog=_catalog(model_key),
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
        "evidence": [],
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


def _pk(obj):
    """The primary key of a possibly-expired object, without triggering IO."""
    return sa_inspect(obj).identity[0]


async def _cleanup(db, worker, definition, run):
    # Read the keys off the identity map and end whatever transaction the test
    # left behind: a failing test may have rolled back, and every attribute of
    # these objects would then be a lazy load that cannot run here.
    worker_id, definition_id, run_id = _pk(worker), _pk(definition), _pk(run)
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


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------


def test_worker_credentials_round_trip_and_reject_near_misses(recursive_settings):
    minted = tokens.mint(tokens.WORKER_PREFIX)
    parsed = tokens.parse(tokens.WORKER_PREFIX, minted.raw)
    assert parsed is not None
    prefix, secret = parsed
    assert prefix == minted.prefix
    assert tokens.verify(tokens.WORKER_PREFIX, secret, minted.token_hash)

    # The secret itself is never recoverable from what is stored.
    assert secret not in minted.token_hash
    assert minted.token_hash.startswith("v1:")

    # A worker secret must not authenticate as an enrollment token: the two
    # kinds are hashed under separately derived keys.
    assert not tokens.verify(tokens.ENROLLMENT_PREFIX, secret, minted.token_hash)
    assert tokens.parse(tokens.ENROLLMENT_PREFIX, minted.raw) is None

    assert not tokens.verify(tokens.WORKER_PREFIX, secret + "a", minted.token_hash)
    assert tokens.parse(tokens.WORKER_PREFIX, "rwk_nothex_secret") is None
    assert tokens.parse(tokens.WORKER_PREFIX, "rwk_" + minted.prefix) is None
    assert tokens.parse(tokens.WORKER_PREFIX, None) is None


def test_limits_are_refused_not_silently_clamped(recursive_settings):
    """A researcher must never receive a narrower experiment without being told."""
    worker = RecursiveWorker(
        workspace_id=uuid.uuid4(),
        display_name="capped",
        status="online",
        enabled=True,
        token_prefix="0" * 12,
        token_hash="v1:x",
        capabilities={**_capabilities(), "max_children": 2, "max_depth": 1},
        model_catalog=_catalog("m/k"),
        last_seen_at=datetime.now(UTC),
    )
    config = RecursiveExecutionConfigIn(
        requested_worker_id=uuid.uuid4(),
        coordinator_model_key="m/k",
        max_children=8,
        max_depth=2,
    )
    limits, errors = policy.resolve_limits(config, recursive_settings, worker)
    assert errors, "an over-limit request produced no error"
    assert any("2 child agents" in e for e in errors)
    assert any("maximum depth of 1" in e for e in errors)
    # The clamped values exist so a caller that ignores errors cannot exceed
    # the ceiling, but the errors are what stop the launch.
    assert limits.max_children == 2
    assert limits.max_depth == 1


def test_a_stale_worker_is_not_online(recursive_settings):
    worker = RecursiveWorker(
        workspace_id=uuid.uuid4(),
        display_name="stale",
        status="online",  # left behind by a machine that lost power
        enabled=True,
        token_prefix="0" * 12,
        token_hash="v1:x",
        capabilities=_capabilities(),
        model_catalog=_catalog("m/k"),
        last_seen_at=datetime.now(UTC) - timedelta(hours=1),
    )
    assert not policy.worker_is_online(worker, recursive_settings)
    config = RecursiveExecutionConfigIn(
        requested_worker_id=uuid.uuid4(), coordinator_model_key="m/k"
    )
    assert any(
        "not online" in e for e in policy.check_worker_eligibility(config, recursive_settings, worker)
    )


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


async def test_dispatch_parks_the_run_and_releases_its_lease(sessionmaker, recursive_settings):
    model_key = "ollama/test-coordinator"
    async with sessionmaker() as db:
        worker, definition, da, run, version = await _scaffold(db, model_key=model_key)
        try:
            parked = await broker.dispatch_or_resume_recursive_turn(
                db,
                run=run,
                definition=definition,
                planned=_Planned(),
                da=da,
                av=version,
                agent_title="Test Lead",
                messages=[{"role": "user", "content": "Open the meeting."}],
                prompt="Give your opening statement.",
                worker_id="broker-test",
            )
            assert parked is True

            await db.refresh(run)
            assert run.status == "waiting_external"
            # The decisive property: the native worker no longer owns the run,
            # so it cannot execute this turn behind the external worker's back.
            assert run.lease_owner is None
            assert run.lease_expires_at is None

            job = await broker.active_job_for_run(db, run.id)
            assert job is not None
            assert job.status == "queued"
            assert job.model_key == model_key
            assert job.request_sha256

            # Dispatching again must find the same job, not queue a second one.
            again = await broker.dispatch_or_resume_recursive_turn(
                db,
                run=run,
                definition=definition,
                planned=_Planned(),
                da=da,
                av=version,
                agent_title="Test Lead",
                messages=[{"role": "user", "content": "Open the meeting."}],
                prompt="Give your opening statement.",
                worker_id="broker-test",
            )
            assert again is True
            jobs = (
                await db.execute(
                    select(RecursiveAgentJob).where(RecursiveAgentJob.run_id == run.id)
                )
            ).scalars().all()
            assert len(jobs) == 1
        finally:
            await _cleanup(db, worker, definition, run)


async def test_the_bundle_carries_the_brief_and_no_credentials(sessionmaker, recursive_settings):
    model_key = "ollama/test-coordinator"
    async with sessionmaker() as db:
        worker, definition, da, run, version = await _scaffold(db, model_key=model_key)
        try:
            await broker.dispatch_or_resume_recursive_turn(
                db, run=run, definition=definition, planned=_Planned(), da=da, av=version,
                agent_title="Test Lead", messages=[], prompt="Open the meeting.",
                worker_id="broker-test",
            )
            job = await broker.active_job_for_run(db, run.id)
            data = await bundle.build_bundle(db, job, definition)
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                names = set(zf.namelist())
                assert {"request.json", "task.md", "evidence-manifest.json"} <= names
                request = json.loads(zf.read("request.json"))
                task = zf.read("task.md").decode()
            assert request["execution"]["allow_web"] is False
            assert request["execution"]["coordinator_model_key"] == model_key
            assert "Open the meeting." in task
            # A bundle is written to the operator's disk. Nothing in it may be
            # a credential, and the worker's own token is the obvious hazard.
            blob = data.decode("latin-1")
            assert worker.token_prefix not in blob
            assert "token_hash" not in blob
            assert PEPPER not in blob
        finally:
            await _cleanup(db, worker, definition, run)


async def test_the_full_turn_completes_and_requeues_the_run(sessionmaker, recursive_settings):
    """Lease, stream events, complete -- and the meeting carries on."""
    model_key = fake_worker.FAKE_MODEL_KEY
    async with sessionmaker() as db:
        worker, definition, da, run, version = await _scaffold(
            db,
            model_key=model_key,
            adapter_version="simulated",
            display_name=fake_worker.FAKE_WORKER_NAME,
        )
        try:
            await broker.dispatch_or_resume_recursive_turn(
                db, run=run, definition=definition, planned=_Planned(), da=da, av=version,
                agent_title="Test Lead", messages=[], prompt="Open the meeting.",
                worker_id="broker-test",
            )
            job_id = (await broker.active_job_for_run(db, run.id)).id

            finished = await fake_worker.run_once(db, run.workspace_id)
            assert finished == job_id, "the simulator did not pick up the queued job"

            job = await db.get(RecursiveAgentJob, job_id)
            await db.refresh(job)
            assert job.status == "completed"
            assert job.result_sha256
            assert job.completed_at is not None

            # The run goes back to the native queue so the engine resumes.
            # The development server runs its own worker against this same
            # database and polls every second, so it may already have claimed
            # the run by the time we look. What must hold either way is that
            # the run is no longer parked on an external worker.
            await db.refresh(run)
            assert run.status != "waiting_external"
            assert run.status == "queued" or run.lease_owner is not None

            turn = (
                await db.execute(select(RunTurn).where(RunTurn.run_id == run.id))
            ).scalars().one()
            assert turn.status == "completed"
            assert turn.execution_mode == "recursive_rlm"
            # Truthful labelling is the point of the simulator, not a detail.
            assert "SIMULATED" in turn.response_text

            nodes = (
                await db.execute(
                    select(RecursiveAgentNode).where(RecursiveAgentNode.job_id == job_id)
                )
            ).scalars().all()
            assert len(nodes) >= 2
            assert any(n.parent_external_node_id == "root" for n in nodes)
            assert run.recursive_agent_node_count == len(nodes)
        finally:
            await _cleanup(db, worker, definition, run)


async def test_a_result_from_the_wrong_worker_is_refused(sessionmaker, recursive_settings):
    model_key = fake_worker.FAKE_MODEL_KEY
    async with sessionmaker() as db:
        worker, definition, da, run, version = await _scaffold(
            db, model_key=model_key, adapter_version="simulated"
        )
        other = RecursiveWorker(
            workspace_id=run.workspace_id,
            display_name=f"impostor-{uuid.uuid4().hex[:8]}",
            status="online",
            enabled=True,
            token_prefix=tokens.mint(tokens.WORKER_PREFIX).prefix,
            token_hash="v1:x",
            capabilities=_capabilities(),
            model_catalog=_catalog(model_key),
            last_seen_at=datetime.now(UTC),
        )
        db.add(other)
        await db.commit()
        try:
            await broker.dispatch_or_resume_recursive_turn(
                db, run=run, definition=definition, planned=_Planned(), da=da, av=version,
                agent_title="Test Lead", messages=[], prompt="Open the meeting.",
                worker_id="broker-test",
            )
            job = await broker.active_job_for_run(db, run.id)
            leased = await broker.lease_next_job(
                db, worker, supported_profiles=["research_read_only"],
                model_keys=[model_key], settings=recursive_settings,
            )
            assert leased is not None and leased.id == job.id

            result = fake_worker._build_result(leased, recursive_settings)
            with pytest.raises(broker.JobRejected) as caught:
                await broker.complete_job(db, leased.id, other, result)
            assert caught.value.status_code in (403, 404, 409)

            # And a right worker with the wrong request hash is refused too.
            forged = result.model_copy(update={"request_sha256": "0" * 64})
            with pytest.raises(broker.JobRejected):
                await broker.complete_job(db, leased.id, worker, forged)

            await db.refresh(leased)
            assert leased.status not in broker.TERMINAL_JOB_STATUSES
        finally:
            await db.execute(delete(RecursiveWorker).where(RecursiveWorker.id == other.id))
            await db.commit()
            await _cleanup(db, worker, definition, run)


async def test_a_replayed_completion_is_recognised_not_double_counted(
    sessionmaker, recursive_settings
):
    model_key = fake_worker.FAKE_MODEL_KEY
    async with sessionmaker() as db:
        worker, definition, da, run, version = await _scaffold(
            db, model_key=model_key, adapter_version="simulated"
        )
        try:
            await broker.dispatch_or_resume_recursive_turn(
                db, run=run, definition=definition, planned=_Planned(), da=da, av=version,
                agent_title="Test Lead", messages=[], prompt="Open the meeting.",
                worker_id="broker-test",
            )
            job = await broker.active_job_for_run(db, run.id)
            leased = await broker.lease_next_job(
                db, worker, supported_profiles=["research_read_only"],
                model_keys=[model_key], settings=recursive_settings,
            )
            result = fake_worker._build_result(leased, recursive_settings)

            outcome, _ = await broker.complete_job(db, leased.id, worker, result)
            assert outcome == "accepted"
            await db.refresh(run)
            first_calls = run.provider_call_count

            # A worker that never saw the acknowledgement retries.
            outcome, _ = await broker.complete_job(db, leased.id, worker, result)
            assert outcome == "duplicate"

            await db.refresh(run)
            assert run.provider_call_count == first_calls, "usage was counted twice"
            turns = (
                await db.execute(select(RunTurn).where(RunTurn.run_id == run.id))
            ).scalars().all()
            assert len(turns) == 1
        finally:
            await _cleanup(db, worker, definition, run)


async def test_a_result_arriving_after_cancellation_does_not_overturn_it(
    sessionmaker, recursive_settings
):
    """The researcher's cancellation wins the race against a finishing worker.

    This deployment never dials out to the operator's machine -- a worker only
    learns of a cancellation on its next heartbeat. A result uploaded inside
    that window must not enter the record.
    """
    model_key = fake_worker.FAKE_MODEL_KEY
    async with sessionmaker() as db:
        worker, definition, da, run, version = await _scaffold(
            db, model_key=model_key, adapter_version="simulated"
        )
        try:
            await broker.dispatch_or_resume_recursive_turn(
                db, run=run, definition=definition, planned=_Planned(), da=da, av=version,
                agent_title="Test Lead", messages=[], prompt="Open the meeting.",
                worker_id="broker-test",
            )
            leased = await broker.lease_next_job(
                db, worker, supported_profiles=["research_read_only"],
                model_keys=[model_key], settings=recursive_settings,
            )
            assert leased is not None
            result = fake_worker._build_result(leased, recursive_settings)

            # The researcher cancels while the worker is still computing.
            assert await broker.request_cancellation(db, run) is not None
            await db.commit()

            outcome, job = await broker.complete_job(db, leased.id, worker, result)
            assert outcome == "cancelled", "a late result overturned the cancellation"

            await db.refresh(job)
            await db.refresh(run)
            assert job.status == "cancelled"
            assert run.status == "cancelled"
            assert job.result_sha256 is None, "the discarded answer was stored anyway"

            turn = (
                await db.execute(select(RunTurn).where(RunTurn.run_id == run.id))
            ).scalars().one()
            assert turn.status == "cancelled"
            assert not (turn.response_text or ""), "the withdrawn answer entered the transcript"
            # The compute really happened, so the spend is still on the record.
            assert job.model_call_count == result.usage.model_call_count

            # A cancelled meeting is still a research record: it must end with
            # a provenance manifest, or say plainly that one could not be made.
            events = (
                await db.execute(
                    select(RunEvent.event_type).where(RunEvent.run_id == run.id)
                )
            ).scalars().all()
            assert "run.cancelled" in events
            manifest = (
                await db.execute(
                    text("SELECT count(*) FROM run_manifests WHERE run_id = :r"),
                    {"r": run.id},
                )
            ).scalar_one()
            assert manifest == 1 or "manifest.failed" in events, (
                f"cancelled run left no manifest and no explanation; events={events}"
            )
        finally:
            await _cleanup(db, worker, definition, run)


async def test_a_worker_whose_lease_lapsed_cannot_fail_or_release_the_job(
    sessionmaker, recursive_settings
):
    """/fail and /release mutate state, so they need the same fence as /complete.

    Otherwise a worker that fell silent long enough for the sweeper to plan a
    retry could still reach in and terminate the turn -- or requeue an attempt
    that has already been handed to someone else.
    """
    from fastapi import HTTPException

    from app.api import recursive as recursive_api
    from app.schemas import RecursiveFailIn

    model_key = fake_worker.FAKE_MODEL_KEY
    async with sessionmaker() as db:
        worker, definition, da, run, version = await _scaffold(
            db, model_key=model_key, adapter_version="simulated"
        )
        try:
            await broker.dispatch_or_resume_recursive_turn(
                db, run=run, definition=definition, planned=_Planned(), da=da, av=version,
                agent_title="Test Lead", messages=[], prompt="Open the meeting.",
                worker_id="broker-test",
            )
            leased = await broker.lease_next_job(
                db, worker, supported_profiles=["research_read_only"],
                model_keys=[model_key], settings=recursive_settings,
            )
            assert leased is not None
            leased.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
            await db.commit()

            for call in (
                recursive_api.fail_job_route(
                    leased.id,
                    RecursiveFailIn(
                        failure_code="worker_error", safe_message="gave up", retryable=True
                    ),
                    db=db,
                    worker=worker,
                ),
                recursive_api.release_job_route(leased.id, db=db, worker=worker),
            ):
                with pytest.raises(HTTPException) as caught:
                    await call
                assert caught.value.status_code == 409
                assert caught.value.detail["code"] == "lease_expired"

            await db.refresh(leased)
            assert leased.status not in broker.TERMINAL_JOB_STATUSES
            assert leased.leased_worker_id == worker.id, "the stale worker requeued the job"
        finally:
            await _cleanup(db, worker, definition, run)


async def test_pausing_a_parked_run_stops_the_queue_handing_the_job_out(
    sessionmaker, recursive_settings
):
    """Pause must actually stop work, not just relabel the run."""
    model_key = fake_worker.FAKE_MODEL_KEY
    async with sessionmaker() as db:
        worker, definition, da, run, version = await _scaffold(
            db, model_key=model_key, adapter_version="simulated"
        )
        try:
            await broker.dispatch_or_resume_recursive_turn(
                db, run=run, definition=definition, planned=_Planned(), da=da, av=version,
                agent_title="Test Lead", messages=[], prompt="Open the meeting.",
                worker_id="broker-test",
            )
            job = await broker.active_job_for_run(db, run.id)
            assert await broker.park_paused(db, job) == "paused"

            await db.refresh(run)
            await db.refresh(job)
            assert run.status == "paused"
            # Queued but unleasable: leasing requires the run to be parked, so
            # the pause needs no separate flag on the job to be effective.
            assert job.status == "queued"
            assert job.leased_worker_id is None
            assert await broker.lease_next_job(
                db, worker, supported_profiles=["research_read_only"],
                model_keys=[model_key], settings=recursive_settings,
            ) is None
        finally:
            await _cleanup(db, worker, definition, run)


async def test_a_cancelled_job_is_not_handed_to_a_worker(sessionmaker, recursive_settings):
    model_key = fake_worker.FAKE_MODEL_KEY
    async with sessionmaker() as db:
        worker, definition, da, run, version = await _scaffold(
            db, model_key=model_key, adapter_version="simulated"
        )
        try:
            await broker.dispatch_or_resume_recursive_turn(
                db, run=run, definition=definition, planned=_Planned(), da=da, av=version,
                agent_title="Test Lead", messages=[], prompt="Open the meeting.",
                worker_id="broker-test",
            )
            job = await broker.request_cancellation(db, run)
            assert job is not None
            await db.commit()
            assert job.cancellation_requested_at is not None

            assert await broker.lease_next_job(
                db, worker, supported_profiles=["research_read_only"],
                model_keys=[model_key], settings=recursive_settings,
            ) is None
        finally:
            await _cleanup(db, worker, definition, run)


async def test_an_oversized_worker_upload_is_refused_before_it_is_parsed(recursive_settings):
    """A bearer token must not buy the right to make the server buffer anything.

    The cap has to bite before FastAPI parses the body, and before the worker
    is even authenticated -- otherwise the memory is already spent by the time
    anything could object. Proven both ways round: a declared Content-Length,
    and a chunked upload that declares nothing at all.
    """
    from httpx import ASGITransport, AsyncClient

    from app.main import create_app

    app = create_app(recursive_settings)
    event_limit = recursive_settings.recursive_job_event_body_max_bytes
    result_limit = recursive_settings.recursive_job_result_body_max_bytes
    assert result_limit > event_limit, "this test needs the two limits to differ"

    events_path = f"/api/v1/recursive-jobs/{uuid.uuid4()}/events"
    complete_path = f"/api/v1/recursive-jobs/{uuid.uuid4()}/complete"
    # A structurally invalid token, so the 401s below come from parsing the
    # credential and never reach the database: this test drives the real ASGI
    # app, which would otherwise use the process-wide session factory bound to
    # a different event loop than the one pytest gives each test.
    headers = {
        "Authorization": "Bearer not-a-worker-token",
        "Content-Type": "application/json",
    }

    async def _chunked(total: int):
        sent = 0
        while sent < total:
            block = min(65_536, total - sent)
            yield b"x" * block
            sent += block

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        # Baseline: a small body is not rejected for its size, it reaches the
        # credential check. Without this the 413s below would prove nothing.
        small = await client.post(
            events_path, json={"schema_version": "1.0", "events": []}, headers=headers
        )
        assert small.status_code == 401, small.text

        declared = await client.post(
            events_path, content=b"x" * (event_limit + 1), headers=headers
        )
        assert declared.status_code == 413, declared.text
        assert declared.json()["detail"]["code"] == "body_too_large"

        streamed = await client.post(
            events_path, content=_chunked(event_limit + 65_536), headers=headers
        )
        assert streamed.status_code == 413, "a chunked upload slipped past the cap"

        # The limits are per endpoint, not one global cap: a result larger than
        # an event batch may exceed the event limit and still be admitted.
        # Valid JSON, because FastAPI decodes the body before it authenticates
        # and a parse error would mask the 401 this assertion is looking for.
        oversize_for_events = b'{"pad": "' + b"x" * (event_limit + 1) + b'"}'
        assert event_limit < len(oversize_for_events) <= result_limit
        allowed = await client.post(
            complete_path, content=oversize_for_events, headers=headers
        )
        assert allowed.status_code == 401, allowed.text
        too_big = await client.post(
            complete_path, content=b"x" * (result_limit + 1), headers=headers
        )
        assert too_big.status_code == 413, too_big.text


# ---------------------------------------------------------------------------
# The feature is invisible when it is off
# ---------------------------------------------------------------------------


async def test_the_disabled_feature_leaves_no_trace_in_the_application(monkeypatch):
    """With the flag off the routes are never registered, not merely refused.

    A refusal is still an answer. If the paths existed and returned 404 from a
    dependency, a probe could still tell them apart from unrouted ones by the
    replies that come *before* a dependency runs -- a 422 for a malformed body,
    a 413 for an oversized one. Registering conditionally removes that signal:
    everything is the same 404, and the OpenAPI document does not mention the
    feature at all.
    """
    from httpx import ASGITransport, AsyncClient

    from app.main import create_app

    monkeypatch.delenv("RECURSIVE_AGENTS_ENABLED", raising=False)
    monkeypatch.delenv("RECURSIVE_WORKER_TOKEN_PEPPER", raising=False)
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert not settings.recursive_agents_enabled
        app = create_app(settings)

        recursive_paths = [p for p in app.openapi()["paths"] if "recursive" in p]
        assert recursive_paths == [], recursive_paths

        job_id = uuid.uuid4()
        probes = (
            # A well-formed request, so nothing can be blamed on the payload.
            (f"/api/v1/recursive-jobs/{job_id}/events",
             json.dumps({"schema_version": "1.0", "events": []}).encode()),
            # Malformed: would be 422 if the path were routed.
            (f"/api/v1/recursive-jobs/{job_id}/complete", b"{not json"),
            # Oversized: would be 413 if the body limit were reachable.
            (f"/api/v1/recursive-jobs/{job_id}/events", b"x" * 2_000_000),
            (f"/api/v1/recursive-workers/enroll", b"{}"),
        )
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            for path, body in probes:
                resp = await client.post(
                    path,
                    content=body,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": "Bearer rwk_" + "0" * 12 + "_secret",
                    },
                )
                assert resp.status_code == 404, f"{path} answered {resp.status_code}"
    finally:
        get_settings.cache_clear()


def _proxy_up() -> bool:
    try:
        with urllib.request.urlopen(f"{PROXY}/api/health/ready", timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


@pytest.mark.skipif(not _proxy_up(), reason="shared proxy not reachable")
def test_worker_routes_are_absent_while_the_feature_is_off():
    """A deployment that never enabled this must not admit it exists."""
    if get_settings().recursive_agents_enabled:
        pytest.skip("the running server has the recursive feature enabled")
    for path, body in (
        ("/api/v1/recursive-workers/enroll", {"enrollment_token": "rwe_" + "0" * 12 + "_x"}),
        ("/api/v1/recursive-workers/heartbeat", {}),
        ("/api/v1/recursive-workers/jobs/lease", {"available_slots": 1}),
    ):
        req = urllib.request.Request(
            f"{PROXY}{path}",
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer rwk_" + "0" * 12 + "_secret",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                pytest.fail(f"{path} answered {resp.status} with the feature off")
        except urllib.error.HTTPError as exc:
            assert exc.code == 404, f"{path} answered {exc.code}, revealing the feature"
