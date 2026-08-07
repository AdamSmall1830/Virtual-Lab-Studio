"""The recursive job state machine.

One recursive participant turn is one logical job. Retries reuse the same row
and increment ``attempt_count``, so a meeting can never end up with two
participant turns where the researcher configured one.

The invariant that shapes everything here: **a parked run holds no native
lease**. An external job may take minutes on someone's home machine, and
holding a lease for that long would either starve the worker pool or expire and
let a second worker replay the turn. So dispatch releases the lease and sets
``runs.status = 'waiting_external'``, which the native claim query and the
native sweeper both ignore. Completion puts the run back to ``queued`` and the
ordinary engine replay path picks it up at the next turn.

Two hazards in this codebase have bitten before and are guarded explicitly:

* the lease fence must commit in the *same transaction* as the writes it
  guards, never as a separate check;
* moving a run out of a terminal or parked state races the summary/manifest
  write, so both sides take the run row lock.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..engine import LeaseLost, canonical_json, sha256_text
from ..events import append_event
from ..models import (
    AgentVersion,
    MeetingDefinition,
    MeetingDefinitionAgent,
    RecursiveAgentJob,
    RecursiveAgentNode,
    RecursiveWorker,
    Run,
    RunCitation,
    RunTurn,
)
from ..provenance import frozen_evidence

logger = logging.getLogger("vls.recursive")

NONTERMINAL_JOB_STATUSES = ("queued", "leased", "running", "cancellation_requested")
TERMINAL_JOB_STATUSES = ("completed", "failed", "cancelled")

# A completion may overrun its declared runtime slightly -- clocks differ and
# the final upload is not free. Beyond this the worker ignored its budget.
RUNTIME_SLACK = 1.2


class JobRejected(Exception):
    """A worker request that must be refused, with a safe reason."""

    def __init__(self, status_code: int, code: str, safe_message: str) -> None:
        super().__init__(safe_message)
        self.status_code = status_code
        self.code = code
        self.safe_message = safe_message


# ---------------------------------------------------------------------------
# The immutable request contract
# ---------------------------------------------------------------------------


def build_request_contract(
    *,
    definition: MeetingDefinition,
    da: MeetingDefinitionAgent,
    av: AgentVersion,
    agent_title: str,
    planned: Any,
    messages: list[dict[str, str]],
    prompt: str,
    limits: dict[str, Any],
) -> dict[str, Any]:
    """Everything the worker needs to execute exactly this turn, and nothing else.

    Hashed and stored on the job. A completion is refused unless the worker
    echoes the hash back, so a result can never be attached to a request the
    worker did not actually run -- including a request from a different turn of
    the same meeting.

    Evidence *content* is deliberately absent: only keys and hashes appear
    here, and the text is fetched through the lease-checked bundle route.
    """
    config = da.recursive_execution_config or {}
    return {
        "schema_version": "1.0",
        "assignment": {
            "meeting_definition_sha256": definition.definition_sha256,
            "turn_sequence": planned.call_index,
            "round_number": planned.round_number,
            "is_final_round": planned.is_final,
            "total_rounds": definition.rounds,
        },
        "participant": {
            "display_name": agent_title,
            "role_type": planned.role_type,
            "system_prompt": av.system_prompt,
            "expertise": av.expertise,
            "goal": av.goal,
            "role": av.role,
        },
        "meeting": {
            "title": definition.title,
            "meeting_type": definition.meeting_type,
            "agenda": definition.agenda,
            "questions": list(definition.questions or []),
            "rules": list(definition.rules or []),
            "contexts": list(definition.contexts or []),
        },
        "turn": {"instruction": prompt},
        "transcript": [
            {"role": m["role"], "content": m["content"]} for m in messages
        ],
        "evidence": [
            {
                "evidence_key": e.get("evidence_key"),
                "title": e.get("title"),
                "citation": e.get("citation"),
                "content_sha256": e.get("content_sha256"),
            }
            for e in frozen_evidence(definition)
        ],
        "execution": {
            "capability_profile": config.get("capability_profile", "research_read_only"),
            "coordinator_model_key": config.get("coordinator_model_key")
            or da.recursive_model_key,
            "child_model_key": config.get("child_model_key"),
            "allowed_skill_ids": list(config.get("allowed_skill_ids") or ["vls_evidence"]),
            "allow_web": False,
            "limits": limits,
        },
    }


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


async def _park_run(
    db: AsyncSession, run: Run, worker_id: str
) -> bool:
    """Release the native lease and park the run, fenced on still owning it.

    The UPDATE lands in the caller's single transaction, so a worker that lost
    the run commits nothing.
    """
    run.status = "waiting_external"
    result = await db.execute(
        update(Run)
        .where(
            Run.id == run.id,
            Run.lease_owner == worker_id,
            Run.lease_expires_at.is_not(None),
            Run.lease_expires_at > datetime.now(UTC),
        )
        .values(lease_owner=None, lease_expires_at=None, heartbeat_at=None)
    )
    if result.rowcount == 1:
        return True

    # No lease to release. That is the expected state on a second pass over an
    # already-parked turn -- parking is what dropped the lease in the first
    # place -- and treating it as a lost fence would make every re-dispatch of
    # a parked run raise. Re-read under the row lock the caller already holds
    # and accept only the state we were trying to reach.
    fresh = (
        await db.execute(
            select(Run)
            .where(Run.id == run.id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    return fresh.status == "waiting_external" and fresh.lease_owner is None


async def dispatch_or_resume_recursive_turn(
    db: AsyncSession,
    *,
    run: Run,
    definition: MeetingDefinition,
    planned: Any,
    da: MeetingDefinitionAgent,
    av: AgentVersion,
    agent_title: str,
    messages: list[dict[str, str]],
    prompt: str,
    worker_id: str,
) -> bool:
    """Create or re-find this turn's job and park the run. Idempotent.

    Returns True when the run is now waiting on an external worker and the
    engine must stop; False when the turn is already complete and the caller
    should fall through to its ordinary replay path.
    """
    settings = get_settings()

    # Lock the run for the whole transition. Completion, cancellation and the
    # sweeper all take this same lock, so exactly one of them can move the run
    # at a time.
    locked = (
        await db.execute(select(Run).where(Run.id == run.id).with_for_update())
    ).scalar_one()
    assert locked.id == run.id

    turn = (
        await db.execute(
            select(RunTurn)
            .where(RunTurn.run_id == run.id, RunTurn.sequence == planned.call_index)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if turn is not None and turn.status == "completed":
        # Nothing was modified, so commit rather than roll back: it releases
        # the row locks just the same, but leaves the caller's loaded objects
        # usable. A rollback would expire them and the next attribute read
        # would fail on a lazy refresh outside the async greenlet.
        await db.commit()
        return False

    job = None
    if turn is not None:
        job = (
            await db.execute(
                select(RecursiveAgentJob)
                .where(RecursiveAgentJob.run_turn_id == turn.id)
                .with_for_update()
            )
        ).scalar_one_or_none()

    config = da.recursive_execution_config or {}
    limits = {
        "max_children": int(config.get("max_children", settings.recursive_job_default_max_children)),
        "max_depth": int(config.get("max_depth", settings.recursive_job_default_max_depth)),
        "max_agent_turns": int(
            config.get("max_agent_turns", settings.recursive_job_default_max_agent_turns)
        ),
        "max_tokens": int(config.get("max_tokens", settings.recursive_job_default_max_tokens)),
        "max_runtime_seconds": int(
            config.get("max_runtime_seconds", settings.recursive_job_default_max_runtime_seconds)
        ),
        "max_cost_usd": config.get("max_cost_usd"),
    }

    if job is not None and job.status in NONTERMINAL_JOB_STATUSES:
        # A second pass over the same turn (worker restart, duplicate dispatch).
        # Re-park rather than creating a second job.
        if not await _park_run(db, run, worker_id):
            # Read the id before the rollback: rolling back expires the ORM
            # object and the message would then trigger a lazy refresh.
            lost = run.id
            await db.rollback()
            raise LeaseLost(f"run {lost} lease lost while dispatching a recursive turn")
        await db.commit()
        logger.info("Run %s already waiting on recursive job %s", run.id, job.id)
        return True

    request_json = build_request_contract(
        definition=definition,
        da=da,
        av=av,
        agent_title=agent_title,
        planned=planned,
        messages=messages,
        prompt=prompt,
        limits=limits,
    )
    request_sha = sha256_text(canonical_json(request_json))

    if turn is None:
        turn = RunTurn(
            workspace_id=run.workspace_id,
            run_id=run.id,
            sequence=planned.call_index,
            round_number=planned.round_number,
            position_in_round=planned.position_in_round,
            agent_version_id=da.agent_version_id,
            role_type=planned.role_type,
            status="waiting_external",
            execution_mode="recursive_rlm",
            system_prompt_sha256=av.system_prompt_sha256,
            request_payload_sha256=request_sha,
            started_at=datetime.now(UTC),
        )
        db.add(turn)
        await db.flush()
    else:
        turn.status = "waiting_external"
        turn.execution_mode = "recursive_rlm"
        turn.response_text = None
        turn.response_sha256 = None
        turn.finish_reason = None
        turn.request_payload_sha256 = request_sha
        turn.completed_at = None

    created = job is None
    if job is None:
        job = RecursiveAgentJob(
            workspace_id=run.workspace_id,
            run_id=run.id,
            run_turn_id=turn.id,
            meeting_definition_id=definition.id,
            agent_version_id=da.agent_version_id,
            requested_worker_id=da.recursive_worker_id,
            status="queued",
            max_attempts=settings.recursive_job_max_attempts,
            request_json=request_json,
            request_sha256=request_sha,
            model_key=str(request_json["execution"]["coordinator_model_key"]),
            child_model_key=config.get("child_model_key"),
            capability_profile=str(request_json["execution"]["capability_profile"]),
            max_children=limits["max_children"],
            max_depth=limits["max_depth"],
            max_agent_turns=limits["max_agent_turns"],
            max_tokens=limits["max_tokens"],
            max_runtime_seconds=limits["max_runtime_seconds"],
            max_cost_usd=(
                Decimal(str(limits["max_cost_usd"])) if limits["max_cost_usd"] is not None else None
            ),
        )
        db.add(job)
        await db.flush()
        run.recursive_job_count = (run.recursive_job_count or 0) + 1
    else:
        # A user retried a run whose recursive job had failed. Reuse the row --
        # the turn is the same turn -- but grant a fresh attempt allowance so
        # the retry is not refused by the exhausted count it inherited.
        job.status = "queued"
        job.failure_code = None
        job.failure_safe_message = None
        job.leased_worker_id = None
        job.lease_expires_at = None
        job.heartbeat_at = None
        job.cancellation_requested_at = None
        job.completed_at = None
        job.max_attempts = job.attempt_count + settings.recursive_job_max_attempts
        job.request_json = request_json
        job.request_sha256 = request_sha
    job.queue_available_at = datetime.now(UTC)

    run.current_round = planned.round_number
    run.current_position = planned.position_in_round
    run.current_agent_version_id = da.agent_version_id

    if not await _park_run(db, run, worker_id):
        # Another worker owns the run. Everything above -- the turn row, the
        # job row, the counters -- goes away with the fence, which is the whole
        # point of doing it in one transaction.
        lost = run.id
        await db.rollback()
        raise LeaseLost(f"run {lost} lease lost while dispatching a recursive turn")
    await db.commit()

    await append_event(
        db,
        workspace_id=run.workspace_id,
        run_id=run.id,
        event_type="turn.started",
        payload={
            "turn_id": str(turn.id),
            "sequence": planned.call_index,
            "round": planned.round_number,
            "agent_title": agent_title,
            "role_type": planned.role_type,
            "model": job.model_key,
            "provider_type": "recursive_worker",
            "execution_mode": "recursive_rlm",
            "is_final": planned.is_final,
            "simulation": False,
        },
    )
    await append_event(
        db,
        workspace_id=run.workspace_id,
        run_id=run.id,
        event_type="recursive.job.queued",
        payload={
            "job_id": str(job.id),
            "turn_id": str(turn.id),
            "created": created,
            "model_key": job.model_key,
            "capability_profile": job.capability_profile,
            "limits": limits,
        },
    )
    await append_event(
        db,
        workspace_id=run.workspace_id,
        run_id=run.id,
        event_type="run.waiting_external",
        payload={"job_id": str(job.id), "turn_id": str(turn.id)},
    )
    logger.info("Run %s parked on recursive job %s", run.id, job.id)
    return True


# ---------------------------------------------------------------------------
# Leasing
# ---------------------------------------------------------------------------


async def lease_next_job(
    db: AsyncSession,
    worker: RecursiveWorker,
    *,
    supported_profiles: list[str],
    model_keys: list[str],
    settings: Settings,
) -> RecursiveAgentJob | None:
    """Hand this worker one eligible job, or None.

    Eligibility is deliberately strict, and the run-status condition is the
    load-bearing one: a job is only leasable while its run is still parked. A
    run that was cancelled, paused or failed therefore stops handing out work
    without any separate bookkeeping.
    """
    now = datetime.now(UTC)
    candidate_ids = (
        await db.execute(
            select(RecursiveAgentJob.id)
            .join(Run, Run.id == RecursiveAgentJob.run_id)
            .where(
                RecursiveAgentJob.workspace_id == worker.workspace_id,
                RecursiveAgentJob.status == "queued",
                RecursiveAgentJob.queue_available_at <= now,
                RecursiveAgentJob.cancellation_requested_at.is_(None),
                RecursiveAgentJob.attempt_count < RecursiveAgentJob.max_attempts,
                RecursiveAgentJob.capability_profile.in_(supported_profiles),
                RecursiveAgentJob.model_key.in_(model_keys),
                Run.status == "waiting_external",
                (RecursiveAgentJob.requested_worker_id.is_(None))
                | (RecursiveAgentJob.requested_worker_id == worker.id),
            )
            .order_by(RecursiveAgentJob.priority.asc(), RecursiveAgentJob.created_at.asc())
            .limit(1)
            .with_for_update(skip_locked=True)
        )
    ).scalars().all()
    if not candidate_ids:
        return None

    job = await db.get(RecursiveAgentJob, candidate_ids[0])
    assert job is not None
    job.status = "leased"
    job.leased_worker_id = worker.id
    job.lease_expires_at = now + timedelta(seconds=settings.recursive_job_lease_seconds)
    job.heartbeat_at = now
    job.attempt_count += 1
    if job.started_at is None:
        job.started_at = now
    await db.commit()

    await append_event(
        db,
        workspace_id=job.workspace_id,
        run_id=job.run_id,
        event_type="recursive.job.leased",
        payload={
            "job_id": str(job.id),
            "turn_id": str(job.run_turn_id),
            "worker_id": str(worker.id),
            "worker_display_name": worker.display_name,
            "attempt": job.attempt_count,
        },
    )
    return job


async def renew_job_lease(
    db: AsyncSession, job: RecursiveAgentJob, worker: RecursiveWorker, settings: Settings
) -> bool:
    """Owner-conditional renewal, inside the caller's transaction. Commits nothing."""
    result = await db.execute(
        update(RecursiveAgentJob)
        .where(
            RecursiveAgentJob.id == job.id,
            RecursiveAgentJob.leased_worker_id == worker.id,
            RecursiveAgentJob.lease_expires_at.is_not(None),
            RecursiveAgentJob.lease_expires_at > datetime.now(UTC),
            RecursiveAgentJob.status.in_(("leased", "running", "cancellation_requested")),
        )
        .values(
            heartbeat_at=datetime.now(UTC),
            lease_expires_at=datetime.now(UTC)
            + timedelta(seconds=settings.recursive_job_lease_seconds),
        )
    )
    return result.rowcount == 1


