"""Recursive Agent routes: workspace administration and the worker protocol.

Two audiences share this module and must never share a credential:

* **Users** authenticate with the ordinary session cookie and go through the
  same workspace ACL and not-found masking as every other route.
* **Workers** authenticate only with ``Authorization: Bearer rwk_...``.

The separation is structural rather than conventional. ``get_current_user``
reads a cookie and nothing else; the worker dependency reads a bearer header
and nothing else. Neither can accept the other's credential, so a stolen
worker token cannot reach a user route and a session cannot drive a worker one.

Every route here 404s when the feature is disabled, so a deployment that never
turned it on reveals nothing about its existence.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from collections.abc import Awaitable, Callable

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.routing import APIRoute
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..db import get_db
from ..events import append_event
from ..models import (
    AuditEvent,
    MeetingDefinition,
    RecursiveAgentJob,
    RecursiveAgentNode,
    RecursiveWorker,
    RecursiveWorkerEnrollment,
    Run,
    User,
)
from ..recursive import broker, bundle, policy, tokens, worker_events
from ..schemas import (
    RecursiveAgentJobDetailOut,
    RecursiveAgentJobOut,
    RecursiveAgentNodeOut,
    RecursiveCompletionIn,
    RecursiveEnrolledOut,
    RecursiveEnrollIn,
    RecursiveEventBatchIn,
    RecursiveEventBatchOut,
    RecursiveFailIn,
    RecursiveHeartbeatIn,
    RecursiveHeartbeatOut,
    RecursiveJobAckOut,
    RecursiveJobControlOut,
    RecursiveJobLimitsOut,
    RecursiveLeaseOut,
    RecursiveLeaseRequestIn,
    RecursiveTreeOut,
    RecursiveWorkerEnrollmentCreatedOut,
    RecursiveWorkerEnrollmentIn,
    RecursiveWorkerOut,
)
from ..security import get_current_user, require_workspace_role

logger = logging.getLogger("vls.recursive.api")

NOT_FOUND = HTTPException(status_code=404, detail={"code": "not_found", "message": "Not found"})


# ---------------------------------------------------------------------------
# Request body limits
# ---------------------------------------------------------------------------

# Which setting caps each endpoint's upload. Everything else on this router
# exchanges small JSON, and the event limit is a generous ceiling for it.
_BODY_LIMIT_SETTINGS: dict[str, str] = {
    "post_job_events": "recursive_job_event_body_max_bytes",
    "complete_job_route": "recursive_job_result_body_max_bytes",
}
_DEFAULT_BODY_LIMIT_SETTING = "recursive_job_event_body_max_bytes"


def _too_large(limit: int) -> HTTPException:
    return HTTPException(
        status_code=413,
        detail={
            "code": "body_too_large",
            "message": f"Request body exceeds the {limit} byte limit for this endpoint.",
        },
    )


# Far deeper than any legitimate payload on this router -- the deepest is an
# event batch at roughly six levels -- and far below CPython's recursion limit,
# which the JSON parser hits at a few thousand and answers with a RecursionError
# rather than a refusal. A worker is authenticated but not trusted, so the
# structure of its body is bounded the same way its size is.
MAX_JSON_DEPTH = 32


def _json_depth_exceeded(raw: bytes, limit: int) -> bool:
    """True when the body nests brackets deeper than ``limit``.

    A byte scan rather than a parse: the whole point is to decide before the
    parser recurses. String contents are skipped so a brace inside a quoted
    value cannot inflate the count.
    """
    depth = 0
    in_string = False
    escaped = False
    for byte in raw:
        if in_string:
            if escaped:
                escaped = False
            elif byte == 0x5C:  # backslash
                escaped = True
            elif byte == 0x22:  # closing quote
                in_string = False
            continue
        if byte == 0x22:
            in_string = True
        elif byte in (0x7B, 0x5B):  # { [
            depth += 1
            if depth > limit:
                return True
        elif byte in (0x7D, 0x5D):  # } ]
            depth -= 1
    return False


def _too_deep() -> HTTPException:
    return HTTPException(
        status_code=400,
        detail={
            "code": "body_too_deeply_nested",
            "message": (
                f"Request body nests more than {MAX_JSON_DEPTH} levels deep."
            ),
        },
    )


class BodyLimitRoute(APIRoute):
    """Refuse an oversized upload before it is read into memory.

    This has to live in the route rather than in a dependency: FastAPI reads
    and parses the whole body *before* dependencies run, so by the time a
    dependency could look at it the memory has already been spent. The field
    limits on the Pydantic models bound what a valid payload may contain; this
    bounds what an authenticated worker can make the server buffer at all.

    A declared ``Content-Length`` is rejected outright. A chunked upload
    declares nothing, so the stream is consumed with a running cap and dropped
    the moment it goes over.
    """

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        inner = super().get_route_handler()
        setting_name = _BODY_LIMIT_SETTINGS.get(
            getattr(self.endpoint, "__name__", ""), _DEFAULT_BODY_LIMIT_SETTING
        )

        async def limited(request: Request) -> Response:
            limit: int = getattr(get_settings(), setting_name)
            declared = request.headers.get("content-length")
            if declared is not None:
                try:
                    if int(declared) > limit:
                        raise _too_large(limit)
                except ValueError:
                    raise HTTPException(
                        status_code=400,
                        detail={
                            "code": "bad_content_length",
                            "message": "Content-Length is not a number.",
                        },
                    ) from None
            else:
                chunks: list[bytes] = []
                size = 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > limit:
                        raise _too_large(limit)
                    chunks.append(chunk)
                # Hand the buffered body on: Starlette reuses ``_body`` rather
                # than trying to read the now-exhausted stream a second time.
                request._body = b"".join(chunks)

            # Size alone does not bound the cost of parsing: a body well under
            # the cap can nest deeply enough to exhaust the interpreter's stack
            # inside the JSON parser, which surfaces as a 500 rather than a
            # refusal. Reading here is safe -- the body is already capped -- and
            # Starlette caches it for the parse that follows.
            if request.method in {"POST", "PUT", "PATCH"}:
                if _json_depth_exceeded(await request.body(), MAX_JSON_DEPTH):
                    raise _too_deep()

            return await inner(request)

        return limited


router = APIRouter(route_class=BodyLimitRoute)


def require_feature() -> Settings:
    """The feature must be on, or the routes do not exist."""
    settings = get_settings()
    if not settings.recursive_agents_enabled:
        raise NOT_FOUND
    return settings


# ---------------------------------------------------------------------------
# Worker authentication
# ---------------------------------------------------------------------------


async def get_worker(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> RecursiveWorker:
    """Resolve the bearer credential to an enrolled, unrevoked worker.

    Deliberately reads no cookie. Every failure -- malformed header, unknown
    prefix, wrong secret, revoked worker -- produces the same 401, so probing
    cannot distinguish "no such worker" from "wrong secret".
    """
    require_feature()
    scheme, _, raw = (authorization or "").partition(" ")
    if scheme.lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail={"code": "unauthenticated", "message": "Worker credential required"},
        )
    parsed = tokens.parse(tokens.WORKER_PREFIX, raw.strip())
    if parsed is None:
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_worker_token", "message": "Worker credential rejected"},
        )
    prefix, secret = parsed
    worker = (
        await db.execute(
            select(RecursiveWorker).where(RecursiveWorker.token_prefix == prefix)
        )
    ).scalar_one_or_none()
    if (
        worker is None
        or worker.revoked_at is not None
        or not tokens.verify(tokens.WORKER_PREFIX, secret, worker.token_hash)
    ):
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_worker_token", "message": "Worker credential rejected"},
        )
    if not worker.enabled:
        raise HTTPException(
            status_code=403,
            detail={"code": "worker_disabled", "message": "This worker is disabled."},
        )
    return worker


def _reject(exc: broker.JobRejected) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code, detail={"code": exc.code, "message": exc.safe_message}
    )


# ---------------------------------------------------------------------------
# Workspace administration (session cookie)
# ---------------------------------------------------------------------------


@router.get(
    "/workspaces/{workspace_id}/recursive-workers", response_model=list[RecursiveWorkerOut]
)
async def list_workers(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[RecursiveWorker]:
    require_feature()
    await require_workspace_role(db, workspace_id, user, "researcher")
    rows = (
        await db.execute(
            select(RecursiveWorker)
            .where(RecursiveWorker.workspace_id == workspace_id)
            .order_by(RecursiveWorker.created_at)
        )
    ).scalars().all()
    return list(rows)


@router.post(
    "/workspaces/{workspace_id}/recursive-worker-enrollments",
    response_model=RecursiveWorkerEnrollmentCreatedOut,
    status_code=201,
)
async def create_enrollment(
    workspace_id: uuid.UUID,
    payload: RecursiveWorkerEnrollmentIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecursiveWorkerEnrollmentCreatedOut:
    """Mint a short-lived enrollment token. Admin only, shown exactly once."""
    settings = require_feature()
    await require_workspace_role(db, workspace_id, user, "admin")
    display_name = payload.display_name.strip()[:200]
    if not display_name:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_request", "message": "A worker name is required."},
        )

    minted = tokens.mint(tokens.ENROLLMENT_PREFIX)
    row = RecursiveWorkerEnrollment(
        workspace_id=workspace_id,
        token_prefix=minted.prefix,
        token_hash=minted.token_hash,
        requested_display_name=display_name,
        expires_at=datetime.now(UTC)
        + timedelta(seconds=settings.recursive_worker_enrollment_ttl_seconds),
        created_by=user.id,
    )
    db.add(row)
    db.add(
        AuditEvent(
            workspace_id=workspace_id,
            actor_user_id=user.id,
            action="recursive_worker.enrollment_created",
            entity_type="recursive_worker_enrollment",
            entity_id=row.id,
            # The prefix only. The secret half is never written anywhere.
            metadata_json={"display_name": display_name, "token_prefix": minted.prefix},
            ip_address=request.client.host if request.client else None,
        )
    )
    await db.commit()
    return RecursiveWorkerEnrollmentCreatedOut(
        id=row.id,
        workspace_id=row.workspace_id,
        requested_display_name=row.requested_display_name,
        token_prefix=row.token_prefix,
        expires_at=row.expires_at,
        created_at=row.created_at,
        enrollment_token=minted.raw,
    )


async def _worker_admin(
    db: AsyncSession, workspace_id: uuid.UUID, worker_id: uuid.UUID, user: User
) -> RecursiveWorker:
    await require_workspace_role(db, workspace_id, user, "admin")
    worker = await db.get(RecursiveWorker, worker_id)
    if worker is None or worker.workspace_id != workspace_id:
        raise NOT_FOUND
    return worker


@router.post(
    "/workspaces/{workspace_id}/recursive-workers/{worker_id}/disable",
    response_model=RecursiveWorkerOut,
)
async def disable_worker(
    workspace_id: uuid.UUID,
    worker_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecursiveWorker:
    require_feature()
    worker = await _worker_admin(db, workspace_id, worker_id, user)
    worker.enabled = False
    worker.status = "disabled"
    worker.disabled_by = user.id
    worker.disabled_at = datetime.now(UTC)
    await db.commit()
    return worker


@router.post(
    "/workspaces/{workspace_id}/recursive-workers/{worker_id}/enable",
    response_model=RecursiveWorkerOut,
)
async def enable_worker(
    workspace_id: uuid.UUID,
    worker_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecursiveWorker:
    require_feature()
    worker = await _worker_admin(db, workspace_id, worker_id, user)
    if worker.revoked_at is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "worker_revoked",
                "message": "A revoked worker cannot be re-enabled. Enroll it again.",
            },
        )
    worker.enabled = True
    # Not "online": the worker proves that by checking in.
    worker.status = "offline"
    worker.disabled_by = None
    worker.disabled_at = None
    await db.commit()
    return worker


@router.post(
    "/workspaces/{workspace_id}/recursive-workers/{worker_id}/revoke",
    response_model=RecursiveWorkerOut,
)
async def revoke_worker(
    workspace_id: uuid.UUID,
    worker_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecursiveWorker:
    """Permanently invalidate a worker's credential.

    The hash is overwritten rather than merely flagged, so the credential stops
    working even if a later code path forgets to check ``revoked_at``.
    """
    require_feature()
    worker = await _worker_admin(db, workspace_id, worker_id, user)
    now = datetime.now(UTC)
    worker.enabled = False
    worker.status = "revoked"
    worker.revoked_by = user.id
    worker.revoked_at = now
    worker.token_hash = f"revoked:{now.isoformat()}"
    await db.commit()
    return worker


async def _run_for_user(db: AsyncSession, run_id: uuid.UUID, user: User) -> Run:
    run = await db.get(Run, run_id)
    if run is None:
        raise NOT_FOUND
    await require_workspace_role(db, run.workspace_id, user, "viewer")
    return run


async def _job_details(
    db: AsyncSession, jobs: list[RecursiveAgentJob]
) -> list[RecursiveAgentJobDetailOut]:
    out: list[RecursiveAgentJobDetailOut] = []
    for job in jobs:
        nodes = (
            await db.execute(
                select(RecursiveAgentNode)
                .where(RecursiveAgentNode.job_id == job.id)
                .order_by(RecursiveAgentNode.created_at)
            )
        ).scalars().all()
        out.append(
            RecursiveAgentJobDetailOut(
                job=RecursiveAgentJobOut.model_validate(job),
                nodes=[RecursiveAgentNodeOut.model_validate(n) for n in nodes],
            )
        )
    return out


@router.get("/runs/{run_id}/recursive-jobs", response_model=list[RecursiveAgentJobOut])
async def list_run_jobs(
    run_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[RecursiveAgentJob]:
    require_feature()
    run = await _run_for_user(db, run_id, user)
    rows = (
        await db.execute(
            select(RecursiveAgentJob)
            .where(RecursiveAgentJob.run_id == run.id)
            .order_by(RecursiveAgentJob.created_at)
        )
    ).scalars().all()
    return list(rows)


@router.get("/runs/{run_id}/recursive-tree", response_model=RecursiveTreeOut)
async def get_run_tree(
    run_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecursiveTreeOut:
    require_feature()
    run = await _run_for_user(db, run_id, user)
    jobs = (
        await db.execute(
            select(RecursiveAgentJob)
            .where(RecursiveAgentJob.run_id == run.id)
            .order_by(RecursiveAgentJob.created_at)
        )
    ).scalars().all()
    return RecursiveTreeOut(run_id=run.id, jobs=await _job_details(db, list(jobs)))


@router.get("/recursive-jobs/{job_id}", response_model=RecursiveAgentJobDetailOut)
async def get_job(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecursiveAgentJobDetailOut:
    require_feature()
    job = await db.get(RecursiveAgentJob, job_id)
    if job is None:
        raise NOT_FOUND
    # Masked as not-found for a non-member, so a job id cannot be confirmed by
    # probing for a 403.
    await require_workspace_role(db, job.workspace_id, user, "viewer")
    details = await _job_details(db, [job])
    return details[0]


# ---------------------------------------------------------------------------
# Worker protocol
# ---------------------------------------------------------------------------


@router.post("/recursive-workers/enroll", response_model=RecursiveEnrolledOut, status_code=201)
async def enroll_worker(
    payload: RecursiveEnrollIn, db: AsyncSession = Depends(get_db)
) -> RecursiveEnrolledOut:
    """Exchange a one-time enrollment token for a long-lived worker credential."""
    settings = require_feature()
    parsed = tokens.parse(tokens.ENROLLMENT_PREFIX, payload.enrollment_token)
    invalid = HTTPException(
        status_code=401,
        detail={
            "code": "invalid_enrollment_token",
            "message": "This enrollment token is not valid or has expired.",
        },
    )
    if parsed is None:
        raise invalid
    prefix, secret = parsed
    enrollment = (
        await db.execute(
            select(RecursiveWorkerEnrollment)
            .where(RecursiveWorkerEnrollment.token_prefix == prefix)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if (
        enrollment is None
        or enrollment.consumed_at is not None
        or enrollment.expires_at <= datetime.now(UTC)
        or not tokens.verify(tokens.ENROLLMENT_PREFIX, secret, enrollment.token_hash)
    ):
        await db.commit()
        raise invalid

    minted = tokens.mint(tokens.WORKER_PREFIX)
    worker = RecursiveWorker(
        workspace_id=enrollment.workspace_id,
        display_name=(payload.display_name or enrollment.requested_display_name)[:200],
        status="online",
        enabled=True,
        token_prefix=minted.prefix,
        token_hash=minted.token_hash,
        adapter_version=payload.adapter_version,
        prime_agent_version=payload.prime_agent_version,
        sandbox_mode=payload.sandbox_mode,
        capabilities=policy.normalize_capabilities(payload),
        model_catalog=policy.normalize_catalog(payload),
        last_seen_at=datetime.now(UTC),
        enrolled_by=enrollment.created_by,
    )
    db.add(worker)
    await db.flush()
    enrollment.consumed_at = datetime.now(UTC)
    enrollment.consumed_worker_id = worker.id
    db.add(
        AuditEvent(
            workspace_id=worker.workspace_id,
            actor_user_id=enrollment.created_by,
            action="recursive_worker.enrolled",
            entity_type="recursive_worker",
            entity_id=worker.id,
            metadata_json={
                "display_name": worker.display_name,
                "token_prefix": minted.prefix,
                "sandbox_mode": worker.sandbox_mode,
                "adapter_version": worker.adapter_version,
            },
        )
    )
    await db.commit()
    logger.info("Recursive worker %s enrolled in workspace %s", worker.id, worker.workspace_id)
    return RecursiveEnrolledOut(
        worker_id=worker.id,
        workspace_id=worker.workspace_id,
        display_name=worker.display_name,
        worker_token=minted.raw,
        heartbeat_interval_seconds=max(
            5, settings.recursive_worker_offline_after_seconds // 3
        ),
        lease_poll_interval_seconds=5,
    )


@router.post("/recursive-workers/heartbeat", response_model=RecursiveHeartbeatOut)
async def worker_heartbeat(
    payload: RecursiveHeartbeatIn,
    db: AsyncSession = Depends(get_db),
    worker: RecursiveWorker = Depends(get_worker),
) -> RecursiveHeartbeatOut:
    """Liveness plus the worker's only channel for learning about cancellation."""
    settings = get_settings()
    worker.last_seen_at = datetime.now(UTC)
    worker.adapter_version = payload.adapter_version or worker.adapter_version
    worker.prime_agent_version = payload.prime_agent_version or worker.prime_agent_version
    worker.sandbox_mode = payload.sandbox_mode or worker.sandbox_mode
    if payload.model_catalog:
        worker.model_catalog = policy.normalize_catalog(payload)
    if payload.capabilities.profiles:
        worker.capabilities = policy.normalize_capabilities(payload)
    unhealthy = "error" in {
        payload.health.prime_agent, payload.health.sandbox, payload.health.models
    }
    degraded = "degraded" in {
        payload.health.prime_agent, payload.health.sandbox, payload.health.models
    }
    worker.status = "degraded" if (unhealthy or degraded) else "online"
    worker.last_error_safe_message = payload.health.safe_message

    controls: list[RecursiveJobControlOut] = []
    if payload.active_job_ids:
        jobs = (
            await db.execute(
                select(RecursiveAgentJob).where(
                    RecursiveAgentJob.id.in_(payload.active_job_ids),
                    RecursiveAgentJob.leased_worker_id == worker.id,
                )
            )
        ).scalars().all()
        for job in jobs:
            run = await db.get(Run, job.run_id)
            controls.append(
                RecursiveJobControlOut(
                    job_id=job.id,
                    cancel_requested=job.cancellation_requested_at is not None
                    or (run is not None and run.control_requested == "cancel"),
                    pause_requested=run is not None and run.control_requested == "pause",
                )
            )
            # A heartbeat that names the job is proof of life for it, so the
            # long-running work does not have to poll a second endpoint to
            # keep its lease.
            await broker.renew_job_lease(db, job, worker, settings)
    await db.commit()
    return RecursiveHeartbeatOut(
        worker_id=worker.id,
        status=worker.status,
        heartbeat_interval_seconds=max(5, settings.recursive_worker_offline_after_seconds // 3),
        lease_poll_interval_seconds=5,
        job_controls=controls,
    )


@router.post("/recursive-workers/jobs/lease", response_model=RecursiveLeaseOut | None)
async def lease_job(
    payload: RecursiveLeaseRequestIn,
    db: AsyncSession = Depends(get_db),
    worker: RecursiveWorker = Depends(get_worker),
) -> Response | RecursiveLeaseOut:
    settings = get_settings()
    worker.last_seen_at = datetime.now(UTC)
    if worker.status == "offline":
        worker.status = "online"
    await db.commit()

    if payload.available_slots <= 0:
        return Response(status_code=204)
    profiles = payload.supported_profiles or sorted(policy.SUPPORTED_PROFILES)
    model_keys = payload.model_keys or [
        str(m.get("model_key")) for m in (worker.model_catalog or []) if m.get("model_key")
    ]
    if not model_keys:
        return Response(status_code=204)

    job = await broker.lease_next_job(
        db, worker, supported_profiles=profiles, model_keys=model_keys, settings=settings
    )
    if job is None:
        return Response(status_code=204)
    return RecursiveLeaseOut(
        job_id=job.id,
        run_id=job.run_id,
        attempt=job.attempt_count,
        request_sha256=job.request_sha256,
        capability_profile=job.capability_profile,
        model_key=job.model_key,
        child_model_key=job.child_model_key,
        limits=RecursiveJobLimitsOut(
            max_children=job.max_children,
            max_depth=job.max_depth,
            max_agent_turns=job.max_agent_turns,
            max_tokens=job.max_tokens,
            max_runtime_seconds=job.max_runtime_seconds,
            max_cost_usd=float(job.max_cost_usd) if job.max_cost_usd is not None else None,
        ),
        allowed_skill_ids=list(
            (job.request_json or {}).get("execution", {}).get("allowed_skill_ids", [])
        ),
        lease_expires_at=job.lease_expires_at or datetime.now(UTC),
        heartbeat_interval_seconds=max(5, settings.recursive_job_lease_seconds // 3),
        bundle_url=worker_events.job_bundle_path(job.id),
    )


@router.post("/recursive-jobs/{job_id}/heartbeat", response_model=RecursiveJobControlOut)
async def job_heartbeat(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    worker: RecursiveWorker = Depends(get_worker),
) -> RecursiveJobControlOut:
    settings = get_settings()
    try:
        job = await broker.load_leased_job(db, job_id, worker)
    except broker.JobRejected as exc:
        raise _reject(exc) from None
    worker.last_seen_at = datetime.now(UTC)
    if not await broker.renew_job_lease(db, job, worker, settings):
        await db.commit()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "lease_lost",
                "message": "This job's lease has expired or moved to another worker.",
            },
        )
    run = await db.get(Run, job.run_id)
    await db.commit()
    return RecursiveJobControlOut(
        job_id=job.id,
        cancel_requested=job.cancellation_requested_at is not None
        or (run is not None and run.control_requested == "cancel"),
        pause_requested=run is not None and run.control_requested == "pause",
    )


