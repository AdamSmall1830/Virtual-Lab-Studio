"""Reproducibility export packets.

A packet is a ZIP with the transcript, structured summary, manifest, evidence
list, agent prompts/versions, meeting definition, usage, interventions,
reviews, hashes, and a README. It never contains secrets or unrestricted
storage URLs; downloads go through an authorized server route.
"""
from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    MeetingDefinition,
    Run,
    RunCitation,
    RunIntervention,
    RunManifest,
    RunReview,
    RunSummary,
    RunTurn,
)
from .provenance import canonical_json, frozen_evidence, sha256_text
from .recursive.record import load_recursive_record

README_TEMPLATE = """# Virtual Lab Studio — Reproducibility Packet

Run: {run_id}
Exported at: {exported_at}
Status: {status}

This packet documents a Virtual Lab Studio meeting run for audit and
reproduction. All content is model-generated unless marked otherwise and
requires human scientific review before use.

## Contents
- `manifest.json` — provenance manifest (schema: run_manifest.schema.json v1.0)
- `meeting_definition.json` — the frozen meeting definition used by the run
- `transcript.json` / `transcript.md` — ordered agent turns
- `summary.json` / `summary.md` — structured meeting summary
- `evidence.json` — attached evidence with stable IDs and SHA-256 hashes
- `citations.json` — summary citations and their validation status
- `agents.json` — agent prompt versions (system prompt hashes)
- `usage.json` — provider/tool call counts, tokens, cost
- `interventions.json` — human interventions during the run
- `reviews.json` — human review decisions recorded for this run
- `recursive/jobs.json` — participant turns delegated to an external worker,
  with the ceilings imposed on each and the outcome recorded. Empty when no
  participant ran on an external machine.
- `recursive/workers.json` — the enrolled machines those jobs ran on
  (identity and version only; no credential material)
- `recursive/nodes.json` — the sub-agent tree each job reported: summaries,
  labels, usage. Deliberately not a reasoning transcript.
- `recursive/events.json` — the safe progress log for those jobs, filtered by
  the same allow-list as the live stream
- `recursive/results/<job_id>.json` — the accepted result per job: citations,
  limitations, runtime and usage. The answer text itself is the matching
  transcript turn, bound here by its SHA-256.
- `hashes.json` — SHA-256 of every file in this packet

## Integrity
Verify any file: `sha256sum <file>` and compare with `hashes.json`.
The transcript and summary hashes also appear in `manifest.json` under
`integrity`, which is itself hashed (`manifest_payload_sha256`).
The `recursive/` files are bound the same way: their hashes appear in
`manifest.json` under `recursive_execution.packet_digests`, so a recursive
record cannot be edited without breaking the manifest payload hash.

This packet intentionally excludes provider API keys, session data, raw
storage URLs, worker credentials, host filesystem paths, and any workspace
secrets. Nothing an external worker reported reaches this packet except
through a reviewed allow-list of fields.
"""


