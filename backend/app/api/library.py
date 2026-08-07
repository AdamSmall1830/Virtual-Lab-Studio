"""Evidence library, provenance, reviews, comparisons, and export endpoints."""
from __future__ import annotations

import hashlib
import os
import random
import tempfile
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..evidence import (
    ExtractionError,
    MAX_UPLOAD_BYTES,
    allocate_evidence_key,
    extract_segments,
    get_source_chunks,
    persist_chunks,
    resolve_content_type,
    sha256_bytes,
    sha256_text,
    ExtractedSegment,
)
from ..exports import build_export_packet
from ..pdf_report import build_pdf_report
from ..models import (
    ComparisonEvaluation,
    ComparisonItem,
    ComparisonSet,
    EvidenceChunk,
    EvidenceSource,
    ExportJob,
    Project,
    Run,
    RunCitation,
    RunManifest,
    RunReview,
    RunSummary,
    User,
)
from ..pmc import PmcError, fetch_pmc_abstract, search_pmc
from ..provenance import ensure_manifest_safe, validate_against_schema
from ..schemas import (
    ComparisonCreateIn,
    ComparisonEvaluationIn,
    ComparisonEvaluationOut,
    ComparisonItemOut,
    ComparisonSetOut,
    EvidenceChunkOut,
    EvidenceNoteIn,
    EvidenceSearchHit,
    EvidenceSearchIn,
    EvidenceSourceOut,
    ExportCreateIn,
    ExportJobOut,
    PmcImportIn,
    PmcSearchIn,
    RunCitationOut,
    RunManifestOut,
    RunReviewIn,
    RunReviewOut,
)
from ..security import get_current_user, require_workspace_role
from ..storage import StorageError, get_object_to_file, put_object
from .v1 import _get_project, _get_run, audit, problem

router = APIRouter()

TERMINAL_STATUSES = {"completed", "failed", "cancelled", "budget_stopped"}
BLIND_LABELS = ["A", "B", "C", "D"]


# --------------------------------------------------------------------------
# evidence library
# --------------------------------------------------------------------------

async def _get_source(
    db: AsyncSession, source_id: uuid.UUID, user: User, minimum_role: str
) -> EvidenceSource:
    source = await db.get(EvidenceSource, source_id)
    if source is None or source.archived_at is not None:
        raise problem(404, "not_found", "Evidence source not found")
    await require_workspace_role(db, source.workspace_id, user, minimum_role)
    return source


