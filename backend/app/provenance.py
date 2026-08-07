"""Run provenance: structured summary validation, citation validation, and
run manifests per specs/run_manifest.schema.json (Draft 2020-12).

Manifests are generated once when a run reaches a terminal state and are
immutable afterwards. Citations from a run summary are validated against the
evidence frozen into the meeting definition.
"""
from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .config import REPO_ROOT, SPECS_DIR
from .models import (
    EvidenceSource,
    MeetingDefinition,
    MeetingDefinitionAgent,
    Run,
    RunCitation,
    RunIntervention,
    RunManifest,
    RunSummary,
    RunTurn,
)

APPLICATION_VERSION = "0.1.0"
UPSTREAM_REPO = "https://github.com/zou-group/virtual-lab"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


@lru_cache
def _schema(name: str) -> dict[str, Any]:
    return json.loads((SPECS_DIR / name).read_text())


@lru_cache
def _git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=5
        )
        return out.stdout.strip() or None if out.returncode == 0 else None
    except Exception:  # noqa: BLE001
        return None


def validate_against_schema(payload: dict[str, Any], schema_name: str) -> list[dict[str, str]]:
    """Return a list of safe validation error records (empty when valid)."""
    import jsonschema

    validator = jsonschema.Draft202012Validator(_schema(schema_name))
    errors = []
    for err in sorted(validator.iter_errors(payload), key=lambda e: str(e.path)):
        errors.append({
            "path": "/".join(str(p) for p in err.absolute_path) or "(root)",
            "message": err.message[:300],
        })
    return errors


def validate_summary(summary_json: dict[str, Any]) -> list[dict[str, str]]:
    return validate_against_schema(summary_json, "meeting_summary.schema.json")


def frozen_evidence(definition: MeetingDefinition) -> list[dict[str, Any]]:
    return list((definition.definition_json or {}).get("evidence", []))


async def create_citations_from_summary(
    db: AsyncSession, run: Run, definition: MeetingDefinition, summary_json: dict[str, Any]
) -> dict[str, int]:
    """Persist run_citations from summary evidence claims, validated against
    the evidence frozen into the meeting definition. Idempotent."""
    existing = (
        await db.execute(select(RunCitation.id).where(RunCitation.run_id == run.id).limit(1))
    ).first()
    if existing is not None:
        return {"created": 0, "validated": 0, "unmatched": 0}

    frozen = frozen_evidence(definition)
    by_key: dict[str, dict[str, Any]] = {e["evidence_key"]: e for e in frozen if e.get("evidence_key")}

    # Also resolve by key against the workspace library, so citations to real
    # library items are linked even if they were not attached (marked unmatched).
    created = validated = unmatched = 0
    for item in summary_json.get("evidence", []) or []:
        key = str(item.get("evidence_id", "")).strip()
        if not key:
            continue
        frozen_item = by_key.get(key)
        source_id: uuid.UUID | None = None
        if frozen_item is not None:
            source_id = uuid.UUID(frozen_item["evidence_source_id"])
            status, notes = "validated", None
            validated += 1
        else:
            source = (
                await db.execute(
                    select(EvidenceSource).where(
                        EvidenceSource.workspace_id == run.workspace_id,
                        EvidenceSource.evidence_key == key,
                    )
                )
            ).scalar_one_or_none()
            if source is not None:
                source_id = source.id
                status = "unmatched_attachment"
                notes = "Cited evidence exists in the library but was not attached to this meeting."
            else:
                status = "unknown_evidence"
                notes = "Cited evidence ID does not exist in this workspace."
            unmatched += 1
        if source_id is None:
            # No FK target — record in run events only via validation summary.
            continue
        db.add(RunCitation(
            workspace_id=run.workspace_id,
            run_id=run.id,
            evidence_source_id=source_id,
            citation_key=key,
            claim_text=str(item.get("claim", ""))[:4000],
            support_type=item.get("support_type", "context"),
            source_locator=item.get("locator"),
            validation_status=status,
            validation_notes=notes,
        ))
        created += 1
    return {"created": created, "validated": validated, "unmatched": unmatched}


