"""The PDF report must be readable, honest, and obey the section selection.

A report that circulates outside the app carries no surrounding UI, so every
provenance warning has to travel inside the paper itself. These tests pin the
three things a reader depends on: the conclusions are always present, the
appendices appear only when asked for, and the model-generated / review /
demo status is stated on the page rather than assumed.
"""
from __future__ import annotations

import io
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pypdf
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import canonical_json, execute_run, sha256_text  # noqa: E402
from app.models import (  # noqa: E402
    AgentProfile,
    AgentVersion,
    MeetingDefinition,
    MeetingDefinitionAgent,
    Project,
    ProviderConfig,
    ProviderModel,
    Run,
    RunSummary,
    Workspace,
)
from app.pdf_report import SECTION_TITLES, build_pdf_report  # noqa: E402
from app.provenance import ensure_manifest  # noqa: E402
from app.schemas import PDF_REPORT_SECTIONS  # noqa: E402
from app.seed import seed  # noqa: E402


async def _make_demo_run(db) -> Run:
    workspace = (
        await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))
    ).scalar_one()
    project = (
        await db.execute(select(Project).where(Project.workspace_id == workspace.id).limit(1))
    ).scalar_one()
    provider = (
        await db.execute(
            select(ProviderConfig).where(
                ProviderConfig.workspace_id == workspace.id,
                ProviderConfig.provider_type == "demo",
            )
        )
    ).scalar_one()
    model = (
        await db.execute(
            select(ProviderModel).where(ProviderModel.provider_config_id == provider.id)
        )
    ).scalar_one()

    async def version_for(slug: str) -> AgentVersion:
        profile = (
            await db.execute(
                select(AgentProfile).where(
                    AgentProfile.workspace_id.is_(None), AgentProfile.slug == slug
                )
            )
        ).scalar_one()
        return (
            await db.execute(
                select(AgentVersion)
                .where(AgentVersion.agent_profile_id == profile.id)
                .order_by(AgentVersion.version_number.desc())
                .limit(1)
            )
        ).scalar_one()

    lead = await version_for("principal-investigator")
    member = await version_for("scientific-critic")
    definition_json = {"test": str(uuid.uuid4())}
    definition = MeetingDefinition(
        workspace_id=workspace.id, project_id=project.id, title="PDF report run",
        meeting_type="team", agenda="Should we run the pilot?",
        questions=["Is the assay ready?"], rules=["Cite evidence."], contexts=[],
        rounds=1, default_temperature=0.2,
        budget={"max_provider_calls": 50, "max_cost_usd": 5},
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
    run = Run(
        workspace_id=workspace.id, project_id=project.id,
        meeting_definition_id=definition.id, status="leased", demo_mode=True,
        lease_owner="test-worker",
        lease_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    db.add(run)
    await db.commit()
    return run


def _text(payload: bytes) -> str:
    reader = pypdf.PdfReader(io.BytesIO(payload))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def test_section_catalogue_matches_the_api_contract():
    """The picker offers exactly what the renderer can draw."""
    assert tuple(SECTION_TITLES) == tuple(PDF_REPORT_SECTIONS)


async def test_report_carries_conclusions_and_provenance_warnings(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db)
        run_id = run.id

    await execute_run(sessionmaker, run_id, "test-worker")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        await ensure_manifest(db, run)
        await db.commit()
        payload = await build_pdf_report(db, run, list(PDF_REPORT_SECTIONS))

    assert payload.startswith(b"%PDF")
    text = _text(payload)

    # The conclusions record is the report; it is never optional.
    assert "Conclusions" in text
    assert "Executive summary" in text

    # Warnings a reader needs even with no app around the document. The demo
    # footer swaps in its own wording, so match case-insensitively.
    assert "model-generated" in text.lower()
    assert "not been approved by a human reviewer" in text
    # demo_mode runs must never read as real model output.
    assert "Simulated run" in text
    assert "SIMULATED" in text

    # Pages get separated from their cover, so every one of them has to carry
    # authorship, review status and demo status on its own.
    reader = pypdf.PdfReader(io.BytesIO(payload))
    assert len(reader.pages) > 1
    for i, page in enumerate(reader.pages):
        footer = (page.extract_text() or "").lower()
        assert "review: unreviewed" in footer, f"page {i + 1} has no review status"
        assert "model-generated" in footer, f"page {i + 1} has no authorship note"
        assert "simulated demo run" in footer, f"page {i + 1} has no demo warning"


async def test_sections_appear_only_when_requested(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db)
        run_id = run.id

    await execute_run(sessionmaker, run_id, "test-worker")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        await ensure_manifest(db, run)
        await db.commit()
        minimal = await build_pdf_report(db, run, [])
        with_transcript = await build_pdf_report(db, run, ["transcript", "provenance"])

    minimal_text = _text(minimal)
    full_text = _text(with_transcript)

    assert "Full transcript" not in minimal_text
    assert "Provenance and integrity" not in minimal_text
    assert "Executive summary" in minimal_text

    assert "Full transcript" in full_text
    assert "Provenance and integrity" in full_text
    # Not requested, so still absent even in the larger document.
    assert "Agents and system prompts" not in full_text
    assert len(with_transcript) > len(minimal)


async def test_report_states_a_missing_summary_instead_of_failing(sessionmaker):
    """A run with no conclusions still produces a document that says so."""
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db)
        run_id = run.id

    await execute_run(sessionmaker, run_id, "test-worker")

    async with sessionmaker() as db:
        summary = await db.get(RunSummary, run_id)
        if summary is not None:
            await db.delete(summary)
            await db.commit()
        run = await db.get(Run, run_id)
        payload = await build_pdf_report(db, run, ["provenance"])

    text = _text(payload)
    assert payload.startswith(b"%PDF")
    # Callout titles are typeset in caps.
    assert "no structured conclusions were recorded" in text.lower()


async def test_unicode_from_model_output_does_not_break_rendering(sessionmaker):
    """Model text is full of dashes, quotes and symbols the base fonts lack."""
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db)
        run_id = run.id

    await execute_run(sessionmaker, run_id, "test-worker")

    async with sessionmaker() as db:
        summary = await db.get(RunSummary, run_id)
        payload_json = dict(summary.summary_json)
        payload_json["executive_summary"] = (
            "Δ between arms ≈ 0.42 — “borderline” per the 95% CI; see §3 ± 0.1 → revisit."
        )
        summary.summary_json = payload_json
        await db.commit()
        run = await db.get(Run, run_id)
        payload = await build_pdf_report(db, run, [])

    text = _text(payload)
    assert "borderline" in text
    assert "revisit" in text