async def load_leased_job(
    db: AsyncSession, job_id: uuid.UUID, worker: RecursiveWorker, *, for_update: bool = False
) -> RecursiveAgentJob:
    """Fetch a job this worker is entitled to see, or 404.

    A worker from another workspace -- or one that never held this job -- gets
    the same not-found answer as for an id that does not exist, so probing
    cannot confirm a job's existence.
    """
    stmt = select(RecursiveAgentJob).where(RecursiveAgentJob.id == job_id)
    if for_update:
        stmt = stmt.with_for_update()
    job = (await db.execute(stmt)).scalar_one_or_none()
    if (
        job is None
        or job.workspace_id != worker.workspace_id
        or job.leased_worker_id != worker.id
    ):
        raise JobRejected(404, "not_found", "Job not found")
    return job


def require_live_lease(job: RecursiveAgentJob, worker: RecursiveWorker) -> None:
    if job.leased_worker_id != worker.id:
        raise JobRejected(409, "lease_lost", "This job is leased to a different worker.")
    if job.lease_expires_at is None or job.lease_expires_at <= datetime.now(UTC):
        raise JobRejected(409, "lease_expired", "This job's lease has expired.")


# ---------------------------------------------------------------------------
# Result validation
# ---------------------------------------------------------------------------


def _validate_nodes(nodes: list[Any], job: RecursiveAgentJob) -> None:
    """Refuse a tree that describes work the job did not authorise."""
    if not nodes:
        return
    ids = [n.external_node_id for n in nodes]
    if len(set(ids)) != len(ids):
        raise JobRejected(422, "invalid_nodes", "Agent node identifiers must be unique.")

    by_id = {n.external_node_id: n for n in nodes}
    roots = [n for n in nodes if not n.parent_external_node_id]
    if len(roots) != 1:
        raise JobRejected(
            422, "invalid_nodes", "An agent tree must have exactly one coordinator node."
        )

    children: dict[str, int] = {}
    for node in nodes:
        parent = node.parent_external_node_id
        if not parent:
            continue
        if parent not in by_id:
            raise JobRejected(422, "invalid_nodes", "An agent node references an unknown parent.")
        children[parent] = children.get(parent, 0) + 1
        if children[parent] > job.max_children:
            raise JobRejected(
                422,
                "limit_exceeded",
                f"An agent created more than the {job.max_children} child agents allowed.",
            )

    for node in nodes:
        depth = 0
        cursor = node.parent_external_node_id
        seen = {node.external_node_id}
        while cursor:
            if cursor in seen:
                raise JobRejected(422, "invalid_nodes", "The agent tree contains a cycle.")
            seen.add(cursor)
            depth += 1
            if depth > job.max_depth:
                raise JobRejected(
                    422,
                    "limit_exceeded",
                    f"An agent tree deeper than the allowed depth of {job.max_depth} was reported.",
                )
            cursor = by_id[cursor].parent_external_node_id