@router.get("/recursive-jobs/{job_id}/bundle")
async def get_job_bundle(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    worker: RecursiveWorker = Depends(get_worker),
) -> Response:
    """The frozen evidence and brief for a job this worker currently holds."""
    try:
        job = await broker.load_leased_job(db, job_id, worker)
        broker.require_live_lease(job, worker)
    except broker.JobRejected as exc:
        raise _reject(exc) from None
    definition = await db.get(MeetingDefinition, job.meeting_definition_id)
    if definition is None:
        raise NOT_FOUND
    data = await bundle.build_bundle(db, job, definition)
    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="job-{job.id}.zip"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/recursive-jobs/{job_id}/events", response_model=RecursiveEventBatchOut)
async def post_job_events(
    job_id: uuid.UUID,
    payload: RecursiveEventBatchIn,
    db: AsyncSession = Depends(get_db),
    worker: RecursiveWorker = Depends(get_worker),
) -> RecursiveEventBatchOut:
    settings = get_settings()
    try:
        job = await broker.load_leased_job(db, job_id, worker, for_update=True)
        broker.require_live_lease(job, worker)
    except broker.JobRejected as exc:
        await db.commit()
        raise _reject(exc) from None

    try:
        accepted, duplicates, rejected = await worker_events.ingest_batch(
            db, job, payload.events, batch_max=settings.recursive_job_event_batch_max
        )
    except worker_events.EventRejected as exc:
        await db.rollback()
        raise HTTPException(
            status_code=413, detail={"code": exc.code, "message": exc.safe_message}
        ) from None

    if job.status == "leased":
        job.status = "running"
    worker.last_seen_at = datetime.now(UTC)
    await broker.renew_job_lease(db, job, worker, settings)
    await db.commit()
    return RecursiveEventBatchOut(
        accepted=accepted, duplicates=duplicates, rejected=rejected
    )