async def build_export_packet(db: AsyncSession, run: Run) -> bytes:
    definition = await db.get(MeetingDefinition, run.meeting_definition_id)
    summary = await db.get(RunSummary, run.id)
    manifest = await db.get(RunManifest, run.id)
    turns = list(
        (
            await db.execute(
                select(RunTurn).where(RunTurn.run_id == run.id).order_by(RunTurn.sequence)
            )
        ).scalars()
    )
    citations = list(
        (
            await db.execute(
                select(RunCitation).where(RunCitation.run_id == run.id).order_by(RunCitation.created_at)
            )
        ).scalars()
    )
    interventions = list(
        (
            await db.execute(
                select(RunIntervention)
                .where(RunIntervention.run_id == run.id)
                .order_by(RunIntervention.created_at)
            )
        ).scalars()
    )
    reviews = list(
        (
            await db.execute(
                select(RunReview).where(RunReview.run_id == run.id).order_by(RunReview.created_at)
            )
        ).scalars()
    )
    agent_rows = (
        await db.execute(
            text(
                """
                SELECT DISTINCT p.id AS profile_id, p.title, v.id AS version_id,
                       v.version_number, v.expertise, v.goal, v.role,
                       v.system_prompt, v.system_prompt_sha256
                FROM run_turns t
                JOIN agent_versions v ON v.id = t.agent_version_id
                JOIN agent_profiles p ON p.id = v.agent_profile_id
                WHERE t.run_id = :run_id
                """
            ),
            {"run_id": str(run.id)},
        )
    ).mappings().all()

    transcript_json = [
        {
            "sequence": t.sequence,
            "round": t.round_number,
            "role_type": t.role_type,
            "status": t.status,
            "response_text": t.response_text,
            "response_sha256": t.response_sha256,
            "system_prompt_sha256": t.system_prompt_sha256,
            "input_tokens": t.input_tokens,
            "output_tokens": t.output_tokens,
            "started_at": t.started_at.isoformat() if t.started_at else None,
            "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        }
        for t in turns
    ]
    transcript_md_parts = [f"# Transcript — run {run.id}\n"]
    for t in turns:
        transcript_md_parts.append(
            f"\n## Turn {t.sequence} (round {t.round_number}, {t.role_type})\n\n{t.response_text or ''}\n"
        )
    exported_at = datetime.now(timezone.utc).isoformat()

    files: dict[str, str] = {
        "manifest.json": json.dumps(manifest.manifest_json if manifest else None, indent=2, default=str),
        "meeting_definition.json": json.dumps(
            definition.definition_json if definition else None, indent=2, default=str
        ),
        "transcript.json": json.dumps(transcript_json, indent=2),
        "transcript.md": "".join(transcript_md_parts),
        "summary.json": json.dumps(summary.summary_json if summary else None, indent=2, default=str),
        "summary.md": summary.summary_markdown if summary else "(no summary was produced)",
        "evidence.json": json.dumps(
            frozen_evidence(definition) if definition else [], indent=2, default=str
        ),
        "citations.json": json.dumps(
            [
                {
                    "citation_key": c.citation_key,
                    "claim_text": c.claim_text,
                    "support_type": c.support_type,
                    "source_locator": c.source_locator,
                    "validation_status": c.validation_status,
                    "validation_notes": c.validation_notes,
                }
                for c in citations
            ],
            indent=2,
        ),
        "agents.json": json.dumps(
            [
                {
                    "agent_id": str(r["profile_id"]),
                    "title": r["title"],
                    "version_id": str(r["version_id"]),
                    "version_number": r["version_number"],
                    "expertise": r["expertise"],
                    "goal": r["goal"],
                    "role": r["role"],
                    "system_prompt": r["system_prompt"],
                    "system_prompt_sha256": r["system_prompt_sha256"],
                }
                for r in agent_rows
            ],
            indent=2,
        ),
        "usage.json": json.dumps(
            {
                "provider_calls": run.provider_call_count,
                "tool_calls": run.tool_call_count,
                "input_tokens": int(run.input_tokens),
                "cached_input_tokens": int(run.cached_input_tokens),
                "output_tokens": int(run.output_tokens),
                "actual_cost_usd": float(run.actual_cost_usd),
                "wall_seconds": float(run.wall_seconds),
                "demo_mode": run.demo_mode,
            },
            indent=2,
        ),
        "interventions.json": json.dumps(
            [
                {
                    "id": str(iv.id),
                    "kind": iv.kind,
                    "actor_id": str(iv.actor_user_id),
                    "content": iv.content,
                    "content_sha256": iv.content_sha256,
                    "applied_at_checkpoint": iv.applied_at_checkpoint,
                    "created_at": iv.created_at.isoformat(),
                }
                for iv in interventions
            ],
            indent=2,
        ),
        "reviews.json": json.dumps(
            [
                {
                    "id": str(r.id),
                    "status": r.status,
                    "rubric_version": r.rubric_version,
                    "ratings": r.ratings,
                    "comments_markdown": r.comments_markdown,
                    "created_at": r.created_at.isoformat(),
                }
                for r in reviews
            ],
            indent=2,
        ),
    }
    # Rendered by the record itself, not re-serialised here: the manifest
    # hashes these exact strings, so a second renderer would silently break
    # the only link that makes the recursive files verifiable.
    files.update((await load_recursive_record(db, run)).packet_files())

    hashes = {name: sha256_text(content) for name, content in files.items()}
    files["hashes.json"] = json.dumps(hashes, indent=2)
    files["README.md"] = README_TEMPLATE.format(
        run_id=run.id, exported_at=exported_at, status=run.status
    )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in sorted(files.items()):
            zf.writestr(name, content)
    return buffer.getvalue()