def _validate_usage(body: Any, job: RecursiveAgentJob) -> None:
    usage = body.usage
    total_tokens = usage.input_tokens + usage.output_tokens
    if total_tokens > job.max_tokens:
        raise JobRejected(
            422,
            "limit_exceeded",
            f"The job reported {total_tokens} tokens against a limit of {job.max_tokens}.",
        )
    if usage.model_call_count > job.max_agent_turns:
        raise JobRejected(
            422,
            "limit_exceeded",
            f"The job reported {usage.model_call_count} model calls against a limit of "
            f"{job.max_agent_turns}.",
        )
    if job.max_cost_usd is not None and Decimal(str(usage.cost_usd)) > job.max_cost_usd:
        raise JobRejected(
            422,
            "limit_exceeded",
            f"The job reported {usage.cost_usd} USD against a limit of {job.max_cost_usd} USD.",
        )
    limit_ms = job.max_runtime_seconds * 1000 * RUNTIME_SLACK
    if body.runtime.elapsed_ms > limit_ms:
        raise JobRejected(
            422,
            "limit_exceeded",
            f"The job ran for {body.runtime.elapsed_ms} ms against a limit of "
            f"{job.max_runtime_seconds} s.",
        )


def _validate_citations(body: Any, definition: MeetingDefinition) -> None:
    keys = {
        e.get("evidence_key")
        for e in frozen_evidence(definition)
        if e.get("evidence_key")
    }
    unknown = sorted({c.evidence_key for c in body.citations} - keys)
    if unknown:
        raise JobRejected(
            422,
            "unknown_evidence",
            "The result cites evidence that is not frozen into this meeting: "
            + ", ".join(unknown[:5]),
        )


