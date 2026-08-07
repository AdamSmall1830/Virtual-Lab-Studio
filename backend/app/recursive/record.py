"""The recursive execution record: one definition, three destinations.

The provenance manifest, the reproducibility packet and the printed appendix
must not each invent their own account of what a recursive turn was. All three
read this module, so a number that appears in the manifest, in the packet and
on paper is the same number by construction rather than by coincidence.

Nothing here trusts the worker afresh. Every field is either something this
deployment wrote itself -- the request it issued, the ceilings it imposed, the
outcome it recorded -- or something that already survived the allow-list in
``worker_events``. A credential, a session reference, a host path or a hidden
reasoning trace has no field to arrive in.

The manifest carries the jobs, the workers and a digest of each larger
collection; the packet carries the collections themselves. Because both sides
render through the helpers below, a verifier can hash a packet file and find
that hash inside the signed manifest payload, which is the only reason the
recursive files are worth anything as evidence.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    RecursiveAgentJob,
    RecursiveAgentNode,
    RecursiveWorker,
    Run,
    RunEvent,
)
from ..provenance import sha256_text
from .worker_events import ALLOWED_EVENT_TYPES

# Recursive events this deployment writes itself, in addition to the worker
# events that already passed ``worker_events.ALLOWED_EVENT_TYPES``. Export is
# an allow-list in the same direction as ingestion: an event type nobody has
# reviewed for safety is left out of the record rather than forwarded into it.
BROKER_EVENT_TYPES = (
    "recursive.job.queued",
    "recursive.job.leased",
    "recursive.job.released",
    "recursive.job.retry_scheduled",
    "recursive.job.completed",
    "recursive.job.failed",
    "recursive.job.cancelled",
)

EXPORTED_EVENT_TYPES = frozenset(ALLOWED_EVENT_TYPES) | frozenset(BROKER_EVENT_TYPES)

# Keys a run event payload may carry into the record. The live stream is built
# from an allow-list already, so this is a second, independent gate: a payload
# key introduced later reaches the browser but not the permanent record until
# somebody has decided it is safe to keep forever.
_SAFE_EVENT_KEYS = frozenset(
    {
        "job_id",
        "turn_id",
        "execution_mode",
        "node",
        "task_summary",
        "result_summary",
        "model_key",
        "tool_label",
        "failure_category",
        "message",
        "usage",
        "occurred_at",
        "node_count",
        "model_call_count",
        "cost_usd",
        "pricing_complete",
        "elapsed_ms",
        "simulation",
        "attempt",
        "worker_id",
        "reason",
        "retry_at",
        "failure_code",
    }
)
_SAFE_NODE_KEYS = frozenset({"external_node_id", "parent_external_node_id", "display_name"})

_BROKER_SOURCE = Path(__file__).with_name("broker.py")
_EVENT_TYPE_LITERAL = re.compile(r'event_type="(recursive\.[a-z_.]+)"')


def emitted_recursive_event_types() -> set[str]:
    """Every ``recursive.*`` event type the broker source actually emits.

    Read from the source rather than a hand-kept list so the test that pins
    the export allow-list fails when a new event type is introduced without a
    decision about whether it belongs in the permanent record.
    """
    return set(_EVENT_TYPE_LITERAL.findall(_BROKER_SOURCE.read_text(encoding="utf-8")))


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _num(value: Decimal | float | None) -> float | None:
    return None if value is None else float(value)


def _usage(row: RecursiveAgentJob | RecursiveAgentNode) -> dict[str, Any]:
    return {
        "model_calls": int(row.model_call_count),
        "input_tokens": int(row.input_tokens),
        "cached_input_tokens": int(row.cached_input_tokens),
        "output_tokens": int(row.output_tokens),
        "cost_usd": float(row.cost_usd),
    }


def _render(payload: Any) -> str:
    """The exact text a packet file holds, so its hash is reproducible."""
    return json.dumps(payload, indent=2, sort_keys=False, default=str)


@dataclass
class RecursiveRecord:
    """Everything the record needs, loaded once and shared by all three sinks."""

    jobs: list[dict[str, Any]] = field(default_factory=list)
    nodes: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    workers: list[dict[str, Any]] = field(default_factory=list)
    results: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def is_empty(self) -> bool:
        return not self.jobs

    @property
    def simulated(self) -> bool:
        """True when any accepted result declared itself a simulation."""
        return any(r.get("runtime", {}).get("is_simulation") for r in self.results.values())

    def totals(self) -> dict[str, Any]:
        return {
            "job_count": len(self.jobs),
            "node_count": len(self.nodes),
            "model_calls": sum(j["usage"]["model_calls"] for j in self.jobs),
            "input_tokens": sum(j["usage"]["input_tokens"] for j in self.jobs),
            "cached_input_tokens": sum(j["usage"]["cached_input_tokens"] for j in self.jobs),
            "output_tokens": sum(j["usage"]["output_tokens"] for j in self.jobs),
            "cost_usd": round(sum(j["usage"]["cost_usd"] for j in self.jobs), 6),
        }

    # -- packet files -------------------------------------------------------
    # Rendered here rather than in exports.py because the manifest hashes the
    # very same strings; two renderers would mean two hashes and a verifier
    # left unable to tell tampering from formatting.

    def packet_files(self) -> dict[str, str]:
        files = {
            "recursive/jobs.json": _render(self.jobs),
            "recursive/nodes.json": _render(self.nodes),
            "recursive/events.json": _render(self.events),
            "recursive/workers.json": _render(self.workers),
        }
        for job_id, result in self.results.items():
            files[f"recursive/results/{job_id}.json"] = _render(result)
        return files

    def digests(self) -> dict[str, str]:
        return {name: sha256_text(content) for name, content in self.packet_files().items()}

    def manifest_block(self) -> dict[str, Any]:
        """The section the provenance manifest carries.

        Jobs and workers appear in full because they are the identity of the
        execution: which machine, which model, under which ceilings. The node
        tree, the event log and the per-job results are bound by digest -- the
        manifest stays a manifest, and the packet stays verifiable against it.
        """
        return {
            "job_count": len(self.jobs),
            "node_count": len(self.nodes),
            "simulated": self.simulated,
            "usage": self.totals(),
            "workers": self.workers,
            "jobs": self.jobs,
            "packet_digests": self.digests(),
        }


def _worker_record(worker: RecursiveWorker) -> dict[str, Any]:
    """Named fields only: the credential hash and prefix must never leave."""
    capabilities = worker.capabilities if isinstance(worker.capabilities, dict) else {}
    profiles = capabilities.get("profiles")
    return {
        "worker_id": str(worker.id),
        "display_name": worker.display_name,
        "status": worker.status,
        "sandbox_mode": worker.sandbox_mode,
        "adapter_version": worker.adapter_version,
        "prime_agent_version": worker.prime_agent_version,
        "capability_profiles": [str(p) for p in profiles] if isinstance(profiles, list) else [],
        "enrolled_at": _iso(worker.enrolled_at),
        "revoked_at": _iso(worker.revoked_at),
    }


def _request_record(job: RecursiveAgentJob) -> dict[str, Any]:
    """What the worker was asked, minus what the packet already holds.

    The transcript and the participant's system prompt are elsewhere in the
    packet in their canonical form; repeating them here would invite two
    copies to disagree. The hash is what binds this job to that request.
    """
    request = job.request_json if isinstance(job.request_json, dict) else {}
    assignment = request.get("assignment") if isinstance(request.get("assignment"), dict) else {}
    execution = request.get("execution") if isinstance(request.get("execution"), dict) else {}
    evidence = request.get("evidence") if isinstance(request.get("evidence"), list) else []
    return {
        "schema_version": request.get("schema_version"),
        "meeting_definition_sha256": assignment.get("meeting_definition_sha256"),
        "turn_sequence": assignment.get("turn_sequence"),
        "round_number": assignment.get("round_number"),
        "capability_profile": execution.get("capability_profile"),
        "allowed_skill_ids": [str(s) for s in (execution.get("allowed_skill_ids") or [])],
        "allow_web": bool(execution.get("allow_web", False)),
        "evidence_keys": [
            str(e.get("evidence_key"))
            for e in evidence
            if isinstance(e, dict) and e.get("evidence_key")
        ],
    }


def _job_record(job: RecursiveAgentJob, node_count: int) -> dict[str, Any]:
    return {
        "job_id": str(job.id),
        "run_turn_id": str(job.run_turn_id),
        "agent_version_id": str(job.agent_version_id),
        "worker_id": str(job.leased_worker_id) if job.leased_worker_id else None,
        "requested_worker_id": str(job.requested_worker_id) if job.requested_worker_id else None,
        "status": job.status,
        "attempt_count": int(job.attempt_count),
        "max_attempts": int(job.max_attempts),
        "model_key": job.model_key,
        "child_model_key": job.child_model_key,
        "capability_profile": job.capability_profile,
        "limits": {
            "max_children": int(job.max_children),
            "max_depth": int(job.max_depth),
            "max_agent_turns": int(job.max_agent_turns),
            "max_tokens": int(job.max_tokens),
            "max_runtime_seconds": int(job.max_runtime_seconds),
            "max_cost_usd": _num(job.max_cost_usd),
        },
        "request_sha256": job.request_sha256,
        "result_sha256": job.result_sha256,
        "request": _request_record(job),
        "usage": _usage(job),
        "node_count": node_count,
        "started_at": _iso(job.started_at),
        "completed_at": _iso(job.completed_at),
        "failure_code": job.failure_code,
        "failure_safe_message": job.failure_safe_message,
    }


def _node_record(node: RecursiveAgentNode) -> dict[str, Any]:
    return {
        "job_id": str(node.job_id),
        "node_id": node.external_node_id,
        "parent_node_id": node.parent_external_node_id,
        "display_name": node.display_name,
        "status": node.status,
        "model_key": node.model_key,
        "task_summary": node.task_summary,
        "result_summary": node.result_summary,
        "cited_evidence_keys": [str(k) for k in (node.cited_evidence_keys or [])],
        "tool_labels": [str(t) for t in (node.tool_labels or [])],
        "usage": _usage(node),
        "started_at": _iso(node.started_at),
        "completed_at": _iso(node.completed_at),
        "failure_safe_message": node.failure_safe_message,
    }


def _event_record(event: RunEvent) -> dict[str, Any]:
    payload = event.payload if isinstance(event.payload, dict) else {}
    safe = {k: v for k, v in payload.items() if k in _SAFE_EVENT_KEYS}
    node = safe.get("node")
    if isinstance(node, dict):
        safe["node"] = {k: v for k, v in node.items() if k in _SAFE_NODE_KEYS}
    elif node is not None:
        safe.pop("node", None)
    return {
        "sequence": int(event.run_sequence),
        "event_type": event.event_type,
        "recorded_at": _iso(event.created_at),
        "payload": safe,
    }


def _result_record(job: RecursiveAgentJob) -> dict[str, Any]:
    """The worker's accepted result as stored, plus the identity it belongs to.

    ``result_json`` never holds the answer text -- that is a transcript turn,
    hashed here so the two can be checked against each other.
    """
    result = job.result_json if isinstance(job.result_json, dict) else {}
    return {
        "job_id": str(job.id),
        "run_turn_id": str(job.run_turn_id),
        "worker_id": str(job.leased_worker_id) if job.leased_worker_id else None,
        "request_sha256": job.request_sha256,
        "result_sha256": job.result_sha256,
        "completed_at": _iso(job.completed_at),
        "final_text_sha256": result.get("final_text_sha256"),
        "citations": result.get("citations", []),
        "limitations": result.get("limitations", []),
        "runtime": result.get("runtime", {}),
        "usage": result.get("usage", {}),
    }


async def load_recursive_record(db: AsyncSession, run: Run) -> RecursiveRecord:
    """Assemble the run's recursive record from the rows this deployment owns."""
    jobs = list(
        (
            await db.execute(
                select(RecursiveAgentJob)
                .where(RecursiveAgentJob.run_id == run.id)
                .order_by(RecursiveAgentJob.created_at, RecursiveAgentJob.id)
            )
        ).scalars()
    )
    if not jobs:
        return RecursiveRecord()

    job_ids = [j.id for j in jobs]
    nodes = list(
        (
            await db.execute(
                select(RecursiveAgentNode)
                .where(RecursiveAgentNode.job_id.in_(job_ids))
                .order_by(RecursiveAgentNode.created_at, RecursiveAgentNode.id)
            )
        ).scalars()
    )
    worker_ids = {j.leased_worker_id for j in jobs if j.leased_worker_id} | {
        j.requested_worker_id for j in jobs if j.requested_worker_id
    }
    workers = (
        list(
            (
                await db.execute(
                    select(RecursiveWorker)
                    .where(RecursiveWorker.id.in_(worker_ids))
                    .order_by(RecursiveWorker.enrolled_at)
                )
            ).scalars()
        )
        if worker_ids
        else []
    )
    events = list(
        (
            await db.execute(
                select(RunEvent)
                .where(RunEvent.run_id == run.id, RunEvent.event_type.in_(EXPORTED_EVENT_TYPES))
                .order_by(RunEvent.run_sequence)
            )
        ).scalars()
    )

    node_counts: dict[Any, int] = {}
    for node in nodes:
        node_counts[node.job_id] = node_counts.get(node.job_id, 0) + 1

    return RecursiveRecord(
        jobs=[_job_record(j, node_counts.get(j.id, 0)) for j in jobs],
        nodes=[_node_record(n) for n in nodes],
        events=[_event_record(e) for e in events],
        workers=[_worker_record(w) for w in workers],
        results={
            str(j.id): _result_record(j)
            for j in jobs
            if j.status == "completed" and j.result_json
        },
    )
