"""Project pre-registration: frozen, hashed statements of what a project set
out to test, written before any run.

A pre-registration is editable while ``draft`` and immutable forever once
``registered``: its ``content_hash`` is taken over the canonical JSON of the
substantive fields at that moment. A later change is a new version that
supersedes the active one with a stated reason, so the chain shows whether the
question moved and when. A project may be switched into a mode where no run may
launch without an active registered pre-registration.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..engine import canonical_json, sha256_text
from ..models import AuditEvent, PreRegistration, Project, User
from ..provenance import content_fields
from ..security import get_current_user, get_membership, require_workspace_role

router = APIRouter()

UTC = timezone.utc


# ---------------------------------------------------------------------------
# helpers (local copies; importing from v1 would create a circular import)
# ---------------------------------------------------------------------------

def problem(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


async def audit(
    db: AsyncSession, workspace_id: uuid.UUID, actor: User | None, action: str,
    object_type: str, object_id: str | None, metadata: dict[str, Any] | None = None,
) -> None:
    db.add(AuditEvent(
        workspace_id=workspace_id, actor_user_id=actor.id if actor else None,
        action=action, object_type=object_type, object_id=object_id,
        metadata_json=metadata or {},
    ))


# ---------------------------------------------------------------------------
# request / response models (defined here, not in schemas.py)
# ---------------------------------------------------------------------------

class PreRegistrationListItem(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    version: int
    status: str
    is_active: bool
    title: str
    supersedes_id: uuid.UUID | None
    content_hash: str | None
    registered_at: datetime | None
    withdrawn_at: datetime | None
    created_at: datetime
    updated_at: datetime


class PreRegistrationOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    version: int
    status: str
    is_active: bool
    supersedes_id: uuid.UUID | None
    title: str
    hypothesis: str
    protocol: str
    expected_outcomes: str
    success_criteria: str
    analysis_plan: str
    amendment_reason: str | None
    content_json: dict[str, Any]
    content_hash: str | None
    registered_at: datetime | None
    registered_by: uuid.UUID | None
    withdrawn_at: datetime | None
    withdrawn_reason: str | None
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    # Set on withdraw to state plainly whether launches are now blocked.
    launch_impact: str | None = None


class PreRegistrationCreateIn(BaseModel):
    title: str = Field(min_length=1)
    hypothesis: str = ""
    protocol: str = ""
    expected_outcomes: str = ""
    success_criteria: str = ""
    analysis_plan: str = ""
    supersedes_id: uuid.UUID | None = None
    amendment_reason: str | None = None


class PreRegistrationPatchIn(BaseModel):
    title: str | None = None
    hypothesis: str | None = None
    protocol: str | None = None
    expected_outcomes: str | None = None
    success_criteria: str | None = None
    analysis_plan: str | None = None
    amendment_reason: str | None = None


class WithdrawIn(BaseModel):
    reason: str = Field(min_length=1)


class PolicyIn(BaseModel):
    pre_registration_required: bool


class PolicyOut(BaseModel):
    project_id: uuid.UUID
    pre_registration_required: bool
    warning: str | None = None


# ---------------------------------------------------------------------------
# serialisation helpers
# ---------------------------------------------------------------------------

def _out(pr: PreRegistration) -> PreRegistrationOut:
    return PreRegistrationOut(
        id=pr.id, workspace_id=pr.workspace_id, project_id=pr.project_id,
        version=pr.version, status=pr.status, is_active=pr.status == "registered",
        supersedes_id=pr.supersedes_id, title=pr.title, hypothesis=pr.hypothesis,
        protocol=pr.protocol, expected_outcomes=pr.expected_outcomes,
        success_criteria=pr.success_criteria, analysis_plan=pr.analysis_plan,
        amendment_reason=pr.amendment_reason, content_json=pr.content_json or {},
        content_hash=pr.content_hash, registered_at=pr.registered_at,
        registered_by=pr.registered_by, withdrawn_at=pr.withdrawn_at,
        withdrawn_reason=pr.withdrawn_reason, created_by=pr.created_by,
        created_at=pr.created_at, updated_at=pr.updated_at,
    )


async def _get_project(db: AsyncSession, project_id: uuid.UUID, user: User, minimum_role: str) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise problem(404, "not_found", "Project not found")
    await require_workspace_role(db, project.workspace_id, user, minimum_role)
    return project


async def _get_prereg(db: AsyncSession, prereg_id: uuid.UUID, user: User, minimum_role: str) -> PreRegistration:
    pr = await db.get(PreRegistration, prereg_id)
    if pr is None:
        raise problem(404, "not_found", "Pre-registration not found")
    await require_workspace_role(db, pr.workspace_id, user, minimum_role)
    return pr


# ---------------------------------------------------------------------------
# launch gate — called by the main agent from the run-launch path
# ---------------------------------------------------------------------------

async def active_pre_registration(db, project_id) -> PreRegistration | None:
    """Return the single active (registered) pre-registration for a project."""
    return (
        await db.execute(
            select(PreRegistration).where(
                PreRegistration.project_id == project_id,
                PreRegistration.status == "registered",
            )
        )
    ).scalar_one_or_none()


async def assert_pre_registration_gate(db, project) -> tuple[uuid.UUID | None, str | None]:
    """Enforce a project's pre-registration policy at launch time.

    Given an already-loaded ``Project``: if the policy is off, returns
    ``(None, None)``. Otherwise returns ``(id, content_hash)`` of the active
    registered pre-registration so the caller can freeze both onto the run row.
    The hash is returned (not only the id) so a finished run can prove which
    exact text it ran under even after a later amendment supersedes the row.
    Raises 409 ``pre_registration_required`` when the policy is on and no
    active pre-registration exists.
    """
    # Lock the project row for the rest of the caller's transaction. Every
    # transition that could invalidate this gate — withdraw, register, and the
    # policy switch — takes the same lock, so a withdrawal cannot commit in the
    # window between reading the active document and inserting the run. The
    # caller must hold this until it commits the run.
    await db.execute(select(Project.id).where(Project.id == project.id).with_for_update())
    await db.refresh(project, ["pre_registration_required"])
    if not project.pre_registration_required:
        return (None, None)
    active = await active_pre_registration(db, project.id)
    if active is None:
        raise problem(
            409, "pre_registration_required",
            "This project requires a registered pre-registration before any run may "
            "launch. Register one first.",
        )
    return (active.id, active.content_hash)


# ---------------------------------------------------------------------------
# list / get
# ---------------------------------------------------------------------------

@router.get("/projects/{project_id}/pre-registrations", response_model=list[PreRegistrationListItem])
async def list_pre_registrations(
    project_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    project = await _get_project(db, project_id, user, "viewer")
    rows = list(
        (
            await db.execute(
                select(PreRegistration).where(PreRegistration.project_id == project.id)
                .order_by(PreRegistration.version.desc())
            )
        ).scalars()
    )
    return [
        PreRegistrationListItem(
            id=pr.id, project_id=pr.project_id, version=pr.version, status=pr.status,
            is_active=pr.status == "registered", title=pr.title,
            supersedes_id=pr.supersedes_id, content_hash=pr.content_hash,
            registered_at=pr.registered_at, withdrawn_at=pr.withdrawn_at,
            created_at=pr.created_at, updated_at=pr.updated_at,
        )
        for pr in rows
    ]


@router.get("/pre-registrations/{prereg_id}", response_model=PreRegistrationOut)
async def get_pre_registration(
    prereg_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return _out(await _get_prereg(db, prereg_id, user, "viewer"))


# ---------------------------------------------------------------------------
# create draft
# ---------------------------------------------------------------------------

@router.post("/projects/{project_id}/pre-registrations", response_model=PreRegistrationOut, status_code=201)
async def create_pre_registration(
    project_id: uuid.UUID, body: PreRegistrationCreateIn,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    project = await _get_project(db, project_id, user, "researcher")

    # Lock the project row so two simultaneous creates cannot both compute the
    # same next version and collide on UNIQUE (project_id, version).
    await db.execute(select(Project.id).where(Project.id == project.id).with_for_update())

    if body.supersedes_id is not None:
        target = await db.get(PreRegistration, body.supersedes_id)
        if target is None or target.project_id != project.id:
            raise problem(422, "invalid_supersedes", "supersedes_id must name a pre-registration of this project.")
        if target.status != "registered":
            raise problem(422, "invalid_supersedes", "Only a registered pre-registration can be superseded.")
        if not (body.amendment_reason or "").strip():
            raise problem(422, "amendment_reason_required", "An amendment must state a reason.")

    next_version = (
        await db.execute(
            select(func.coalesce(func.max(PreRegistration.version), 0) + 1)
            .where(PreRegistration.project_id == project.id)
        )
    ).scalar_one()

    pr = PreRegistration(
        workspace_id=project.workspace_id, project_id=project.id, version=next_version,
        status="draft", supersedes_id=body.supersedes_id, title=body.title.strip(),
        hypothesis=body.hypothesis, protocol=body.protocol,
        expected_outcomes=body.expected_outcomes, success_criteria=body.success_criteria,
        analysis_plan=body.analysis_plan,
        amendment_reason=(body.amendment_reason.strip() if body.amendment_reason else None),
        created_by=user.id,
    )
    db.add(pr)
    await db.flush()
    await audit(
        db, project.workspace_id, user, "pre_registration.created", "pre_registration", str(pr.id),
        {"version": next_version, "supersedes_id": str(body.supersedes_id) if body.supersedes_id else None},
    )
    await db.commit()
    await db.refresh(pr)
    return _out(pr)


# ---------------------------------------------------------------------------
# patch draft
# ---------------------------------------------------------------------------

@router.patch("/pre-registrations/{prereg_id}", response_model=PreRegistrationOut)
async def update_pre_registration(
    prereg_id: uuid.UUID, body: PreRegistrationPatchIn,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    pr = await _get_prereg(db, prereg_id, user, "researcher")
    # Serialize against registration on the same row this project's other
    # transitions use. Without it, this is a read-decide-write on `status`: the
    # draft could be registered and frozen between the check below and the
    # writes that follow, and those writes would then alter a registered
    # document without recomputing its content hash — defeating the one promise
    # pre-registration makes. Re-read the status after taking the lock, because
    # the object above was loaded before it.
    await db.execute(select(Project.id).where(Project.id == pr.project_id).with_for_update())
    await db.refresh(pr, ["status"])
    if pr.status != "draft":
        # The central promise of the feature: no path mutates a registered row's
        # content.
        raise problem(
            409, "pre_registration_frozen",
            "This pre-registration is frozen and cannot be edited. Create a new "
            "version that supersedes it instead.",
        )
    if body.title is not None:
        if not body.title.strip():
            raise problem(422, "invalid_title", "Title cannot be empty.")
        pr.title = body.title.strip()
    if body.hypothesis is not None:
        pr.hypothesis = body.hypothesis
    if body.protocol is not None:
        pr.protocol = body.protocol
    if body.expected_outcomes is not None:
        pr.expected_outcomes = body.expected_outcomes
    if body.success_criteria is not None:
        pr.success_criteria = body.success_criteria
    if body.analysis_plan is not None:
        pr.analysis_plan = body.analysis_plan
    if body.amendment_reason is not None:
        pr.amendment_reason = body.amendment_reason.strip() or None
    await audit(
        db, pr.workspace_id, user, "pre_registration.updated", "pre_registration", str(pr.id),
        {"version": pr.version},
    )
    await db.commit()
    await db.refresh(pr)
    return _out(pr)


# ---------------------------------------------------------------------------
# register (freeze)
# ---------------------------------------------------------------------------

@router.post("/pre-registrations/{prereg_id}/register", response_model=PreRegistrationOut)
async def register_pre_registration(
    prereg_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    pr = await _get_prereg(db, prereg_id, user, "researcher")
    if pr.status != "draft":
        raise problem(409, "pre_registration_frozen", "Only a draft pre-registration can be registered.")

    if not (pr.hypothesis or "").strip() or not (pr.protocol or "").strip() or not (pr.expected_outcomes or "").strip():
        raise problem(
            422, "incomplete_pre_registration",
            "A pre-registration needs a hypothesis, a protocol and expected outcomes before it can be registered.",
        )

    # Lock the project row and re-check the active-uniqueness invariant so two
    # concurrent registers cannot both pass the single-active check.
    await db.execute(select(Project.id).where(Project.id == pr.project_id).with_for_update())
    existing_active = await active_pre_registration(db, pr.project_id)
    if existing_active is not None:
        if pr.supersedes_id != existing_active.id:
            raise problem(
                409, "pre_registration_conflict",
                "Another pre-registration is already active. Register this as an "
                "amendment that supersedes it, or withdraw the active one first.",
            )
        existing_active.status = "superseded"
        # Flushed on its own, before the new row is marked registered. Only one
        # row per project may be registered at a time and the index enforcing
        # that is not deferrable, so both UPDATEs in a single flush would trip
        # it: SQLAlchemy orders them by when each row entered the session, and
        # the row being registered was loaded first.
        await db.flush()

    content = content_fields(pr)
    content_hash = sha256_text(canonical_json(content))
    now = datetime.now(UTC)
    pr.content_json = content
    pr.content_hash = content_hash
    pr.status = "registered"
    pr.registered_at = now
    pr.registered_by = user.id
    await audit(
        db, pr.workspace_id, user, "pre_registration.registered", "pre_registration", str(pr.id),
        {"version": pr.version, "content_hash": content_hash,
         "superseded_id": str(existing_active.id) if existing_active is not None else None},
    )
    await db.commit()
    await db.refresh(pr)
    return _out(pr)


# ---------------------------------------------------------------------------
# withdraw
# ---------------------------------------------------------------------------

@router.post("/pre-registrations/{prereg_id}/withdraw", response_model=PreRegistrationOut)
async def withdraw_pre_registration(
    prereg_id: uuid.UUID, body: WithdrawIn,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    pr = await _get_prereg(db, prereg_id, user, "viewer")
    membership = await get_membership(db, pr.workspace_id, user.id)
    is_admin = membership is not None and membership.role in ("admin", "owner")
    is_registrar = pr.registered_by == user.id
    if not (is_admin or is_registrar):
        raise problem(
            403, "insufficient_role",
            "Only an admin or the person who registered it may withdraw a pre-registration.",
        )
    if not body.reason.strip():
        raise problem(422, "reason_required", "A withdrawal reason is required.")

    # Take the project lock before re-reading the status, so this cannot commit
    # inside a concurrent launch's gate window and leave that run pointing at a
    # document that was withdrawn before it started.
    await db.execute(select(Project.id).where(Project.id == pr.project_id).with_for_update())
    await db.refresh(pr, ["status"])
    if pr.status != "registered":
        raise problem(409, "pre_registration_not_registered", "Only a registered pre-registration can be withdrawn.")

    pr.status = "withdrawn"
    pr.withdrawn_at = datetime.now(UTC)
    pr.withdrawn_reason = body.reason.strip()

    project = await db.get(Project, pr.project_id)
    launches_blocked = bool(project is not None and project.pre_registration_required)

    await audit(
        db, pr.workspace_id, user, "pre_registration.withdrawn", "pre_registration", str(pr.id),
        {"version": pr.version, "launches_blocked": launches_blocked},
    )
    await db.commit()
    await db.refresh(pr)
    out = _out(pr)
    if launches_blocked:
        out.launch_impact = (
            "This project requires a pre-registration and now has none active. "
            "New runs will be refused until another pre-registration is registered."
        )
    else:
        out.launch_impact = "This project does not require a pre-registration; launches are unaffected."
    return out


# ---------------------------------------------------------------------------
# project policy switch
# ---------------------------------------------------------------------------

@router.patch("/projects/{project_id}/pre-registration-policy", response_model=PolicyOut)
async def set_pre_registration_policy(
    project_id: uuid.UUID, body: PolicyIn,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    project = await _get_project(db, project_id, user, "admin")
    # Same lock the launch gate takes, so switching the policy on cannot
    # interleave with a launch that already read it as off.
    await db.execute(select(Project.id).where(Project.id == project.id).with_for_update())
    project.pre_registration_required = body.pre_registration_required

    warning: str | None = None
    if body.pre_registration_required:
        active = await active_pre_registration(db, project.id)
        if active is None:
            warning = (
                "Pre-registration is now required, but this project has no active "
                "registered pre-registration. Runs are blocked until one is registered."
            )
    await audit(
        db, project.workspace_id, user, "project.pre_registration_policy_changed", "project", str(project.id),
        {"pre_registration_required": body.pre_registration_required},
    )
    await db.commit()
    return PolicyOut(
        project_id=project.id,
        pre_registration_required=project.pre_registration_required,
        warning=warning,
    )