# ---------------------------------------------------------------------------
# Completion
# ---------------------------------------------------------------------------


def _result_digest(body: Any) -> str:
    """Canonical hash of the parts of a result that make it *this* result.

    Only the content that becomes the research record is hashed. Timings and
    session references are excluded so an honest retry of the same completion
    -- which necessarily reports a slightly later clock -- is recognised as the
    duplicate it is rather than raising a conflict.
    """
    return sha256_text(
        canonical_json(
            {
                "final_text": body.final_text,
                "citations": [
                    {
                        "evidence_key": c.evidence_key,
                        "locator": c.locator,
                        "claim": c.claim,
                        "support_type": c.support_type,
                    }
                    for c in body.citations
                ],
                "limitations": list(body.limitations),
                "nodes": [
                    {
                        "external_node_id": n.external_node_id,
                        "parent_external_node_id": n.parent_external_node_id,
                        "status": n.status,
                        "result_summary": n.result_summary,
                    }
                    for n in body.nodes
                ],
            }
        )
    )


async def complete_job(
    db: AsyncSession, job_id: uuid.UUID, worker: RecursiveWorker, body: Any
) -> tuple[str, RecursiveAgentJob]:
    """Accept a worker's result and requeue the run. Returns (outcome, job).

    ``outcome`` is ``"accepted"`` or ``"duplicate"``. Every write below --
    turn, usage, nodes, job state and run state -- lands in one transaction, so
    a run can never be requeued without the turn that justifies it.
    """
    job = await load_leased_job(db, job_id, worker, for_update=True)
    digest = _result_digest(body)

    # Everything up to the first write is a read-only gate. Refusals close the
    # transaction with a commit, not a rollback: no row was touched, the locks
    # are released either way, and a rollback would expire the caller's loaded
    # objects so that reading one attribute later fails outside the greenlet.
    try:
        if job.status in TERMINAL_JOB_STATUSES:
            # A retried upload of a result we already stored is normal on a
            # flaky connection and must be absorbed. A *different* result for a
            # job that is already settled is not.
            if job.status == "completed" and job.result_sha256 == digest:
                await db.commit()
                return "duplicate", job
            raise JobRejected(
                409,
                "job_already_terminal",
                f"This job is already {job.status} and cannot accept another result.",
            )

        require_live_lease(job, worker)
        if body.request_sha256 != job.request_sha256:
            raise JobRejected(
                422,
                "request_mismatch",
                "The result does not correspond to the request this job issued.",
            )

        definition = await db.get(MeetingDefinition, job.meeting_definition_id)
        assert definition is not None
        _validate_usage(body, job)
        _validate_nodes(body.nodes, job)
        _validate_citations(body, definition)

        run = (
            await db.execute(select(Run).where(Run.id == job.run_id).with_for_update())
        ).scalar_one()
        turn = (
            await db.execute(
                select(RunTurn).where(RunTurn.id == job.run_turn_id).with_for_update()
            )
        ).scalar_one()

        if run.status not in {"waiting_external", "pausing", "cancelling"}:
            raise JobRejected(
                409,
                "run_not_waiting",
                f"The meeting is no longer waiting for this turn (status: {run.status}).",
            )

        # Cancellation is authoritative; a pause is not. A completed turn *is*
        # the safe boundary a pause waits for, so a result that lands during
        # "pausing" is accepted and the engine pauses afterwards. Cancellation
        # means the researcher withdrew the question, and this deployment never
        # dials out to the worker -- it only learns of the cancellation on its
        # next heartbeat. Without this check a worker that finished inside that
        # window would store its answer and requeue the meeting, silently
        # overturning the decision.
        cancelled = (
            job.cancellation_requested_at is not None
            or run.control_requested == "cancel"
            or run.status == "cancelling"
        )
    except JobRejected:
        await db.commit()
        raise

    if cancelled:
        # Keep the spend: the compute really happened and the researcher paid
        # for it. Only the answer is discarded.
        await fail_job(
            db, job,
            failure_code="cancelled",
            safe_message="Cancelled by the researcher before the result was accepted.",
            retryable=False,
            usage=body.usage,
        )
        return "cancelled", job

    now = datetime.now(UTC)

    usage = body.usage
    turn.status = "completed"
    turn.execution_mode = "recursive_rlm"
    turn.response_text = body.final_text
    turn.response_sha256 = sha256_text(body.final_text)
    turn.finish_reason = "recursive_completed"
    turn.input_tokens = usage.input_tokens
    turn.cached_input_tokens = usage.cached_input_tokens
    turn.output_tokens = usage.output_tokens
    turn.cost_usd = Decimal(str(usage.cost_usd))
    turn.latency_ms = body.runtime.elapsed_ms
    turn.completed_at = now

    # Recursive work counts as model calls on the run. Reporting it as zero
    # would understate the meeting simply because the calls happened elsewhere.
    run.provider_call_count += usage.model_call_count
    run.input_tokens += usage.input_tokens
    run.cached_input_tokens += usage.cached_input_tokens
    run.output_tokens += usage.output_tokens
    run.actual_cost_usd = Decimal(str(run.actual_cost_usd)) + Decimal(str(usage.cost_usd))

    await _store_nodes(db, job, body.nodes, now)
    await _store_citations(db, run, turn, definition, body)

    job.status = "completed"
    job.result_json = {
        "final_text_sha256": turn.response_sha256,
        "citations": [c.model_dump(mode="json") for c in body.citations],
        "limitations": list(body.limitations),
        "runtime": body.runtime.model_dump(mode="json"),
        "usage": usage.model_dump(mode="json"),
    }
    job.result_sha256 = digest
    job.model_call_count = usage.model_call_count
    job.input_tokens = usage.input_tokens
    job.cached_input_tokens = usage.cached_input_tokens
    job.output_tokens = usage.output_tokens
    job.cost_usd = Decimal(str(usage.cost_usd))
    job.completed_at = now
    # leased_worker_id is kept: it records which worker produced this result,
    # and a worker whose acknowledgement was lost must be able to retry and be
    # told "duplicate" instead of "not found". Re-leasing is impossible because
    # lease_next_job only considers queued jobs.
    job.lease_expires_at = None
    job.heartbeat_at = None

    # Back to the ordinary queue. The native worker leases the run again and
    # its completed-turn replay rebuilds the transcript and continues.
    run.status = "queued"
    run.queue_available_at = now
    run.failure_code = None
    run.failure_safe_message = None
    await db.commit()

    node_count = len(body.nodes)
    await append_event(
        db,
        workspace_id=job.workspace_id,
        run_id=job.run_id,
        event_type="recursive.job.completed",
        payload={
            "job_id": str(job.id),
            "turn_id": str(job.run_turn_id),
            "node_count": node_count,
            "model_call_count": usage.model_call_count,
            "cost_usd": float(usage.cost_usd),
            "pricing_complete": usage.pricing_complete,
            "elapsed_ms": body.runtime.elapsed_ms,
            "simulation": body.runtime.is_simulation,
        },
    )
    await append_event(
        db,
        workspace_id=job.workspace_id,
        run_id=job.run_id,
        event_type="turn.completed",
        payload={
            "turn_id": str(job.run_turn_id),
            "sequence": turn.sequence,
            "round": turn.round_number,
            "role_type": turn.role_type,
            "text": body.final_text,
            "finish_reason": "recursive_completed",
            "execution_mode": "recursive_rlm",
            "simulation": body.runtime.is_simulation,
        },
    )
    await append_event(
        db,
        workspace_id=job.workspace_id,
        run_id=job.run_id,
        event_type="usage.updated",
        payload={
            "provider_call_count": run.provider_call_count,
            "input_tokens": run.input_tokens,
            "output_tokens": run.output_tokens,
            "actual_cost_usd": float(run.actual_cost_usd),
        },
    )
    await append_event(
        db,
        workspace_id=job.workspace_id,
        run_id=job.run_id,
        event_type="run.requeued",
        payload={"job_id": str(job.id), "reason": "recursive_turn_completed"},
    )
    return "accepted", job