async def build_manifest(db: AsyncSession, run: Run) -> dict[str, Any]:
    # Imported here rather than at module scope: the recursive record hashes
    # its files with this module's sha256_text, so a top-level import would
    # close a cycle between the two.
    from .recursive.record import load_recursive_record

    definition = await db.get(MeetingDefinition, run.meeting_definition_id)
    assert definition is not None
    def_agents = list(
        (
            await db.execute(
                select(MeetingDefinitionAgent)
                .where(MeetingDefinitionAgent.meeting_definition_id == definition.id)
                .order_by(MeetingDefinitionAgent.position)
            )
        ).scalars()
    )
    agent_rows = (
        await db.execute(
            text(
                """
                SELECT v.id AS version_id, v.agent_profile_id, v.system_prompt_sha256, p.title
                FROM agent_versions v JOIN agent_profiles p ON p.id = v.agent_profile_id
                WHERE v.id = ANY(:ids)
                """
            ),
            {"ids": [str(a.agent_version_id) for a in def_agents]},
        )
    ).mappings().all()
    agents_by_version = {row["version_id"]: row for row in agent_rows}
    model_rows = (
        await db.execute(
            text("SELECT id, model_key FROM provider_models WHERE id = ANY(:ids)"),
            # As with the provider configs below: a participant executed by an
            # external worker has no provider model, and querying for the
            # string "None" is a cast error, not an empty result.
            {
                "ids": list(
                    {
                        str(a.provider_model_id)
                        for a in def_agents
                        if a.provider_model_id is not None
                    }
                )
            },
        )
    ).mappings().all()
    model_keys = {row["id"]: row["model_key"] for row in model_rows}
    provider_rows = (
        await db.execute(
            text(
                "SELECT id, provider_type, endpoint_fingerprint FROM provider_configs "
                "WHERE id = ANY(:ids)"
            ),
            # A participant executed by an external worker has no provider
            # config; skip it rather than querying for the string "None".
            {
                "ids": list(
                    {
                        str(a.provider_config_id)
                        for a in def_agents
                        if a.provider_config_id is not None
                    }
                )
            },
        )
    ).mappings().all()

    tool_ids: set[str] = set()
    for a in def_agents:
        tool_ids.update(str(t) for t in (a.tool_definition_ids or []))
    tools: list[dict[str, Any]] = []
    if tool_ids:
        tool_rows = (
            await db.execute(
                text("SELECT id, slug, version, policy FROM tool_definitions WHERE id = ANY(:ids)"),
                {"ids": list(tool_ids)},
            )
        ).mappings().all()
        tools = [
            {
                "tool_id": str(row["id"]),
                "name": row["slug"],
                "version": str(row["version"]),
                "policy": row["policy"] or {},
            }
            for row in tool_rows
        ]

    interventions = list(
        (
            await db.execute(
                select(RunIntervention)
                .where(RunIntervention.run_id == run.id)
                .order_by(RunIntervention.created_at)
            )
        ).scalars()
    )

    turns = list(
        (
            await db.execute(
                select(RunTurn.sequence, RunTurn.response_sha256)
                .where(RunTurn.run_id == run.id, RunTurn.status == "completed")
                .order_by(RunTurn.sequence)
            )
        ).all()
    )
    transcript_sha = sha256_text(canonical_json([
        {"sequence": seq, "response_sha256": sha} for seq, sha in turns
    ]))

    summary = await db.get(RunSummary, run.id)
    summary_sha = summary.summary_sha256 if summary else EMPTY_SHA256

    status_map = {"completed": "completed", "failed": "failed", "cancelled": "cancelled",
                  "budget_stopped": "budget_stopped"}

    manifest: dict[str, Any] = {
        "manifest_version": "1.0",
        "run": {
            "id": str(run.id),
            "workspace_id": str(run.workspace_id),
            "project_id": str(run.project_id),
            "status": status_map.get(run.status, "failed"),
            "created_by": str(run.created_by) if run.created_by else None,
            "created_at": run.created_at.isoformat(),
            "started_at": run.started_at.isoformat() if run.started_at else None,
            "completed_at": run.completed_at.isoformat() if run.completed_at else None,
            "review_status": run.review_status,
            "demo_mode": run.demo_mode,
        },
        "software": {
            "application_version": APPLICATION_VERSION,
            "git_commit": _git_commit(),
            "python_version": platform.python_version(),
            "database_revision": (
                await db.execute(text("SELECT version_num FROM alembic_version"))
            ).scalar_one_or_none(),
            "upstream_package": {
                "name": "virtual-lab",
                "source_repository": UPSTREAM_REPO,
                "version_or_commit": "vendored-src",
                "license": "MIT",
            },
        },
        "meeting": {
            "definition_id": str(definition.id),
            "definition_sha256": definition.definition_sha256,
            "meeting_type": definition.meeting_type,
            "agenda": definition.agenda,
            "questions": list(definition.questions or []),
            "rules": list(definition.rules or []),
            "rounds": max(1, int(definition.rounds)),
            "temperature": float(definition.default_temperature),
            "seed": definition.seed,
            "budget": definition.budget or {},
        },
        "agents": [
            {
                "agent_id": str(
                    (agents_by_version.get(a.agent_version_id) or {}).get("agent_profile_id")
                    or a.agent_version_id
                ),
                "version_id": str(a.agent_version_id),
                "title": (agents_by_version.get(a.agent_version_id) or {}).get("title") or "(unknown agent)",
                "role_type": a.role_type,
                "system_prompt_sha256": (
                    (agents_by_version.get(a.agent_version_id) or {}).get("system_prompt_sha256")
                    or EMPTY_SHA256
                ),
                "provider_config_id": str(a.provider_config_id),
                "model_id": model_keys.get(a.provider_model_id, str(a.provider_model_id)),
                "temperature_override": float(a.temperature_override) if a.temperature_override is not None else None,
                "tool_ids": [str(t) for t in (a.tool_definition_ids or [])],
            }
            for a in def_agents
        ],
        "evidence": [
            {
                "evidence_id": e.get("evidence_key", ""),
                "source_type": e.get("source_type", "note"),
                "title": e.get("title", ""),
                "citation": e.get("citation"),
                "source_url": e.get("source_url"),
                "content_sha256": e.get("content_sha256") or EMPTY_SHA256,
                "included_chunk_ids": [str(c) for c in e.get("chunk_ids", [])],
                "retrieved_at": e.get("retrieved_at"),
            }
            for e in frozen_evidence(definition)
        ],
        "providers": [
            {
                "provider_config_id": str(row["id"]),
                "provider_type": row["provider_type"],
                "endpoint_fingerprint": row["endpoint_fingerprint"] or EMPTY_SHA256,
                "organization": None,
                "secret_reference": None,
            }
            for row in provider_rows
        ],
        "tools": tools,
        "usage": {
            "provider_calls": run.provider_call_count,
            "tool_calls": run.tool_call_count,
            "input_tokens": int(run.input_tokens),
            "output_tokens": int(run.output_tokens),
            "cached_input_tokens": int(run.cached_input_tokens),
            "cost_usd": float(run.actual_cost_usd),
            "wall_seconds": float(run.wall_seconds),
        },
        "interventions": [
            {
                "id": str(iv.id),
                "actor_id": str(iv.actor_user_id),
                "kind": iv.kind,
                "created_at": iv.created_at.isoformat(),
                "content_sha256": iv.content_sha256 or EMPTY_SHA256,
            }
            for iv in interventions
        ],
        # Always present, including as an explicit zero: a reader must be able
        # to tell "no participant ran on an external machine" from "this
        # manifest predates the question being asked".
        "recursive_execution": (await load_recursive_record(db, run)).manifest_block(),
        "lineage": {
            "parent_run_ids": [str(run.parent_run_id)] if run.parent_run_id else [],
            "source_run_ids": [],
            "ensemble_member_run_ids": [],
            "merge_run_id": None,
        },
        "integrity": {
            "transcript_sha256": transcript_sha,
            "summary_sha256": summary_sha,
            "manifest_payload_sha256": EMPTY_SHA256,  # replaced below
            "signature": None,
            "signature_algorithm": None,
        },
    }
    payload_without_integrity = {k: v for k, v in manifest.items() if k != "integrity"}
    payload_sha = sha256_text(canonical_json(payload_without_integrity))
    manifest["integrity"]["manifest_payload_sha256"] = payload_sha
    return manifest


