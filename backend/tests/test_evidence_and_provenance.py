"""Evidence library, citations, manifests, exports, and blinded comparisons.

Runs against the development database like the other integration tests; every
run is leased to a fake worker with a far-future expiry so the live dev worker
cannot race the test.
"""
from __future__ import annotations

import io
import json
import sys
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import canonical_json, execute_run, sha256_text  # noqa: E402
from app.evidence import (  # noqa: E402
    allocate_evidence_key,
    build_chunks,
    extract_segments,
    persist_chunks,
)
from app.exports import build_export_packet  # noqa: E402
from app.models import (  # noqa: E402
    AgentProfile,
    AgentVersion,
    EvidenceChunk,
    EvidenceSource,
    MeetingDefinition,
    MeetingDefinitionAgent,
    ProviderConfig,
    ProviderModel,
    Project,
    Run,
    RunCitation,
    RunManifest,
    RunSummary,
    Workspace,
)
from app.provenance import (  # noqa: E402
    create_citations_from_summary,
    ensure_manifest,
    validate_against_schema,
    validate_summary,
)
from app.seed import seed  # noqa: E402


async def _demo_setup(db):
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
    return workspace, project, provider, model


async def _version_for(db, slug: str) -> AgentVersion:
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


async def _make_run_with_evidence(db, evidence_snapshot: list[dict]) -> Run:
    workspace, project, provider, model = await _demo_setup(db)
    lead = await _version_for(db, "principal-investigator")
    member = await _version_for(db, "scientific-critic")
    definition_json = {"test": str(uuid.uuid4()), "evidence": evidence_snapshot}
    definition = MeetingDefinition(
        workspace_id=workspace.id, project_id=project.id, title="Evidence run",
        meeting_type="team", agenda="Test agenda", questions=["Q1"], rules=[],
        contexts=[], rounds=1, default_temperature=0.2,
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


# ---------------------------------------------------------------------------
# evidence extraction and chunking
# ---------------------------------------------------------------------------

def test_extract_and_chunk_text():
    text_data = ("Paragraph one about films.\n\n" + "x" * 3000 + "\n\nShort closing paragraph.").encode()
    segments = extract_segments(text_data, "text/plain")
    assert [s.locator for s in segments] == ["paragraph 1", "paragraph 2", "paragraph 3"]
    chunks = build_chunks(segments)
    assert len(chunks) >= 2
    joined = "".join(c[1] for c in chunks).replace("\n\n", "")
    assert "Paragraph one about films." in chunks[0][1]
    assert "Short closing paragraph." in chunks[-1][1]
    assert "x" * 100 in joined


async def test_allocate_stable_evidence_keys(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        workspace = (await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))).scalar_one()
        key1 = await allocate_evidence_key(db, workspace.id)
        assert key1.startswith("S-") and len(key1) == 6
        project = (
            await db.execute(select(Project).where(Project.workspace_id == workspace.id).limit(1))
        ).scalar_one()
        source = EvidenceSource(
            workspace_id=workspace.id, project_id=project.id, evidence_key=key1,
            source_type="note", title="Key test note",
            content_sha256=sha256_text("body"), processing_status="ready",
            metadata_json={"content": "body"},
        )
        db.add(source)
        await db.commit()
        key2 = await allocate_evidence_key(db, workspace.id)
        assert int(key2[2:]) == int(key1[2:]) + 1
        source.archived_at = datetime.now(timezone.utc)
        await db.commit()


async def test_seeded_demo_evidence_has_chunks(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        workspace = (await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))).scalar_one()
        for key in ("DEMO-EVIDENCE-001", "DEMO-EVIDENCE-002"):
            source = (
                await db.execute(
                    select(EvidenceSource).where(
                        EvidenceSource.workspace_id == workspace.id,
                        EvidenceSource.evidence_key == key,
                    )
                )
            ).scalar_one()
            chunk_count = len(list(
                (await db.execute(
                    select(EvidenceChunk).where(EvidenceChunk.evidence_source_id == source.id)
                )).scalars()
            ))
            assert chunk_count >= 1


# ---------------------------------------------------------------------------
# summary + manifest schema validation
# ---------------------------------------------------------------------------

def test_summary_schema_rejects_bad_payload():
    errors = validate_summary({"agenda": "x"})
    assert errors  # missing most required keys