async def _store_nodes(
    db: AsyncSession, job: RecursiveAgentJob, nodes: list[Any], now: datetime
) -> None:
    """Merge the reported tree over whatever the progress events already built."""
    existing = {
        n.external_node_id: n
        for n in (
            await db.execute(
                select(RecursiveAgentNode).where(RecursiveAgentNode.job_id == job.id)
            )
        ).scalars()
    }
    for node in nodes:
        row = existing.get(node.external_node_id)
        if row is None:
            row = RecursiveAgentNode(
                workspace_id=job.workspace_id,
                job_id=job.id,
                external_node_id=node.external_node_id,
                parent_external_node_id=node.parent_external_node_id,
                display_name=node.display_name or node.external_node_id,
                status=node.status,
            )
            db.add(row)
        row.parent_external_node_id = node.parent_external_node_id
        row.display_name = node.display_name or node.external_node_id
        row.status = node.status
        row.model_key = node.model_key
        row.task_summary = node.task_summary
        row.result_summary = node.result_summary
        row.cited_evidence_keys = list(node.cited_evidence_keys)
        row.tool_labels = list(node.tool_labels)
        row.failure_safe_message = node.failure_safe_message
        row.model_call_count = node.usage.model_call_count
        row.input_tokens = node.usage.input_tokens
        row.cached_input_tokens = node.usage.cached_input_tokens
        row.output_tokens = node.usage.output_tokens
        row.cost_usd = Decimal(str(node.usage.cost_usd))
        if row.completed_at is None and node.status in {"completed", "failed", "cancelled"}:
            row.completed_at = now
    await db.flush()

    total = (
        await db.execute(
            select(func.count())
            .select_from(RecursiveAgentNode)
            .join(RecursiveAgentJob, RecursiveAgentJob.id == RecursiveAgentNode.job_id)
            .where(RecursiveAgentJob.run_id == job.run_id)
        )
    ).scalar_one()
    run = await db.get(Run, job.run_id)
    if run is not None:
        run.recursive_agent_node_count = int(total)