_TERMINAL_STATUS_TEXT = {
    "completed": "completed",
    "failed": "failed before completing",
    "cancelled": "was cancelled before completing",
    "budget_stopped": "was stopped because it reached its budget limit",
}

# Derived so the two cannot drift: every terminal status needs outcome text.
TERMINAL_RUN_STATUSES = frozenset(_TERMINAL_STATUS_TEXT)


async def ensure_terminal_summary(db: AsyncSession, run: Run) -> RunSummary:
    """Ensure a schema-valid structured summary exists for a terminal run.

    The successful completion path writes the real summary; this covers the
    failed / cancelled / budget_stopped transitions (and historical backfill)
    with an explicit terminal-outcome summary carrying the failure metadata.
    Idempotent; raises if the generated summary fails schema validation.
    """
    existing = await db.get(RunSummary, run.id)
    if existing is not None:
        return existing
    definition = await db.get(MeetingDefinition, run.meeting_definition_id)
    agenda = (definition.agenda if definition else None) or "(no agenda)"
    questions = list(definition.questions or []) if definition else []
    outcome = _TERMINAL_STATUS_TEXT.get(run.status, "ended abnormally")
    failure_bits = []
    if run.failure_code:
        failure_bits.append(f"failure code: {run.failure_code}")
    if run.failure_safe_message:
        failure_bits.append(run.failure_safe_message)
    failure_text = f" ({'; '.join(failure_bits)})" if failure_bits else ""
    executive = (
        f"This meeting run {outcome}{failure_text}. "
        "No scientific conclusions were produced; this structured summary "
        "records the terminal outcome for provenance and reproducibility."
    )
    summary_json: dict[str, Any] = {
        "agenda": agenda,
        "executive_summary": executive,
        "role_contributions": [],
        "recommendation": {
            "decision": f"No recommendation — the run {outcome}.",
            "rationale": "The meeting did not reach a completed synthesis." + failure_text,
            "conditions": [],
        },
        "question_answers": [
            {
                "question": q,
                "answer": f"Not answered — the run {outcome}.",
                "evidence_ids": [],
                "confidence": 0.0,
            }
            for q in questions
        ],
        "evidence": [],
        "assumptions": [],
        "disagreements": [],
        "risks_and_limitations": [
            {
                "risk": f"The run {outcome}; any partial transcript content is unreviewed.",
                "severity": "high",
                "likelihood": "likely",
                "mitigation": "Re-run the meeting to obtain a completed, reviewed summary.",
            }
        ],
        "next_steps": [],
        "confidence": {
            "overall": 0.0,
            "basis": f"Terminal outcome record for a run that {outcome}.",
            "uncertainty": "No completed synthesis exists for this run.",
        },
        "disclosure": {
            "model_generated": True,
            "human_review_required": True,
            "limitations": [
                "This summary documents a terminal run outcome; it contains no scientific findings.",
            ],
        },
    }
    errors = validate_summary(summary_json)
    if errors:
        raise ValueError(f"Terminal summary failed schema validation: {errors[:3]}")
    # Render the full structured record with the same renderer as the normal
    # completion path, so a terminal run never carries a stub document.
    # Local import: engine imports this module at load time.
    from .engine import _summary_markdown  # noqa: PLC0415
    from .providers import get_demo_provider  # noqa: PLC0415

    disclosure_line = (
        get_demo_provider().disclosure
        if run.demo_mode
        else (
            "AI-generated decision support produced by a configured model "
            "provider. Requires human scientific review; not a validated result."
        )
    )
    title = (definition.title if definition else None) or "Run outcome"
    row = RunSummary(
        run_id=run.id,
        workspace_id=run.workspace_id,
        summary_markdown=_summary_markdown(title, disclosure_line, summary_json, ""),
        summary_json=summary_json,
        schema_version="1.0",
        summary_sha256=sha256_text(canonical_json(summary_json)),
        validation_status="valid",
        validation_errors=[],
    )
    db.add(row)
    await db.flush()
    return row