async def test_run_produces_valid_manifest_and_citations(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        workspace = (await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))).scalar_one()
        demo1 = (
            await db.execute(
                select(EvidenceSource).where(
                    EvidenceSource.workspace_id == workspace.id,
                    EvidenceSource.evidence_key == "DEMO-EVIDENCE-001",
                )
            )
        ).scalar_one()
        chunks = list(
            (await db.execute(
                select(EvidenceChunk).where(EvidenceChunk.evidence_source_id == demo1.id)
            )).scalars()
        )
        snapshot = [{
            "evidence_source_id": str(demo1.id),
            "evidence_key": demo1.evidence_key,
            "source_type": demo1.source_type,
            "title": demo1.title,
            "citation": demo1.citation,
            "source_url": demo1.source_url,
            "content_sha256": demo1.content_sha256,
            "chunk_ids": [str(c.id) for c in chunks],
            "retrieved_at": demo1.created_at.isoformat(),
        }]
        run = await _make_run_with_evidence(db, snapshot)
        run_id = run.id

    await execute_run(sessionmaker, run_id, "test-worker")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        summary = await db.get(RunSummary, run_id)
        assert summary is not None and summary.validation_status == "valid"
        assert validate_summary(summary.summary_json) == []

        manifest = await db.get(RunManifest, run_id)
        assert manifest is not None
        assert manifest.manifest_version == "1.0"
        assert validate_against_schema(manifest.manifest_json, "run_manifest.schema.json") == []
        assert manifest.manifest_json["evidence"][0]["evidence_id"] == "DEMO-EVIDENCE-001"
        # No secrets anywhere in the manifest.
        blob = json.dumps(manifest.manifest_json).lower()
        for forbidden in ("api_key", "secret_ciphertext", "authorization"):
            assert forbidden not in blob

        # Fallback summary cites nothing scripted, but scripted scenario runs cite
        # demo evidence; either way citation rows are consistent with the summary.
        citations = list(
            (await db.execute(select(RunCitation).where(RunCitation.run_id == run_id))).scalars()
        )
        cited_keys = {c["evidence_id"] for c in summary.summary_json.get("evidence", [])}
        assert {c.citation_key for c in citations} <= cited_keys | set()
        for c in citations:
            assert c.validation_status in {"validated", "unmatched_attachment", "unknown_evidence"}


async def test_terminal_runs_get_valid_manifests(sessionmaker):
    """cancelled / budget_stopped / failed runs must still produce a
    schema-valid manifest via the robust ensure path."""
    from app.provenance import ensure_manifest_safe

    for status in ("cancelled", "budget_stopped", "failed"):
        async with sessionmaker() as db:
            await seed(db)
            run = await _make_run_with_evidence(db, [])
            run.status = status
            run.completed_at = datetime.now(timezone.utc)
            run.lease_owner = None
            run.lease_expires_at = None
            await db.commit()
            manifest, err = await ensure_manifest_safe(db, run)
            assert err is None, f"{status}: {err}"
            assert manifest is not None
            assert manifest.manifest_json["run"]["status"] == status
            assert validate_against_schema(
                manifest.manifest_json, "run_manifest.schema.json"
            ) == []
            # A schema-valid terminal structured summary must exist too, and
            # the manifest must hash it.
            from app.models import RunSummary

            summary = await db.get(RunSummary, run.id)
            assert summary is not None, f"{status}: no terminal summary"
            assert summary.validation_status == "valid"
            assert validate_against_schema(
                summary.summary_json, "meeting_summary.schema.json"
            ) == []
            assert manifest.summary_sha256 == summary.summary_sha256
            # idempotent second call returns the same row
            again, err2 = await ensure_manifest_safe(db, run)
            assert err2 is None and again.run_id == manifest.run_id


async def test_manifest_generates_before_transcript_exists(sessionmaker):
    """A run that failed before producing any turns still yields a valid,
    schema-conformant manifest (transcript hash over an empty transcript)."""
    from app.provenance import build_manifest

    async with sessionmaker() as db:
        await seed(db)
        run = await _make_run_with_evidence(db, [])
        run.status = "failed"
        run.failure_code = "provider_error"
        run.completed_at = datetime.now(timezone.utc)
        await db.commit()
        manifest = await build_manifest(db, run)
        assert validate_against_schema(manifest, "run_manifest.schema.json") == []
        assert manifest["run"]["status"] == "failed"
        # No completed turns -> summary hash falls back to the empty-string sha.
        assert manifest["integrity"]["summary_sha256"]