async def _store_citations(
    db: AsyncSession, run: Run, turn: RunTurn, definition: MeetingDefinition, body: Any
) -> None:
    """Record the participant's own citations against the frozen evidence.

    Validation already refused any key that is not frozen into this meeting, so
    every row written here resolves to a real attached source.

    Unlike the engine's own citation pass -- which extracts from a finished
    transcript and so has no single turn to point at -- a recursive result
    arrives attached to exactly one turn, and saying which one is worth
    recording: it is the only link back to the machine that produced it.
    """
    by_key = {
        e["evidence_key"]: e for e in frozen_evidence(definition) if e.get("evidence_key")
    }
    existing = {
        row.citation_key
        for row in (
            await db.execute(select(RunCitation).where(RunCitation.run_id == run.id))
        ).scalars()
    }
    for citation in body.citations:
        if citation.evidence_key in existing:
            continue
        frozen = by_key.get(citation.evidence_key)
        if frozen is None:
            continue
        existing.add(citation.evidence_key)
        db.add(
            RunCitation(
                workspace_id=run.workspace_id,
                run_id=run.id,
                run_turn_id=turn.id,
                evidence_source_id=uuid.UUID(frozen["evidence_source_id"]),
                citation_key=citation.evidence_key,
                claim_text=citation.claim[:4000],
                support_type=citation.support_type,
                source_locator=citation.locator,
                validation_status="validated",
                validation_notes="Cited by a recursive participant against frozen evidence.",
            )
        )


# ---------------------------------------------------------------------------
# Failure, release and cancellation
# ---------------------------------------------------------------------------


async def _terminalise(
    db: AsyncSession,
    job: RecursiveAgentJob,
    *,
    job_status: str,
    turn_status: str,
    run_status: str,
    failure_code: str | None,
    safe_message: str | None,
) -> Run:
    """Settle job, turn and run together under the run's row lock."""
    now = datetime.now(UTC)
    run = (
        await db.execute(select(Run).where(Run.id == job.run_id).with_for_update())
    ).scalar_one()
    turn = (
        await db.execute(select(RunTurn).where(RunTurn.id == job.run_turn_id).with_for_update())
    ).scalar_one()

    job.status = job_status
    job.failure_code = failure_code
    job.failure_safe_message = safe_message
    job.completed_at = now
    # leased_worker_id deliberately survives: on a terminal job it is the
    # record of which worker produced (or abandoned) the result, and a worker
    # whose acknowledgement was lost must still be able to identify its own
    # job and be told "duplicate" rather than "not found". Leasing is gated on
    # status == 'queued' and live work on lease_expires_at, so keeping it
    # cannot hand the job out again.
    job.lease_expires_at = None
    job.heartbeat_at = None

    if turn.status not in {"completed"}:
        turn.status = turn_status
        turn.finish_reason = failure_code
        turn.completed_at = now

    run.status = run_status
    run.control_requested = None
    run.completed_at = now
    run.lease_owner = None
    run.lease_expires_at = None
    if run_status == "failed":
        run.failure_code = failure_code or "recursive_job_failed"
        run.failure_safe_message = safe_message or "The external recursive worker did not return a result."
    return run


async def _finalise_terminal_run(db: AsyncSession, run_id: uuid.UUID) -> None:
    """Write the summary and manifest for a run that stopped here.

    Runs in a fresh unit of work after the terminal commit, exactly as the
    engine's own failure paths do, so a manifest problem cannot roll back the
    state transition that has already been announced.
    """
    from ..provenance import ensure_manifest_safe  # local import: avoids a cycle

    run = await db.get(Run, run_id)
    if run is None:
        return
    # Read the ids up front: a manifest failure rolls back, which expires the
    # ORM object, and touching an expired attribute afterwards is implicit IO
    # that raises MissingGreenlet instead of reporting the real problem.
    workspace_id = run.workspace_id
    manifest, error = await ensure_manifest_safe(db, run)
    if (manifest, error) == (None, None):
        return
    await append_event(
        db,
        workspace_id=workspace_id,
        run_id=run_id,
        event_type="manifest.created" if error is None else "manifest.failed",
        payload={"manifest_version": "1.0"} if error is None else {"message": error},
    )


