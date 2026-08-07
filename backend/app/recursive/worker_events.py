"""Normalisation of worker-submitted progress events.

A recursive coordinator emits a firehose: reasoning deltas, scratchpads, shell
output, absolute paths, provider headers. None of that may reach a browser, an
export or the provenance record. So this module is an allow-list in both
directions -- only known event types survive, and each one is rebuilt from a
handful of bounded fields rather than forwarded.

Duplicates are expected rather than exceptional: a worker on a home connection
retries any request whose response it never saw. ``recursive_job_events``
absorbs them on two independent keys (the worker's own sequence and its event
id), so a retried batch is silently accepted and produces no second run event.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..engine import canonical_json, sha256_text
from ..events import append_event
from ..models import RecursiveAgentJob, RecursiveAgentNode, RecursiveJobEvent

# Every event type a worker may report. Anything else is counted as rejected
# and dropped: an unrecognised type is far more likely to be a raw runtime
# event than something this product knows how to render safely.
ALLOWED_EVENT_TYPES = (
    "recursive.job.leased",
    "recursive.job.started",
    "recursive.agent.started",
    "recursive.agent.updated",
    "recursive.agent.completed",
    "recursive.agent.failed",
    "recursive.subagent.started",
    "recursive.subagent.completed",
    "recursive.subagent.failed",
    "recursive.tool.started",
    "recursive.tool.completed",
    "recursive.tool.failed",
    "recursive.usage.updated",
    "recursive.job.completed",
    "recursive.job.failed",
    "recursive.job.cancelled",
)
_ALLOWED = frozenset(ALLOWED_EVENT_TYPES)

# Events that describe a node's lifecycle, and the node status each implies.
_NODE_STATUS_BY_TYPE = {
    "recursive.agent.started": "running",
    "recursive.agent.updated": "running",
    "recursive.agent.completed": "completed",
    "recursive.agent.failed": "failed",
    "recursive.subagent.started": "running",
    "recursive.subagent.completed": "completed",
    "recursive.subagent.failed": "failed",
}

# Terminal state belongs to the completion and failure routes, which validate
# the result. A worker cannot terminalise a job by asserting it in an event.
_TERMINAL_TYPES = frozenset(
    {"recursive.job.completed", "recursive.job.failed", "recursive.job.cancelled"}
)


class EventRejected(Exception):
    """A batch that must not be absorbed silently (over-rate, over-size)."""

    def __init__(self, code: str, safe_message: str) -> None:
        super().__init__(safe_message)
        self.code = code
        self.safe_message = safe_message


def _safe_payload(event: Any, job: RecursiveAgentJob) -> dict[str, Any]:
    """Rebuild the user-visible payload from named fields only."""
    payload: dict[str, Any] = {
        "job_id": str(job.id),
        "turn_id": str(job.run_turn_id),
        "execution_mode": "recursive_rlm",
    }
    if event.node is not None:
        payload["node"] = {
            "external_node_id": event.node.external_node_id,
            "parent_external_node_id": event.node.parent_external_node_id,
            "display_name": event.node.display_name or event.node.external_node_id,
        }
    p = event.payload
    for name in ("task_summary", "result_summary", "model_key", "tool_label", "failure_category"):
        value = getattr(p, name, None)
        if value:
            payload[name] = value
    if p.failure_safe_message:
        payload["message"] = p.failure_safe_message
    if p.usage is not None:
        payload["usage"] = {
            "model_call_count": p.usage.model_call_count,
            "input_tokens": p.usage.input_tokens,
            "output_tokens": p.usage.output_tokens,
            "cost_usd": p.usage.cost_usd,
            "pricing_complete": p.usage.pricing_complete,
        }
    if event.occurred_at is not None:
        payload["occurred_at"] = event.occurred_at.astimezone(UTC).isoformat()
    return payload


async def _upsert_node(
    db: AsyncSession, job: RecursiveAgentJob, event: Any, status: str
) -> RecursiveAgentNode | None:
    """Track a node from its progress events so the tree is live, not post-hoc.

    Bounds are enforced here as well as at completion: a worker that streams
    more children than its job allows is describing work it was not authorised
    to do, and the extra nodes are dropped rather than displayed.
    """
    if event.node is None:
        return None
    node_id = event.node.external_node_id
    existing = (
        await db.execute(
            select(RecursiveAgentNode).where(
                RecursiveAgentNode.job_id == job.id,
                RecursiveAgentNode.external_node_id == node_id,
            )
        )
    ).scalar_one_or_none()
    now = datetime.now(UTC)
    if existing is None:
        count = len(
            (
                await db.execute(
                    select(RecursiveAgentNode.id).where(RecursiveAgentNode.job_id == job.id)
                )
            ).scalars().all()
        )
        # +1 for the coordinator itself.
        if count >= job.max_children * job.max_depth + 1:
            return None
        existing = RecursiveAgentNode(
            workspace_id=job.workspace_id,
            job_id=job.id,
            external_node_id=node_id,
            parent_external_node_id=(
                event.node.parent_external_node_id
                if event.node.parent_external_node_id != node_id
                else None
            ),
            display_name=event.node.display_name or node_id,
            status=status,
            started_at=now if status == "running" else None,
        )
        db.add(existing)
    else:
        existing.status = status
        if status == "running" and existing.started_at is None:
            existing.started_at = now
    if event.payload.model_key:
        existing.model_key = event.payload.model_key
    if event.payload.task_summary:
        existing.task_summary = event.payload.task_summary
    if event.payload.result_summary:
        existing.result_summary = event.payload.result_summary
    if event.payload.failure_safe_message:
        existing.failure_safe_message = event.payload.failure_safe_message
    if status in {"completed", "failed", "cancelled"} and existing.completed_at is None:
        existing.completed_at = now
    return existing


async def ingest_batch(
    db: AsyncSession,
    job: RecursiveAgentJob,
    events: list[Any],
    *,
    batch_max: int,
) -> tuple[int, int, int]:
    """Absorb one batch. Returns (accepted, duplicates, rejected).

    The caller must already have verified the worker holds this job's lease.
    Nothing here commits: the caller commits the batch together with whatever
    lease bookkeeping it did, so a worker that lost the job mid-batch cannot
    land half its events.
    """
    if len(events) > batch_max:
        raise EventRejected(
            "batch_too_large", f"An event batch may contain at most {batch_max} events."
        )

    seen = (
        await db.execute(
            select(RecursiveJobEvent.worker_sequence, RecursiveJobEvent.external_event_id).where(
                RecursiveJobEvent.job_id == job.id
            )
        )
    ).all()
    seen_sequences = {row.worker_sequence for row in seen}
    seen_ids = {row.external_event_id for row in seen}

    accepted = duplicates = rejected = 0
    for event in events:
        if event.type not in _ALLOWED or event.type in _TERMINAL_TYPES:
            rejected += 1
            continue
        if event.worker_sequence in seen_sequences or event.external_event_id in seen_ids:
            duplicates += 1
            continue
        seen_sequences.add(event.worker_sequence)
        seen_ids.add(event.external_event_id)

        payload = _safe_payload(event, job)
        status = event.payload.node_status or _NODE_STATUS_BY_TYPE.get(event.type)
        if status is not None:
            await _upsert_node(db, job, event, status)

        db.add(
            RecursiveJobEvent(
                job_id=job.id,
                worker_sequence=event.worker_sequence,
                external_event_id=event.external_event_id,
                event_type=event.type,
                payload_sha256=sha256_text(canonical_json(payload)),
            )
        )
        await append_event(
            db,
            workspace_id=job.workspace_id,
            run_id=job.run_id,
            event_type=event.type,
            payload=payload,
            commit=False,
        )
        accepted += 1

    if accepted:
        await _refresh_node_count(db, job)
    return accepted, duplicates, rejected


async def refresh_node_count(db: AsyncSession, run_id: uuid.UUID) -> None:
    """Recount the run's whole node tree rather than incrementing.

    Nodes arrive out of order and are retried, so a counter maintained by
    increments drifts. Recounting is one indexed aggregate and cannot drift.
    """
    from ..models import Run  # local import: avoids a cycle at module import

    total = (
        await db.execute(
            select(func.count())
            .select_from(RecursiveAgentNode)
            .join(RecursiveAgentJob, RecursiveAgentJob.id == RecursiveAgentNode.job_id)
            .where(RecursiveAgentJob.run_id == run_id)
        )
    ).scalar_one()
    run = await db.get(Run, run_id)
    if run is not None:
        run.recursive_agent_node_count = int(total)


async def _refresh_node_count(db: AsyncSession, job: RecursiveAgentJob) -> None:
    await refresh_node_count(db, job.run_id)


def job_bundle_path(job_id: uuid.UUID) -> str:
    return f"/api/v1/recursive-jobs/{job_id}/bundle"