async def test_queued_cancel_produces_manifest_immediately(sessionmaker):
    """Cancelling a queued run (worker never runs) is a terminal transition and
    must yield a schema-valid manifest right away, mirroring the API endpoint."""
    from fastapi import Request
    from app.api.v1 import cancel_run
    from app.models import RunManifest, User, WorkspaceMembership

    async with sessionmaker() as db:
        await seed(db)
        run = await _make_run_with_evidence(db, [])
        # Reset to queued (the helper leases it) and clear the lease.
        run.status = "queued"
        run.lease_owner = None
        run.lease_expires_at = None
        await db.commit()
        run_id = run.id
        ws_id = run.workspace_id

        # A researcher user with membership to satisfy require_workspace_role.
        user = (await db.execute(select(User).limit(1))).scalars().first()
        if user is None:
            user = User(email="canceltest@example.com", display_name="cancel")
            db.add(user)
            await db.flush()
        member = (
            await db.execute(
                select(WorkspaceMembership).where(
                    WorkspaceMembership.workspace_id == ws_id,
                    WorkspaceMembership.user_id == user.id,
                )
            )
        ).scalar_one_or_none()
        if member is None:
            db.add(WorkspaceMembership(workspace_id=ws_id, user_id=user.id, role="researcher"))
        await db.commit()

    async with sessionmaker() as db:
        out = await cancel_run(run_id, user=user, db=db)
        assert out.status == "cancelled"
        assert out.completed_at is not None

    async with sessionmaker() as db:
        manifest = await db.get(RunManifest, run_id)
        assert manifest is not None, "queued-cancel must create a manifest immediately"
        assert manifest.manifest_json["run"]["status"] == "cancelled"
        assert validate_against_schema(
            manifest.manifest_json, "run_manifest.schema.json"
        ) == []


async def test_failed_run_export_contains_summary_and_manifest(sessionmaker):
    """An export packet for a failed run carries a schema-valid manifest AND a
    schema-valid terminal summary — never summary.json: null."""
    import io
    import zipfile

    from app.exports import build_export_packet
    from app.provenance import ensure_manifest_safe

    async with sessionmaker() as db:
        await seed(db)
        run = await _make_run_with_evidence(db, [])
        run.status = "failed"
        run.failure_code = "provider_error"
        run.failure_safe_message = "The provider rejected the request."
        run.completed_at = datetime.now(timezone.utc)
        await db.commit()
        manifest, err = await ensure_manifest_safe(db, run)
        assert err is None
        payload = await build_export_packet(db, run)

    zf = zipfile.ZipFile(io.BytesIO(payload))
    manifest_json = json.loads(zf.read("manifest.json"))
    summary_json = json.loads(zf.read("summary.json"))
    assert manifest_json is not None and summary_json is not None
    assert manifest_json["run"]["status"] == "failed"
    assert validate_against_schema(manifest_json, "run_manifest.schema.json") == []
    assert validate_against_schema(summary_json, "meeting_summary.schema.json") == []
    assert "provider_error" in summary_json["executive_summary"]