async def fail_job(
    db: AsyncSession,
    job: RecursiveAgentJob,
    *,
    failure_code: str,
    safe_message: str,
    retryable: bool,
    usage: Any | None = None,
) -> str:
    """Retry the job if it can be retried, otherwise stop the meeting honestly.

    Returns ``"requeued"``, ``"failed"``, ``"cancelled"`` or ``"paused"``.

    There is deliberately no path here that substitutes a standard completion.
    A recursive participant that could not run means the configured experiment
    did not happen, and saying so is the only truthful outcome.
    """
    now = datetime.now(UTC)
    if usage is not None:
        # Keep partial spend even when the attempt produced nothing usable.
        job.model_call_count += usage.model_call_count
        job.input_tokens += usage.input_tokens
        job.cached_input_tokens += usage.cached_input_tokens
        job.output_tokens += usage.output_tokens
        job.cost_usd = Decimal(str(job.cost_usd)) + Decimal(str(usage.cost_usd))

    if failure_code == "cancelled":
        run = await _terminalise(
            db, job,
            job_status="cancelled", turn_status="cancelled", run_status="cancelled",
            failure_code=None, safe_message=None,
        )
        await db.commit()
        await append_event(
            db, workspace_id=job.workspace_id, run_id=job.run_id,
            event_type="recursive.job.cancelled",
            payload={"job_id": str(job.id), "turn_id": str(job.run_turn_id)},
        )
        await append_event(
            db, workspace_id=run.workspace_id, run_id=run.id,
            event_type="run.cancelled", payload={"reason": "recursive_job_cancelled"},
        )
        await _finalise_terminal_run(db, job.run_id)
        return "cancelled"

    if failure_code == "paused":
        return await park_paused(db, job)

    attempts_left = job.attempt_count < job.max_attempts
    if retryable and attempts_left:
        job.status = "queued"
        job.leased_worker_id = None
        job.lease_expires_at = None
        job.heartbeat_at = None
        job.queue_available_at = now
        job.failure_code = failure_code
        job.failure_safe_message = safe_message or None
        await db.commit()
        await append_event(
            db, workspace_id=job.workspace_id, run_id=job.run_id,
            event_type="recursive.job.retry_scheduled",
            payload={
                "job_id": str(job.id),
                "turn_id": str(job.run_turn_id),
                "attempt": job.attempt_count,
                "max_attempts": job.max_attempts,
                "failure_code": failure_code,
                "message": safe_message or "",
            },
        )
        return "requeued"

    message = safe_message or "The external recursive worker did not return a usable result."
    run = await _terminalise(
        db, job,
        job_status="failed", turn_status="failed", run_status="failed",
        failure_code=failure_code, safe_message=message,
    )
    await db.commit()
    await append_event(
        db, workspace_id=job.workspace_id, run_id=job.run_id,
        event_type="recursive.job.failed",
        payload={
            "job_id": str(job.id),
            "turn_id": str(job.run_turn_id),
            "failure_code": failure_code,
            "message": message,
            "attempts": job.attempt_count,
        },
    )
    await append_event(
        db, workspace_id=run.workspace_id, run_id=run.id,
        event_type="run.failed",
        payload={"failure_code": failure_code, "message": message},
    )
    await _finalise_terminal_run(db, job.run_id)
    return "failed"


async def park_paused(db: AsyncSession, job: RecursiveAgentJob) -> str:
    """Stop at a safe boundary: job back in the queue, run genuinely paused.

    The job stays ``queued`` but is unleasable, because leasing requires the
    run to be ``waiting_external``. Resume simply parks the run again.
    """
    run = (
        await db.execute(select(Run).where(Run.id == job.run_id).with_for_update())
    ).scalar_one()
    job.status = "queued"
    job.leased_worker_id = None
    job.lease_expires_at = None
    job.heartbeat_at = None
    run.status = "paused"
    run.control_requested = None
    run.lease_owner = None
    run.lease_expires_at = None
    await db.commit()
    await append_event(
        db, workspace_id=run.workspace_id, run_id=run.id,
        event_type="run.paused",
        payload={"checkpoint": "recursive_job_boundary", "job_id": str(job.id)},
    )
    return "paused"


async def release_job(db: AsyncSession, job: RecursiveAgentJob) -> str:
    """A worker voluntarily gives the job back without a verdict."""
    job.status = "queued"
    job.leased_worker_id = None
    job.lease_expires_at = None
    job.heartbeat_at = None
    job.queue_available_at = datetime.now(UTC)
    await db.commit()
    await append_event(
        db, workspace_id=job.workspace_id, run_id=job.run_id,
        event_type="recursive.job.released",
        payload={"job_id": str(job.id), "attempt": job.attempt_count},
    )
    return "queued"


async def active_job_for_run(
    db: AsyncSession, run_id: uuid.UUID, *, for_update: bool = False
) -> RecursiveAgentJob | None:
    stmt = (
        select(RecursiveAgentJob)
        .where(
            RecursiveAgentJob.run_id == run_id,
            RecursiveAgentJob.status.in_(NONTERMINAL_JOB_STATUSES),
        )
        .order_by(RecursiveAgentJob.created_at.desc())
        .limit(1)
    )
    if for_update:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


# ---------------------------------------------------------------------------
# Sweeper
# ---------------------------------------------------------------------------