async def ensure_manifest_safe(db: AsyncSession, run: Run) -> tuple[RunManifest | None, str | None]:
    """Idempotently ensure a terminal run has a structured summary and a
    manifest, without letting unexpected errors abort the caller.
    Returns (manifest, error_message).

    ``(None, None)`` means the write was deliberately skipped: the run is no
    longer terminal because a user requeued it (see the retry endpoint) between
    the terminal commit and this call. Writing then would stamp the abandoned
    attempt's summary onto a run that is about to continue, and the completion
    path reuses whatever summary it finds — so the resumed run would finish
    carrying a summary describing only its truncated prefix.

    The transaction is committed on success and rolled back on failure so a
    partial write never corrupts the surrounding unit of work. The summary is
    ensured first so the manifest's summary hash covers it.
    """
    try:
        # Serialize against a concurrent retry: both sides take the run's row
        # lock, so whichever commits first wins cleanly. If the requeue landed
        # first this attempt is stale and must write nothing; if it lands after,
        # it deletes the artifacts written here.
        status = (
            await db.execute(select(Run.status).where(Run.id == run.id).with_for_update())
        ).scalar_one_or_none()
        if status not in TERMINAL_RUN_STATUSES:
            await db.rollback()
            return None, None
        await ensure_terminal_summary(db, run)
        manifest = await ensure_manifest(db, run)
        await db.commit()
        return manifest, None
    except Exception as exc:  # noqa: BLE001 - terminal path must stay robust
        await db.rollback()
        return None, str(exc)[:300]


async def ensure_manifest(db: AsyncSession, run: Run) -> RunManifest:
    """Create the run manifest if missing (idempotent); validates the schema."""
    existing = await db.get(RunManifest, run.id)
    if existing is not None:
        return existing
    manifest = await build_manifest(db, run)
    errors = validate_against_schema(manifest, "run_manifest.schema.json")
    if errors:
        # Fail loudly: a manifest that does not match its schema must not be
        # silently persisted.
        raise ValueError(f"Run manifest failed schema validation: {errors[:3]}")
    row = RunManifest(
        run_id=run.id,
        workspace_id=run.workspace_id,
        manifest_version=manifest["manifest_version"],
        manifest_json=manifest,
        manifest_payload_sha256=manifest["integrity"]["manifest_payload_sha256"],
        transcript_sha256=manifest["integrity"]["transcript_sha256"],
        summary_sha256=manifest["integrity"]["summary_sha256"],
    )
    db.add(row)
    return row