async def test_citation_validation_flags_unknown_evidence(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_run_with_evidence(db, [])
        definition = await db.get(MeetingDefinition, run.meeting_definition_id)
        summary_json = {"evidence": [
            {"evidence_id": "S-9999", "claim": "Bogus claim", "support_type": "supports"},
        ]}
        stats = await create_citations_from_summary(db, run, definition, summary_json)
        await db.commit()
        assert stats["unmatched"] == 1 and stats["validated"] == 0
        rows = list(
            (await db.execute(select(RunCitation).where(RunCitation.run_id == run.id))).scalars()
        )
        # unknown key has no evidence source to link, so no row is created
        assert rows == []
        run.status = "cancelled"
        run.completed_at = datetime.now(timezone.utc)
        await db.commit()


# ---------------------------------------------------------------------------
# export packet
# ---------------------------------------------------------------------------

async def test_export_packet_contents_and_hashes(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_run_with_evidence(db, [])
        run_id = run.id

    await execute_run(sessionmaker, run_id, "test-worker")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        await ensure_manifest(db, run)
        await db.commit()
        payload = await build_export_packet(db, run)

    zf = zipfile.ZipFile(io.BytesIO(payload))
    names = set(zf.namelist())
    for expected in (
        "README.md", "manifest.json", "meeting_definition.json", "transcript.json",
        "transcript.md", "summary.json", "summary.md", "evidence.json",
        "citations.json", "agents.json", "usage.json", "interventions.json",
        "reviews.json", "hashes.json",
    ):
        assert expected in names, f"missing {expected}"
    hashes = json.loads(zf.read("hashes.json"))
    for name, expected_sha in hashes.items():
        assert sha256_text(zf.read(name).decode()) == expected_sha, f"hash mismatch for {name}"
    manifest = json.loads(zf.read("manifest.json"))
    assert manifest["manifest_version"] == "1.0"
    blob = payload.decode("latin-1").lower()
    assert "secret_ciphertext" not in blob
    assert "storage_object_key" not in blob


# ---------------------------------------------------------------------------
# blinded comparison basics (label assignment covered at API level too)
# ---------------------------------------------------------------------------

async def test_comparison_blind_labels_unique(sessionmaker):
    from app.models import ComparisonItem, ComparisonSet

    async with sessionmaker() as db:
        await seed(db)
        runs = []
        for _ in range(2):
            run = await _make_run_with_evidence(db, [])
            runs.append(run.id)

    for rid in runs:
        await execute_run(sessionmaker, rid, "test-worker")

    async with sessionmaker() as db:
        run0 = await db.get(Run, runs[0])
        cset = ComparisonSet(
            workspace_id=run0.workspace_id, project_id=run0.project_id,
            name="Test comparison", visibility="blinded",
            rubric={"version": "1.0", "scale": {"min": 1, "max": 5}, "criteria": ["Clarity"]},
        )
        db.add(cset)
        await db.flush()
        for label, rid in zip(["A", "B"], runs):
            db.add(ComparisonItem(comparison_set_id=cset.id, run_id=rid, blind_label=label))
        await db.commit()
        items = list(
            (await db.execute(
                select(ComparisonItem).where(ComparisonItem.comparison_set_id == cset.id)
            )).scalars()
        )
        labels = [i.blind_label for i in items]
        assert sorted(labels) == ["A", "B"]


async def test_blinded_comparison_hides_run_identity_until_submission(sessionmaker):
    """Before a reviewer submits their evaluation, the comparison response must
    not expose run ids, titles, or the stored (title-prefixed) markdown."""
    from app.api.library import _comparison_out
    from app.models import (
        ComparisonEvaluation,
        ComparisonItem,
        ComparisonSet,
        MeetingDefinition,
        User,
        WorkspaceMembership,
    )

    async with sessionmaker() as db:
        await seed(db)
        runs = []
        for _ in range(2):
            run = await _make_run_with_evidence(db, [])
            runs.append(run.id)

    for rid in runs:
        await execute_run(sessionmaker, rid, "test-worker")

    async with sessionmaker() as db:
        run0 = await db.get(Run, runs[0])
        definition = await db.get(MeetingDefinition, run0.meeting_definition_id)
        def_title = definition.title
        assert def_title  # sanity: there is an identifying title to leak

        cset = ComparisonSet(
            workspace_id=run0.workspace_id, project_id=run0.project_id,
            name="Blinding test", visibility="blinded",
            rubric={"version": "1.0", "scale": {"min": 1, "max": 5}, "criteria": ["Clarity"]},
        )
        db.add(cset)
        await db.flush()
        for label, rid in zip(["A", "B"], runs):
            db.add(ComparisonItem(comparison_set_id=cset.id, run_id=rid, blind_label=label))

        reviewer = (
            await db.execute(select(User).where(User.email == "blindtest@example.com"))
        ).scalars().first()
        if reviewer is None:
            reviewer = User(
                email="blindtest@example.com", display_name="Blind Reviewer",
                auth_provider="dev", auth_subject="blindtest@example.com",
            )
            db.add(reviewer)
            await db.flush()
        membership = (
            await db.execute(
                select(WorkspaceMembership).where(
                    WorkspaceMembership.workspace_id == run0.workspace_id,
                    WorkspaceMembership.user_id == reviewer.id,
                )
            )
        ).scalars().first()
        if membership is None:
            db.add(WorkspaceMembership(
                workspace_id=run0.workspace_id, user_id=reviewer.id, role="researcher",
            ))
        await db.commit()

        # Before submitting: fully blinded.
        out = await _comparison_out(db, cset, reviewer)
        assert out.revealed is False
        for item in out.items:
            assert item.run_id is None
            assert item.run_title is None
            assert item.summary_markdown is not None
            assert def_title not in item.summary_markdown, "definition title leaked while blinded"
            serialized = item.model_dump_json()
            for rid in runs:
                assert str(rid) not in serialized, "run id leaked while blinded"

        # After the reviewer submits: identities revealed to them.
        db.add(ComparisonEvaluation(
            comparison_set_id=cset.id, workspace_id=cset.workspace_id,
            evaluator_id=reviewer.id,
            item_scores={"A": {"Clarity": 4}, "B": {"Clarity": 3}},
        ))
        await db.commit()
        out2 = await _comparison_out(db, cset, reviewer)
        assert out2.revealed is True
        assert {str(i.run_id) for i in out2.items} == {str(r) for r in runs}