@router.get("/projects/{project_id}/evidence", response_model=list[EvidenceSourceOut])
async def list_evidence(
    project_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    project = await _get_project(db, project_id, user, "viewer")
    rows = (
        await db.execute(
            select(EvidenceSource)
            .where(
                EvidenceSource.workspace_id == project.workspace_id,
                EvidenceSource.archived_at.is_(None),
                (EvidenceSource.project_id == project.id) | (EvidenceSource.project_id.is_(None)),
            )
            .order_by(EvidenceSource.created_at.desc())
            .limit(200)
        )
    ).scalars()
    return [EvidenceSourceOut.model_validate(r) for r in rows]


@router.post("/projects/{project_id}/evidence/upload", response_model=EvidenceSourceOut, status_code=201)
async def upload_evidence(
    project_id: uuid.UUID,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    citation: str | None = Form(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _get_project(db, project_id, user, "researcher")
    data = await file.read()
    if not data:
        raise problem(422, "empty_file", "The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise problem(413, "file_too_large", "Uploads are limited to 25 MB.")
    filename = file.filename or "upload"
    try:
        content_type = resolve_content_type(filename, file.content_type)
    except ExtractionError as exc:
        raise problem(422, exc.code, exc.safe_message)

    content_sha = sha256_bytes(data)
    evidence_key = await allocate_evidence_key(db, project.workspace_id)
    source_type = {"application/pdf": "upload_pdf", "text/markdown": "upload_markdown",
                   "text/plain": "upload_text"}[content_type]
    storage_key = f"evidence/{project.workspace_id}/{evidence_key}-{content_sha[:12]}"
    try:
        await put_object(storage_key, data)
    except StorageError:
        raise problem(503, "storage_unavailable", "Evidence storage is unavailable right now.")

    source = EvidenceSource(
        workspace_id=project.workspace_id,
        project_id=project.id,
        evidence_key=evidence_key,
        source_type=source_type,
        title=(title or filename)[:300],
        citation=citation,
        content_type=content_type,
        byte_size=len(data),
        storage_object_key=storage_key,
        original_filename=filename[:300],
        content_sha256=content_sha,
        processing_status="processing",
        created_by=user.id,
    )
    db.add(source)
    await db.flush()
    try:
        segments = extract_segments(data, content_type)
        await persist_chunks(db, source, segments)
        source.processing_status = "ready"
    except ExtractionError as exc:
        source.processing_status = "failed"
        source.processing_error_code = exc.code
        source.processing_error_safe_message = exc.safe_message
    await audit(db, project.workspace_id, user, "evidence.uploaded", "evidence_source", str(source.id))
    await db.commit()
    await db.refresh(source)
    return EvidenceSourceOut.model_validate(source)


@router.post("/projects/{project_id}/evidence/notes", response_model=EvidenceSourceOut, status_code=201)
async def create_evidence_note(
    project_id: uuid.UUID, body: EvidenceNoteIn,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    project = await _get_project(db, project_id, user, "researcher")
    evidence_key = await allocate_evidence_key(db, project.workspace_id)
    source = EvidenceSource(
        workspace_id=project.workspace_id,
        project_id=project.id,
        evidence_key=evidence_key,
        source_type="note",
        title=body.title,
        citation=body.citation,
        source_url=body.source_url,
        content_type="text/markdown",
        byte_size=len(body.content.encode()),
        content_sha256=sha256_text(body.content),
        processing_status="ready",
        created_by=user.id,
        metadata_json={"content": body.content},
    )
    db.add(source)
    await db.flush()
    segments = extract_segments(body.content.encode(), "text/markdown")
    await persist_chunks(db, source, segments)
    await audit(db, project.workspace_id, user, "evidence.note_created", "evidence_source", str(source.id))
    await db.commit()
    await db.refresh(source)
    return EvidenceSourceOut.model_validate(source)


@router.get("/evidence/{source_id}", response_model=EvidenceSourceOut)
async def get_evidence(
    source_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    source = await _get_source(db, source_id, user, "viewer")
    return EvidenceSourceOut.model_validate(source)


@router.get("/evidence/{source_id}/chunks", response_model=list[EvidenceChunkOut])
async def list_evidence_chunks(
    source_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    source = await _get_source(db, source_id, user, "viewer")
    return [EvidenceChunkOut.model_validate(c) for c in await get_source_chunks(db, source.id)]


@router.post("/evidence/{source_id}/archive", response_model=EvidenceSourceOut)
async def archive_evidence(
    source_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    source = await _get_source(db, source_id, user, "researcher")
    source.archived_at = datetime.now(timezone.utc)
    await audit(db, source.workspace_id, user, "evidence.archived", "evidence_source", str(source.id))
    await db.commit()
    return EvidenceSourceOut.model_validate(source)


@router.post("/workspaces/{workspace_id}/evidence/search", response_model=list[EvidenceSearchHit])
async def search_workspace_evidence(
    workspace_id: uuid.UUID, body: EvidenceSearchIn,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    await require_workspace_role(db, workspace_id, user, "viewer")
    rows = (
        await db.execute(
            text(
                """
                SELECT c.id AS chunk_id, c.chunk_index, c.locator,
                       ts_headline('english', c.content_text, q, 'MaxFragments=1, MaxWords=40') AS snippet,
                       s.id AS source_id, s.evidence_key, s.title
                FROM evidence_chunks c
                JOIN evidence_sources s ON s.id = c.evidence_source_id
                CROSS JOIN plainto_tsquery('english', :query) q
                WHERE c.workspace_id = :ws
                  AND s.archived_at IS NULL
                  AND to_tsvector('english', c.content_text) @@ q
                ORDER BY ts_rank(to_tsvector('english', c.content_text), q) DESC
                LIMIT :limit
                """
            ),
            {"ws": str(workspace_id), "query": body.query, "limit": body.limit},
        )
    ).mappings().all()
    return [
        EvidenceSearchHit(
            evidence_source_id=row["source_id"],
            evidence_key=row["evidence_key"],
            title=row["title"],
            chunk_id=row["chunk_id"],
            chunk_index=row["chunk_index"],
            locator=row["locator"],
            snippet=row["snippet"] or "",
        )
        for row in rows
    ]


@router.post("/workspaces/{workspace_id}/pmc/search")
async def pmc_search(
    workspace_id: uuid.UUID, body: PmcSearchIn,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    await require_workspace_role(db, workspace_id, user, "viewer")
    try:
        return await search_pmc(body.query, body.limit)
    except PmcError as exc:
        raise problem(502, "pmc_unavailable", exc.safe_message)


@router.post("/projects/{project_id}/evidence/pmc-import", response_model=EvidenceSourceOut, status_code=201)
async def pmc_import(
    project_id: uuid.UUID, body: PmcImportIn,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    project = await _get_project(db, project_id, user, "researcher")
    try:
        article = await fetch_pmc_abstract(body.pmcid)
    except PmcError as exc:
        raise problem(502, "pmc_unavailable", exc.safe_message)

    existing = (
        await db.execute(
            select(EvidenceSource).where(
                EvidenceSource.workspace_id == project.workspace_id,
                EvidenceSource.external_identifier == article["pmcid"],
                EvidenceSource.archived_at.is_(None),
            )
        )
    ).scalars().first()
    if existing is not None:
        return EvidenceSourceOut.model_validate(existing)

    content = f"# {article['title']}\n\n{article['abstract'] or '(no abstract available)'}"
    evidence_key = await allocate_evidence_key(db, project.workspace_id)
    source = EvidenceSource(
        workspace_id=project.workspace_id,
        project_id=project.id,
        evidence_key=evidence_key,
        source_type="pmc_article",
        title=article["title"][:300],
        citation=", ".join(article["authors"][:3]) + (f". {article['journal']}" if article["journal"] else ""),
        source_url=article["url"],
        external_identifier=article["pmcid"],
        author_text="; ".join(article["authors"]) or None,
        content_type="text/markdown",
        byte_size=len(content.encode()),
        content_sha256=sha256_text(content),
        processing_status="ready",
        created_by=user.id,
        metadata_json={"content": content, "retrieved_at": datetime.now(timezone.utc).isoformat()},
    )
    db.add(source)
    await db.flush()
    await persist_chunks(db, source, extract_segments(content.encode(), "text/markdown"))
    await audit(db, project.workspace_id, user, "evidence.pmc_imported", "evidence_source", str(source.id))
    await db.commit()
    await db.refresh(source)
    return EvidenceSourceOut.model_validate(source)


# --------------------------------------------------------------------------
# run provenance: citations, manifest, reviews
# --------------------------------------------------------------------------

@router.get("/runs/{run_id}/citations", response_model=list[RunCitationOut])
async def list_run_citations(
    run_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    run = await _get_run(db, run_id, user, "viewer")
    rows = (
        await db.execute(
            select(RunCitation).where(RunCitation.run_id == run.id).order_by(RunCitation.created_at)
        )
    ).scalars()
    return [RunCitationOut.model_validate(r) for r in rows]


@router.get("/runs/{run_id}/manifest", response_model=RunManifestOut)
async def get_run_manifest(
    run_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    run = await _get_run(db, run_id, user, "viewer")
    manifest = await db.get(RunManifest, run.id)
    if manifest is None:
        if run.status not in TERMINAL_STATUSES:
            raise problem(409, "run_not_finished", "The manifest is created when the run finishes.")
        # Backfill for terminal runs that predate manifest generation. Robust
        # against schema and data errors on historical rows.
        manifest, err = await ensure_manifest_safe(db, run)
        if manifest is None:
            if err is None:
                # Skipped: a retry requeued the run, so it is no longer terminal
                # and has no manifest until it finishes again.
                raise problem(409, "run_not_finished", "The manifest is created when the run finishes.")
            raise problem(500, "manifest_invalid", "The run manifest could not be generated.")
    return RunManifestOut.model_validate(manifest)


@router.get("/runs/{run_id}/reviews", response_model=list[RunReviewOut])
async def list_run_reviews(
    run_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    run = await _get_run(db, run_id, user, "viewer")
    rows = (
        await db.execute(
            select(RunReview).where(RunReview.run_id == run.id).order_by(RunReview.created_at)
        )
    ).scalars()
    return [RunReviewOut.model_validate(r) for r in rows]


@router.put("/runs/{run_id}/reviews/mine", response_model=RunReviewOut)
async def upsert_my_review(
    run_id: uuid.UUID, body: RunReviewIn,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    run = await _get_run(db, run_id, user, "reviewer")
    if run.status not in TERMINAL_STATUSES:
        raise problem(409, "run_not_finished", "Reviews can be recorded once the run finishes.")
    for label, score in (body.ratings or {}).items():
        if not (1 <= int(score) <= 5):
            raise problem(422, "invalid_rating", f"Rating '{label}' must be between 1 and 5.")
    existing = (
        await db.execute(
            select(RunReview).where(RunReview.run_id == run.id, RunReview.reviewer_id == user.id)
        )
    ).scalar_one_or_none()
    if existing is None:
        existing = RunReview(
            workspace_id=run.workspace_id, run_id=run.id, reviewer_id=user.id,
            status=body.status, rubric_version=body.rubric_version,
            ratings=body.ratings, comments_markdown=body.comments_markdown,
        )
        db.add(existing)
    else:
        existing.status = body.status
        existing.rubric_version = body.rubric_version
        existing.ratings = body.ratings
        existing.comments_markdown = body.comments_markdown
    run.review_status = body.status
    await audit(db, run.workspace_id, user, "run.reviewed", "run", str(run.id))
    await db.commit()
    await db.refresh(existing)
    return RunReviewOut.model_validate(existing)


# --------------------------------------------------------------------------
# reproducibility exports
# --------------------------------------------------------------------------

EXPORT_MEDIA = {
    "repro_zip": ("application/zip", "zip", "packet"),
    "report_pdf": ("application/pdf", "pdf", "report"),
}


@router.post("/runs/{run_id}/exports", response_model=ExportJobOut, status_code=201)
async def create_export(
    run_id: uuid.UUID,
    body: ExportCreateIn = Body(default_factory=ExportCreateIn),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    run = await _get_run(db, run_id, user, "viewer")
    if run.status not in TERMINAL_STATUSES:
        raise problem(409, "run_not_finished", "Exports are available once the run finishes.")

    manifest_row = await db.get(RunManifest, run.id)
    if manifest_row is None:
        manifest_row, _err = await ensure_manifest_safe(db, run)
        if manifest_row is None and _err is None:
            # Skipped: a retry requeued the run between the check above and
            # here, so there is nothing final to package yet.
            raise problem(
                409, "run_not_finished", "Exports are available once the run finishes."
            )

    if body.format == "repro_zip":
        # A reproducibility packet must carry a valid manifest — never a null or
        # invalid one. The PDF report has no such requirement: it is a readable
        # document, and it states plainly when the manifest is missing or
        # unverifiable instead of refusing to exist.
        if manifest_row is None:
            raise problem(
                422, "manifest_unavailable",
                "A valid provenance manifest could not be generated, so the "
                "reproducibility packet cannot be produced for this run.",
            )
        if validate_against_schema(manifest_row.manifest_json, "run_manifest.schema.json"):
            raise problem(
                422, "manifest_invalid",
                "The stored provenance manifest fails schema validation, so the "
                "reproducibility packet cannot be produced for this run.",
            )

    sections = list(dict.fromkeys(body.sections)) if body.format == "report_pdf" else []
    _media, extension, _noun = EXPORT_MEDIA[body.format]
    job = ExportJob(
        workspace_id=run.workspace_id, project_id=run.project_id, run_id=run.id,
        requested_by=user.id, format=body.format, status="running",
        options={"sections": sections} if body.format == "report_pdf" else {},
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    await db.flush()
    try:
        if body.format == "report_pdf":
            payload = await build_pdf_report(db, run, sections)
        else:
            payload = await build_export_packet(db, run)
        storage_key = f"exports/{run.workspace_id}/{run.id}/{job.id}.{extension}"
        await put_object(storage_key, payload)
        job.status = "completed"
        job.storage_object_key = storage_key
        job.byte_size = len(payload)
        job.sha256 = sha256_bytes(payload)
        job.completed_at = datetime.now(timezone.utc)
    except StorageError:
        job.status = "failed"
        job.error_code = "storage_unavailable"
        job.error_safe_message = "Export storage is unavailable right now."
    await audit(db, run.workspace_id, user, "run.exported", "export_job", str(job.id))
    await db.commit()
    await db.refresh(job)
    return ExportJobOut.model_validate(job)


@router.get("/runs/{run_id}/exports", response_model=list[ExportJobOut])
async def list_exports(
    run_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    run = await _get_run(db, run_id, user, "viewer")
    rows = (
        await db.execute(
            select(ExportJob).where(ExportJob.run_id == run.id).order_by(ExportJob.created_at.desc())
        )
    ).scalars()
    return [ExportJobOut.model_validate(r) for r in rows]


@router.get("/exports/{job_id}/download")
async def download_export(
    job_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    job = await db.get(ExportJob, job_id)
    if job is None:
        raise problem(404, "not_found", "Export not found")
    await require_workspace_role(db, job.workspace_id, user, "viewer")
    if job.status != "completed" or not job.storage_object_key:
        raise problem(409, "export_not_ready", "The export is not ready.")
    media_type, extension, noun = EXPORT_MEDIA.get(job.format, EXPORT_MEDIA["repro_zip"])
    # File-backed staging: the export is downloaded straight to disk and
    # streamed from there, so response size is never bounded by memory.
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=f".{extension}")
    tmp.close()
    try:
        await get_object_to_file(job.storage_object_key, tmp.name)
        if job.sha256:
            digest = hashlib.sha256()
            with open(tmp.name, "rb") as fh:
                for block in iter(lambda: fh.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != job.sha256:
                raise problem(
                    500, "export_corrupt",
                    "The stored export failed its integrity check.",
                )
    except StorageError:
        os.unlink(tmp.name)
        raise problem(503, "storage_unavailable", "Export storage is unavailable right now.")
    except Exception:
        os.unlink(tmp.name)
        raise
    filename = f"virtual-lab-run-{job.run_id}-{noun}.{extension}"
    return FileResponse(
        tmp.name,
        media_type=media_type,
        filename=filename,
        background=BackgroundTask(os.unlink, tmp.name),
    )


# --------------------------------------------------------------------------
# blinded run comparison
# --------------------------------------------------------------------------

async def _comparison_out(
    db: AsyncSession, cset: ComparisonSet, user: User
) -> ComparisonSetOut:
    items = list(
        (
            await db.execute(
                select(ComparisonItem)
                .where(ComparisonItem.comparison_set_id == cset.id)
                .order_by(ComparisonItem.display_order)
            )
        ).scalars()
    )
    eval_count = (
        await db.execute(
            select(func.count()).select_from(ComparisonEvaluation).where(
                ComparisonEvaluation.comparison_set_id == cset.id
            )
        )
    ).scalar_one()
    mine = (
        await db.execute(
            select(ComparisonEvaluation).where(
                ComparisonEvaluation.comparison_set_id == cset.id,
                ComparisonEvaluation.evaluator_id == user.id,
            )
        )
    ).scalar_one_or_none()
    # Identity stays hidden while blinded until the caller has submitted an
    # evaluation; identified sets are always revealed.
    revealed = cset.visibility == "identified" or mine is not None
    out_items: list[ComparisonItemOut] = []
    for item in items:
        summary = await db.get(RunSummary, item.run_id)
        run = await db.get(Run, item.run_id)
        definition_title = None
        if revealed and run is not None:
            definition_title = (
                await db.execute(
                    text("SELECT title FROM meeting_definitions WHERE id = :id"),
                    {"id": str(run.meeting_definition_id)},
                )
            ).scalar_one_or_none()
        # While blinded, never expose the stored markdown: the completed-run
        # generator prefixes it with the meeting definition title, which would
        # identify the run. Render a blind-safe markdown from the structured
        # summary instead.
        if revealed:
            summary_md = summary.summary_markdown if summary else None
        elif summary is not None:
            sj = summary.summary_json or {}
            summary_md = (
                f"# Candidate {item.blind_label or '?'}\n\n"
                f"## Executive summary\n\n{sj.get('executive_summary', '')}\n"
            )
        else:
            summary_md = None
        out_items.append(ComparisonItemOut(
            blind_label=item.blind_label or "?",
            display_order=item.display_order,
            run_id=item.run_id if revealed else None,
            run_title=definition_title if revealed else None,
            summary_json=summary.summary_json if summary else None,
            summary_markdown=summary_md,
            demo_mode=bool(run.demo_mode) if run is not None else False,
            validation_status=summary.validation_status if summary else None,
        ))
    return ComparisonSetOut(
        id=cset.id, project_id=cset.project_id, name=cset.name,
        description=cset.description, visibility=cset.visibility,
        rubric=cset.rubric, created_at=cset.created_at, items=out_items,
        evaluation_count=int(eval_count), my_evaluation_submitted=mine is not None,
        revealed=revealed,
    )


@router.get("/projects/{project_id}/comparisons", response_model=list[ComparisonSetOut])
async def list_comparisons(
    project_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    project = await _get_project(db, project_id, user, "viewer")
    sets = list(
        (
            await db.execute(
                select(ComparisonSet)
                .where(ComparisonSet.project_id == project.id)
                .order_by(ComparisonSet.created_at.desc())
                .limit(50)
            )
        ).scalars()
    )
    return [await _comparison_out(db, s, user) for s in sets]


@router.post("/projects/{project_id}/comparisons", response_model=ComparisonSetOut, status_code=201)
async def create_comparison(
    project_id: uuid.UUID, body: ComparisonCreateIn,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    project = await _get_project(db, project_id, user, "researcher")
    if len(set(body.run_ids)) != len(body.run_ids):
        raise problem(422, "duplicate_runs", "Each run may appear only once in a comparison.")
    runs: list[Run] = []
    for rid in body.run_ids:
        run = await db.get(Run, rid)
        if run is None or run.project_id != project.id:
            raise problem(422, "invalid_run", "All compared runs must belong to this project.")
        if run.status != "completed":
            raise problem(422, "run_not_completed", "Only completed runs can be compared.")
        if await db.get(RunSummary, run.id) is None:
            raise problem(422, "missing_summary", "Every compared run needs a structured summary.")
        runs.append(run)

    rubric = {
        "version": "1.0",
        "scale": {"min": 1, "max": 5},
        "criteria": body.rubric_criteria,
    }
    cset = ComparisonSet(
        workspace_id=project.workspace_id, project_id=project.id,
        name=body.name, description=body.description,
        visibility="blinded", rubric=rubric, created_by=user.id,
    )
    db.add(cset)
    await db.flush()
    # Server-side random assignment of blind labels; identity mapping stays
    # in the database and is only revealed after evaluation.
    labels = BLIND_LABELS[: len(runs)]
    shuffled = list(runs)
    random.SystemRandom().shuffle(shuffled)
    for order, (label, run) in enumerate(zip(labels, shuffled)):
        db.add(ComparisonItem(
            comparison_set_id=cset.id, run_id=run.id,
            blind_label=label, display_order=order,
        ))
    await audit(db, project.workspace_id, user, "comparison.created", "comparison_set", str(cset.id))
    await db.commit()
    return await _comparison_out(db, cset, user)


async def _get_comparison(
    db: AsyncSession, comparison_id: uuid.UUID, user: User, minimum_role: str
) -> ComparisonSet:
    cset = await db.get(ComparisonSet, comparison_id)
    if cset is None:
        raise problem(404, "not_found", "Comparison not found")
    await require_workspace_role(db, cset.workspace_id, user, minimum_role)
    return cset


@router.get("/comparisons/{comparison_id}", response_model=ComparisonSetOut)
async def get_comparison(
    comparison_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    cset = await _get_comparison(db, comparison_id, user, "viewer")
    return await _comparison_out(db, cset, user)


@router.post("/comparisons/{comparison_id}/evaluations", response_model=ComparisonEvaluationOut, status_code=201)
async def submit_evaluation(
    comparison_id: uuid.UUID, body: ComparisonEvaluationIn,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    cset = await _get_comparison(db, comparison_id, user, "reviewer")
    existing = (
        await db.execute(
            select(ComparisonEvaluation).where(
                ComparisonEvaluation.comparison_set_id == cset.id,
                ComparisonEvaluation.evaluator_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise problem(409, "already_evaluated", "You already submitted an evaluation for this comparison.")

    labels = {
        item.blind_label
        for item in (
            await db.execute(
                select(ComparisonItem).where(ComparisonItem.comparison_set_id == cset.id)
            )
        ).scalars()
    }
    criteria = set((cset.rubric or {}).get("criteria", []))
    for label, scores in body.item_scores.items():
        if label not in labels:
            raise problem(422, "invalid_label", f"Unknown item label '{label}'.")
        for criterion, score in scores.items():
            if criterion not in criteria:
                raise problem(422, "invalid_criterion", f"Unknown rubric criterion '{criterion}'.")
            if not (1 <= int(score) <= 5):
                raise problem(422, "invalid_score", "Scores must be between 1 and 5.")
    missing = labels - set(body.item_scores.keys())
    if missing:
        raise problem(422, "incomplete_scores", f"Missing scores for: {', '.join(sorted(missing))}.")
    if body.ranking and set(body.ranking) != labels:
        raise problem(422, "invalid_ranking", "Ranking must list every blind label exactly once.")

    evaluation = ComparisonEvaluation(
        workspace_id=cset.workspace_id, comparison_set_id=cset.id,
        evaluator_id=user.id, item_scores=body.item_scores,
        ranking=body.ranking, comments_markdown=body.comments_markdown,
    )
    db.add(evaluation)
    await audit(db, cset.workspace_id, user, "comparison.evaluated", "comparison_set", str(cset.id))
    await db.commit()
    await db.refresh(evaluation)
    return ComparisonEvaluationOut.model_validate(evaluation)


@router.get("/comparisons/{comparison_id}/evaluations", response_model=list[ComparisonEvaluationOut])
async def list_evaluations(
    comparison_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    cset = await _get_comparison(db, comparison_id, user, "viewer")
    mine = (
        await db.execute(
            select(ComparisonEvaluation).where(
                ComparisonEvaluation.comparison_set_id == cset.id,
                ComparisonEvaluation.evaluator_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if cset.visibility == "blinded" and mine is None:
        # Do not leak other evaluators' scores before this reviewer submits.
        return []
    rows = (
        await db.execute(
            select(ComparisonEvaluation)
            .where(ComparisonEvaluation.comparison_set_id == cset.id)
            .order_by(ComparisonEvaluation.submitted_at)
        )
    ).scalars()
    return [ComparisonEvaluationOut.model_validate(r) for r in rows]