async def _lock_run_then_job(
    db: AsyncSession, job_id: uuid.UUID
) -> RecursiveAgentJob | None:
    """Take the run's row lock, then the job's. Returns None if either is busy.

    Lock ORDER is the point, not the locks themselves. Dispatch takes the run
    first and the turn/job second; if the sweeper took the job first the two
    could hold one row each and wait on the other, and PostgreSQL would abort
    one of them. Every multi-row transition in this module therefore acquires
    run -> turn -> job, in that order.

    ``skip_locked`` on both: a row someone else is already moving does not need
    sweeping, and the next pass will pick it up if it still does.
    """
    run_id = (
        await db.execute(
            select(RecursiveAgentJob.run_id).where(RecursiveAgentJob.id == job_id)
        )
    ).scalar_one_or_none()
    if run_id is None:
        return None
    locked_run = (
        await db.execute(
            select(Run.id).where(Run.id == run_id).with_for_update(skip_locked=True)
        )
    ).scalar_one_or_none()
    if locked_run is None:
        return None
    return (
        await db.execute(
            select(RecursiveAgentJob)
            .where(RecursiveAgentJob.id == job_id)
            .with_for_update(skip_locked=True)
        )
    ).scalar_one_or_none()


async def sweep_recursive_jobs(db: AsyncSession) -> int:
    """Move every stuck recursive job forward. Returns how many were touched.

    This is the guarantee that a parked run always reaches a terminal state.
    Four situations are swept:

    * a cancellation that no worker ever acknowledged -- final once the lease
      is gone, so an unreachable machine cannot hold a run hostage;
    * a pause waiting for a safe boundary that never arrived;
    * an expired lease with attempts remaining -- requeue;
    * an expired lease with attempts exhausted, or a job nobody ever picked up
      within its own runtime budget -- fail the meeting honestly.
    """
    now = datetime.now(UTC)
    touched = 0

    expired = (
        await db.execute(
            select(RecursiveAgentJob.id)
            .where(
                RecursiveAgentJob.status.in_(("leased", "running", "cancellation_requested")),
                RecursiveAgentJob.lease_expires_at.is_not(None),
                RecursiveAgentJob.lease_expires_at < now,
            )
            .order_by(RecursiveAgentJob.lease_expires_at.asc())
            .limit(50)
        )
    ).scalars().all()

    for job_id in expired:
        job = await _lock_run_then_job(db, job_id)
        if job is None or job.status in TERMINAL_JOB_STATUSES:
            await db.rollback()
            continue
        if job.lease_expires_at is None or job.lease_expires_at >= now:
            await db.rollback()  # renewed while we were reading
            continue
        run = await db.get(Run, job.run_id)
        touched += 1

        if job.cancellation_requested_at is not None:
            await fail_job(
                db, job, failure_code="cancelled",
                safe_message="Cancelled while an external worker held the job.",
                retryable=False,
            )
            continue
        if run is not None and run.control_requested == "pause":
            await park_paused(db, job)
            continue
        await fail_job(
            db, job,
            failure_code="timeout",
            safe_message="The external worker stopped responding before returning a result.",
            retryable=True,
        )

    # A cancellation requested while the job was still queued has no worker to
    # acknowledge it, so settle it here rather than waiting for a lease that
    # will never be taken.
    cancelled_queued = (
        await db.execute(
            select(RecursiveAgentJob.id).where(
                RecursiveAgentJob.status.in_(("queued", "cancellation_requested")),
                RecursiveAgentJob.cancellation_requested_at.is_not(None),
                RecursiveAgentJob.leased_worker_id.is_(None),
            ).limit(50)
        )
    ).scalars().all()
    for job_id in cancelled_queued:
        job = await _lock_run_then_job(db, job_id)
        if job is None or job.status in TERMINAL_JOB_STATUSES or job.leased_worker_id is not None:
            await db.rollback()
            continue
        touched += 1
        await fail_job(
            db, job, failure_code="cancelled",
            safe_message="Cancelled before any worker picked up the job.",
            retryable=False,
        )

    # Nobody ever came. The job's own runtime budget doubles as the deadline
    # for finding a worker at all: a meeting must not wait indefinitely for a
    # machine that is switched off.
    starved = (
        await db.execute(
            select(RecursiveAgentJob.id)
            .join(Run, Run.id == RecursiveAgentJob.run_id)
            .where(
                RecursiveAgentJob.status == "queued",
                RecursiveAgentJob.leased_worker_id.is_(None),
                RecursiveAgentJob.cancellation_requested_at.is_(None),
                Run.status == "waiting_external",
            )
            .limit(50)
        )
    ).scalars().all()
    for job_id in starved:
        job = await _lock_run_then_job(db, job_id)
        if job is None or job.status != "queued" or job.leased_worker_id is not None:
            await db.rollback()
            continue
        waiting_since = job.started_at or job.created_at
        if (now - waiting_since).total_seconds() <= job.max_runtime_seconds:
            await db.rollback()
            continue
        touched += 1
        await fail_job(
            db, job,
            failure_code="worker_error",
            safe_message=(
                "No enrolled worker picked up this recursive turn before its time limit. "
                "Start the bridge on the selected machine and retry the meeting."
            ),
            retryable=False,
        )

    return touched


async def request_cancellation(db: AsyncSession, run: Run) -> RecursiveAgentJob | None:
    """Mark the run's active job for cancellation. Does not commit.

    The worker learns about it on its next heartbeat -- this deployment never
    dials out to the operator's machine. If the worker is gone, the sweeper
    makes the cancellation final once the lease expires.
    """
    job = await active_job_for_run(db, run.id, for_update=True)
    if job is None:
        return None
    if job.cancellation_requested_at is None:
        job.cancellation_requested_at = datetime.now(UTC)
    if job.status in ("leased", "running"):
        job.status = "cancellation_requested"
    return job