@router.post("/recursive-jobs/{job_id}/complete", response_model=RecursiveJobAckOut)
async def complete_job_route(
    job_id: uuid.UUID,
    payload: RecursiveCompletionIn,
    db: AsyncSession = Depends(get_db),
    worker: RecursiveWorker = Depends(get_worker),
) -> RecursiveJobAckOut:
    try:
        outcome, job = await broker.complete_job(db, job_id, worker, payload)
    except broker.JobRejected as exc:
        raise _reject(exc) from None
    detail = {
        "accepted": None,
        "duplicate": "This result was already recorded.",
        "cancelled": (
            "The researcher cancelled this meeting before the result arrived. "
            "The reported usage was recorded; the result was discarded. Stop work on this job."
        ),
    }[outcome]
    return RecursiveJobAckOut(
        job_id=job.id,
        status=job.status,
        accepted=outcome != "cancelled",
        detail=detail,
    )


@router.post("/recursive-jobs/{job_id}/fail", response_model=RecursiveJobAckOut)
async def fail_job_route(
    job_id: uuid.UUID,
    payload: RecursiveFailIn,
    db: AsyncSession = Depends(get_db),
    worker: RecursiveWorker = Depends(get_worker),
) -> RecursiveJobAckOut:
    try:
        job = await broker.load_leased_job(db, job_id, worker, for_update=True)
    except broker.JobRejected as exc:
        await db.commit()
        raise _reject(exc) from None
    if job.status in broker.TERMINAL_JOB_STATUSES:
        status = job.status
        job_ref = job.id
        await db.commit()
        return RecursiveJobAckOut(
            job_id=job_ref, status=status, accepted=True, detail="Already settled."
        )
    try:
        # Same fence as /events, /heartbeat and /complete: a worker whose lease
        # has lapsed no longer speaks for this job, and must not terminalise a
        # turn the sweeper is about to requeue -- possibly to a fresh attempt.
        broker.require_live_lease(job, worker)
    except broker.JobRejected as exc:
        await db.commit()
        raise _reject(exc) from None
    outcome = await broker.fail_job(
        db,
        job,
        failure_code=payload.failure_code,
        safe_message=payload.safe_message,
        retryable=payload.retryable,
        usage=payload.usage,
    )
    return RecursiveJobAckOut(job_id=job.id, status=job.status, accepted=True, detail=outcome)


@router.post("/recursive-jobs/{job_id}/release", response_model=RecursiveJobAckOut)
async def release_job_route(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    worker: RecursiveWorker = Depends(get_worker),
) -> RecursiveJobAckOut:
    try:
        job = await broker.load_leased_job(db, job_id, worker, for_update=True)
    except broker.JobRejected as exc:
        await db.commit()
        raise _reject(exc) from None
    if job.status in broker.TERMINAL_JOB_STATUSES:
        status, job_ref = job.status, job.id
        await db.commit()
        return RecursiveJobAckOut(
            job_id=job_ref, status=status, accepted=True, detail="Already settled."
        )
    try:
        broker.require_live_lease(job, worker)
    except broker.JobRejected as exc:
        await db.commit()
        raise _reject(exc) from None
    await broker.release_job(db, job)
    return RecursiveJobAckOut(job_id=job.id, status=job.status, accepted=True, detail="queued")