async def test_off_schema_summary_renders_and_accounts_for_what_it_skipped(sessionmaker):
    """A record that has drifted off-schema is exactly what a reader must see.

    summary_json is validated on write, but a validator change, a hand-edited
    row, or a future migration can leave a stored record whose shape the
    renderer does not expect. Refusing to typeset it would bury the problem
    behind a failed export, so the renderer coerces what it can, skips what it
    cannot, and says on the page that it skipped something.
    """
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_demo_run(db)
        run_id = run.id

    await execute_run(sessionmaker, run_id, "test-worker")

    hostile = {
        # Scalars where objects belong.
        "recommendation": {
            "decision": "Proceed with the pilot",
            "conditions": "not-a-list",
            "alternatives_considered": [
                None,
                "a bare string",
                {"alternative": "Wait a quarter", "reason_not_selected": "Too slow"},
            ],
        },
        # Objects where scalars belong, and a hash-like unbroken token that has
        # to be broken across a narrow column rather than overflow it.
        "question_answers": [
            {
                "question": "Is the assay ready?",
                "answer": "Yes. Trace " + "f0" * 90,
                "confidence": "high",
                "evidence_ids": [None, {"nested": True}, "EV-1"],
                "open_issue": None,
            },
            ["not", "a", "mapping"],
            42,
        ],
        "disagreements": [{"topic": "Sample size", "positions": {"not": "a list"}}, "junk"],
        "assumptions": None,
        "risks_and_limitations": [{"risk": "Underpowered", "severity": ["high"]}],
        "next_steps": "should have been a list",
        "evidence": [{"evidence_id": "EV-1", "claim": "x", "locator": None}, None],
        "role_contributions": [{"agent_title": None, "contribution": {"nope": 1}}],
        "confidence": "0.9",
        "disclosure": ["limitations", "as", "a", "list"],
        "executive_summary": {"still": "an object"},
    }

    async with sessionmaker() as db:
        summary = await db.get(RunSummary, run_id)
        summary.summary_json = hostile
        await db.commit()
        run = await db.get(Run, run_id)
        payload = await build_pdf_report(db, run, list(PDF_REPORT_SECTIONS))

    assert payload.startswith(b"%PDF")
    text = _text(payload)
    # The good entries still made it onto the page...
    assert "Wait a quarter" in text
    assert "Is the assay ready?" in text
    # ...and the reader is told the record was not fully displayable rather
    # than being left to assume the omissions were deliberate.
    assert "could not be displayed" in text
