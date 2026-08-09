"""Team collaboration: members, invitations, per-member spend caps, audit log.

This module finishes the multi-tenant story that the data model already
supports: a workspace owner may add collaborators, cap what each may draw from
shared (workspace-scoped) provider keys within a UTC calendar month, and read
the workspace audit trail. Personal provider keys are the member's own money and
are never metered against a cap.
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import (
    AuditEvent,
    ProviderConfig,
    Run,
    RunTurn,
    User,
    Workspace,
    WorkspaceInvitation,
    WorkspaceMembership,
)
from ..security import (
    ROLE_ORDER,
    get_current_user,
    get_membership,
    require_workspace_role,
)

router = APIRouter()

# Runs in one of these statuses are done: no further workspace-funded spend can
# accrue, so they hold no reservation against a member's monthly ceiling.
TERMINAL_RUN_STATUSES = ("completed", "failed", "cancelled", "budget_stopped")

MAX_EXPIRY_DAYS = 90
DEFAULT_EXPIRY_DAYS = 14
MAX_AUDIT_PAGE = 100


# --------------------------------------------------------------------------
# local helpers (never import from v1 — circular)
# --------------------------------------------------------------------------

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


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _month_start(now: datetime | None = None) -> datetime:
    ref = now or _now()
    return ref.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


# --------------------------------------------------------------------------
# spend cap — the surface the launch path calls
# --------------------------------------------------------------------------

def visible_provider_scope_clause(user_id: uuid.UUID):
    """Boolean clause selecting the provider keys a given user may use.

    Shared (workspace) keys are usable by every member; personal keys are usable
    only by their owner. Callers still constrain the workspace themselves.
    """
    return or_(
        ProviderConfig.scope == "workspace",
        and_(ProviderConfig.scope == "personal", ProviderConfig.owner_user_id == user_id),
    )


async def workspace_funded_spend_usd(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, period_start: datetime
) -> Decimal:
    """Settled workspace-funded turn cost plus outstanding launch reservations.

    Settled cost counts only run_turns priced against a workspace-scoped
    provider key, for runs this user launched in the period. Reserved cost is,
    for each of this user's non-terminal runs in the period, the part of its
    launch estimate not yet spent, so a member cannot queue ten runs and be
    charged only for the first to settle. Both halves are computed in SQL.

    This is only sound against *simultaneous* launches because
    ``assert_within_spend_cap`` takes a row lock on the membership before
    calling it; on its own this function reads a snapshot that a concurrent
    uncommitted launch is missing from.
    """
    # settled: SUM(run_turns.cost_usd) over workspace-scoped provider keys.
    settled = (
        await db.execute(
            select(func.coalesce(func.sum(RunTurn.cost_usd), 0))
            .select_from(RunTurn)
            .join(Run, Run.id == RunTurn.run_id)
            .join(ProviderConfig, ProviderConfig.id == RunTurn.provider_config_id)
            .where(
                Run.workspace_id == workspace_id,
                Run.created_by == user_id,
                Run.created_at >= period_start,
                ProviderConfig.scope == "workspace",
            )
        )
    ).scalar_one()

    # Per-run settled workspace-funded turn cost, used to compute the unspent
    # remainder of each non-terminal run's reservation.
    per_run_settled = (
        select(
            RunTurn.run_id.label("run_id"),
            func.coalesce(func.sum(RunTurn.cost_usd), 0).label("spent"),
        )
        .select_from(RunTurn)
        .join(ProviderConfig, ProviderConfig.id == RunTurn.provider_config_id)
        .where(ProviderConfig.scope == "workspace")
        .group_by(RunTurn.run_id)
        .subquery()
    )

    remainder = func.greatest(
        Run.workspace_funded_estimate_usd - func.coalesce(per_run_settled.c.spent, 0),
        0,
    )
    reserved = (
        await db.execute(
            select(func.coalesce(func.sum(remainder), 0))
            .select_from(Run)
            .outerjoin(per_run_settled, per_run_settled.c.run_id == Run.id)
            .where(
                Run.workspace_id == workspace_id,
                Run.created_by == user_id,
                Run.created_at >= period_start,
                Run.status.notin_(TERMINAL_RUN_STATUSES),
                Run.status != "draft",
            )
        )
    ).scalar_one()

    return Decimal(settled) + Decimal(reserved)


async def assert_within_spend_cap(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID,
    additional_estimate_usd: Decimal,
) -> None:
    """Raise 402 spend_cap_exceeded if this launch would breach the member cap.

    Uncapped memberships (spend_limit_usd IS NULL — the state of every
    pre-existing membership) return immediately, so this change never starts
    refusing launches that worked yesterday.
    """
    # Lock this member's row FIRST. The reservation arithmetic below reads rows
    # that a concurrent launch has not committed yet, so without this lock two
    # simultaneous launches both see headroom and both proceed. The cap is
    # per-member, so the membership row is exactly the right thing to serialize
    # on: it blocks that member's parallel launches and nobody else's. The
    # caller must not commit between here and inserting the run, or the lock is
    # released before the write it is guarding.
    membership = (
        await db.execute(
            select(WorkspaceMembership)
            .where(
                WorkspaceMembership.workspace_id == workspace_id,
                WorkspaceMembership.user_id == user_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if membership is None or membership.spend_limit_usd is None:
        return
    limit = Decimal(membership.spend_limit_usd)
    current = await workspace_funded_spend_usd(db, workspace_id, user_id, _month_start())
    additional = Decimal(additional_estimate_usd or 0)
    if current + additional > limit:
        raise HTTPException(
            status_code=402,
            detail={
                "code": "spend_cap_exceeded",
                "message": "This launch would exceed your monthly workspace spend limit.",
                "limit_usd": str(limit),
                "current_spend_usd": str(current),
                "attempted_usd": str(additional),
            },
        )


# --------------------------------------------------------------------------
# pydantic models (local to this module by contract)
# --------------------------------------------------------------------------

class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    display_name: str | None
    role: str
    spend_limit_usd: Decimal | None
    current_month_spend_usd: Decimal
    joined_at: datetime | None
    created_at: datetime


class MemberUpdateIn(BaseModel):
    role: str | None = None
    spend_limit_usd: Decimal | None = None
    # Distinguishes "leave spend_limit_usd unchanged" from "set it to null".
    set_spend_limit: bool = False

    @field_validator("role")
    @classmethod
    def _valid_role(cls, v: str | None) -> str | None:
        if v is not None and v not in ROLE_ORDER:
            raise ValueError("unknown role")
        return v

    @field_validator("spend_limit_usd")
    @classmethod
    def _non_negative(cls, v: Decimal | None) -> Decimal | None:
        if v is not None and v < 0:
            raise ValueError("spend_limit_usd must be >= 0")
        return v


class InvitationCreateIn(BaseModel):
    email: str
    role: str
    spend_limit_usd: Decimal | None = None
    expiry_days: int = Field(default=DEFAULT_EXPIRY_DAYS, ge=1, le=MAX_EXPIRY_DAYS)

    @field_validator("email")
    @classmethod
    def _valid_email(cls, v: str) -> str:
        v = (v or "").strip()
        # Deliberately minimal: a full RFC validator is unnecessary here and its
        # optional dependency is not installed in this environment.
        if "@" not in v or v.startswith("@") or v.endswith("@") or " " in v:
            raise ValueError("invalid email address")
        return v

    @field_validator("role")
    @classmethod
    def _role_not_owner(cls, v: str) -> str:
        if v not in ROLE_ORDER:
            raise ValueError("unknown role")
        if v == "owner":
            raise ValueError("cannot invite as owner")
        return v

    @field_validator("spend_limit_usd")
    @classmethod
    def _non_negative(cls, v: Decimal | None) -> Decimal | None:
        if v is not None and v < 0:
            raise ValueError("spend_limit_usd must be >= 0")
        return v


class InvitationOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    email: str
    role: str
    status: str
    spend_limit_usd: Decimal | None
    invited_by: uuid.UUID | None
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class InvitationCreateOut(InvitationOut):
    # The plaintext token is returned exactly once, here, and never persisted.
    token: str


class InvitationPreviewOut(BaseModel):
    workspace_name: str
    role: str
    inviter_display_name: str | None
    expires_at: datetime
    email_matches: bool


class InvitationAcceptIn(BaseModel):
    token: str


class AuditEventOut(BaseModel):
    id: int
    workspace_id: uuid.UUID
    actor_user_id: uuid.UUID | None
    actor_email: str | None
    actor_display_name: str | None
    action: str
    object_type: str
    object_id: str | None
    metadata: dict[str, Any]
    created_at: datetime


class AuditLogOut(BaseModel):
    events: list[AuditEventOut]
    next_offset: int | None


# --------------------------------------------------------------------------
# members
# --------------------------------------------------------------------------

@router.get("/workspaces/{workspace_id}/members", response_model=list[MemberOut])
async def list_members(
    workspace_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await require_workspace_role(db, workspace_id, user, "viewer")
    rows = list(
        (
            await db.execute(
                select(WorkspaceMembership, User)
                .join(User, User.id == WorkspaceMembership.user_id)
                .where(WorkspaceMembership.workspace_id == workspace_id)
                .order_by(User.email)
            )
        ).all()
    )
    period_start = _month_start()
    out: list[MemberOut] = []
    for membership, member in rows:
        spend = await workspace_funded_spend_usd(db, workspace_id, member.id, period_start)
        out.append(MemberOut(
            user_id=member.id,
            email=member.email,
            display_name=member.display_name,
            role=membership.role,
            spend_limit_usd=membership.spend_limit_usd,
            current_month_spend_usd=spend,
            joined_at=membership.accepted_at,
            created_at=membership.created_at,
        ))
    return out


@router.patch("/workspaces/{workspace_id}/members/{member_id}", response_model=MemberOut)
async def update_member(
    workspace_id: uuid.UUID,
    member_id: uuid.UUID,
    body: MemberUpdateIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    actor = await require_workspace_role(db, workspace_id, user, "admin")
    target = await get_membership(db, workspace_id, member_id)
    if target is None:
        raise problem(404, "not_found", "Member not found")

    if body.role is not None and body.role != target.role:
        # Demoting the last owner would leave the workspace ungovernable — this
        # is checked ahead of the self-role rule so the sole owner attempting to
        # step down gets the specific, actionable reason.
        if target.role == "owner" and body.role != "owner":
            owner_count = (
                await db.execute(
                    select(func.count()).select_from(WorkspaceMembership).where(
                        WorkspaceMembership.workspace_id == workspace_id,
                        WorkspaceMembership.role == "owner",
                    )
                )
            ).scalar_one()
            if owner_count <= 1:
                raise problem(409, "last_owner", "A workspace must always retain at least one owner.")
        if member_id == user.id:
            raise problem(422, "self_role_change", "You cannot change your own role.")
        # Only an owner may hand out or take away owner/admin authority.
        touches_privileged = (
            body.role in ("owner", "admin") or target.role in ("owner", "admin")
        )
        if touches_privileged and actor.role != "owner":
            raise problem(403, "owner_required", "Only an owner may change owner or admin roles.")
        target.role = body.role

    if body.set_spend_limit:
        target.spend_limit_usd = body.spend_limit_usd

    await audit(
        db, workspace_id, user, "member.updated", "workspace_membership", str(member_id),
        {"role": target.role, "spend_limit_usd": str(target.spend_limit_usd)
         if target.spend_limit_usd is not None else None},
    )
    await db.commit()

    member = await db.get(User, member_id)
    spend = await workspace_funded_spend_usd(db, workspace_id, member_id, _month_start())
    return MemberOut(
        user_id=member.id, email=member.email, display_name=member.display_name,
        role=target.role, spend_limit_usd=target.spend_limit_usd,
        current_month_spend_usd=spend, joined_at=target.accepted_at,
        created_at=target.created_at,
    )


@router.delete("/workspaces/{workspace_id}/members/{member_id}", status_code=204)
async def remove_member(
    workspace_id: uuid.UUID,
    member_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await require_workspace_role(db, workspace_id, user, "admin")
    if member_id == user.id:
        raise problem(422, "self_removal", "You cannot remove yourself from a workspace.")
    target = await get_membership(db, workspace_id, member_id)
    if target is None:
        raise problem(404, "not_found", "Member not found")
    if target.role == "owner":
        raise problem(403, "cannot_remove_owner", "An owner cannot be removed.")
    await db.delete(target)
    await audit(db, workspace_id, user, "member.removed", "workspace_membership", str(member_id))
    await db.commit()
    return None


# --------------------------------------------------------------------------
# invitations
# --------------------------------------------------------------------------

def _invitation_out(inv: WorkspaceInvitation, *, now: datetime | None = None) -> InvitationOut:
    ref = now or _now()
    status = inv.status
    # A pending row whose deadline has passed is presented as expired even if a
    # sweep has not yet flipped the stored status.
    if status == "pending" and inv.expires_at <= ref:
        status = "expired"
    return InvitationOut(
        id=inv.id, workspace_id=inv.workspace_id, email=inv.email, role=inv.role,
        status=status, spend_limit_usd=inv.spend_limit_usd, invited_by=inv.invited_by,
        expires_at=inv.expires_at, accepted_at=inv.accepted_at, revoked_at=inv.revoked_at,
        created_at=inv.created_at,
    )


@router.post(
    "/workspaces/{workspace_id}/invitations",
    response_model=InvitationCreateOut, status_code=201,
)
async def create_invitation(
    workspace_id: uuid.UUID,
    body: InvitationCreateIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await require_workspace_role(db, workspace_id, user, "admin")
    email = body.email.strip()
    email_lower = email.lower()

    # Reject inviting an existing member.
    existing_member = (
        await db.execute(
            select(WorkspaceMembership)
            .join(User, User.id == WorkspaceMembership.user_id)
            .where(
                WorkspaceMembership.workspace_id == workspace_id,
                func.lower(User.email) == email_lower,
            )
        )
    ).scalar_one_or_none()
    if existing_member is not None:
        raise problem(409, "already_member", "That person is already a member of this workspace.")

    # Revoke any live invitation for this address before issuing a new one; the
    # partial unique index permits only one pending row per (workspace, email).
    #
    # Locked, for the same reason revoke_invitation is: an unlocked read here
    # would let this supersede an invitation that a concurrent acceptance is
    # already committing. The UPDATE would wait for that acceptance and then
    # overwrite it, leaving an invitation marked revoked while the membership it
    # granted stays live. The lock forces the status filter to be evaluated
    # against the acceptance's committed result, so an accepted invitation is
    # simply not in this set.
    pending = (
        await db.execute(
            select(WorkspaceInvitation).where(
                WorkspaceInvitation.workspace_id == workspace_id,
                func.lower(WorkspaceInvitation.email) == email_lower,
                WorkspaceInvitation.status == "pending",
            ).with_for_update()
        )
    ).scalars().all()
    for row in pending:
        row.status = "revoked"
        row.revoked_at = _now()
    if pending:
        await db.flush()

    token = secrets.token_urlsafe(32)
    inv = WorkspaceInvitation(
        workspace_id=workspace_id,
        email=email,
        role=body.role,
        token_hash=_hash_token(token),
        status="pending",
        spend_limit_usd=body.spend_limit_usd,
        invited_by=user.id,
        expires_at=_now() + timedelta(days=body.expiry_days),
    )
    db.add(inv)
    await audit(
        db, workspace_id, user, "invitation.created", "workspace_invitation", None,
        {"email": email, "role": body.role},
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise problem(409, "invitation_conflict", "A live invitation for that address already exists.")
    await db.refresh(inv)
    base = _invitation_out(inv).model_dump()
    return InvitationCreateOut(**base, token=token)


@router.get("/workspaces/{workspace_id}/invitations", response_model=list[InvitationOut])
async def list_invitations(
    workspace_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await require_workspace_role(db, workspace_id, user, "admin")
    rows = (
        await db.execute(
            select(WorkspaceInvitation)
            .where(WorkspaceInvitation.workspace_id == workspace_id)
            .order_by(WorkspaceInvitation.created_at.desc())
        )
    ).scalars().all()
    now = _now()
    return [_invitation_out(inv, now=now) for inv in rows]


@router.delete("/workspaces/{workspace_id}/invitations/{invitation_id}", status_code=204)
async def revoke_invitation(
    workspace_id: uuid.UUID,
    invitation_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await require_workspace_role(db, workspace_id, user, "admin")
    # Locked before the status is read, not merely before it is written. An
    # unlocked read followed by an UPDATE is a lost update: the UPDATE waits for
    # a concurrent acceptance to commit and then overwrites it, because the row
    # still matches on id. The invitation would read "revoked" while the
    # membership it created stays behind — access the workspace believes it
    # withdrew. Taking the lock first forces the status check to see the
    # acceptance and refuse.
    inv = (
        await db.execute(
            select(WorkspaceInvitation)
            .where(WorkspaceInvitation.id == invitation_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if inv is None or inv.workspace_id != workspace_id:
        raise problem(404, "not_found", "Invitation not found")
    if inv.status != "pending":
        raise problem(
            409, "not_pending",
            "Only a pending invitation can be revoked. If it has already been "
            "accepted, remove the member instead.",
        )
    inv.status = "revoked"
    inv.revoked_at = _now()
    await audit(db, workspace_id, user, "invitation.revoked", "workspace_invitation", str(inv.id))
    await db.commit()
    return None


@router.post("/invitations/preview", response_model=InvitationPreviewOut)
async def preview_invitation(
    body: InvitationAcceptIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Inspect an invitation before committing to it.

    A POST, despite being a read: the token is a bearer credential, and a GET
    would put it in the request line, where the web server's access log records
    it verbatim. The body keeps it out of server logs and out of any proxy in
    between.
    """
    token = body.token
    inv = (
        await db.execute(
            select(WorkspaceInvitation).where(
                WorkspaceInvitation.token_hash == _hash_token(token)
            )
        )
    ).scalar_one_or_none()
    # Reveal nothing about a token that does not resolve.
    if inv is None:
        raise problem(404, "not_found", "Invitation not found")
    workspace = await db.get(Workspace, inv.workspace_id)
    inviter = await db.get(User, inv.invited_by) if inv.invited_by else None
    return InvitationPreviewOut(
        workspace_name=workspace.name if workspace else "",
        role=inv.role,
        inviter_display_name=inviter.display_name if inviter else None,
        expires_at=inv.expires_at,
        email_matches=user.email.strip().lower() == inv.email.strip().lower(),
    )


@router.post("/invitations/accept", response_model=MemberOut, status_code=201)
async def accept_invitation(
    body: InvitationAcceptIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Locked on read: status is checked and then written in this transaction,
    # so a concurrent revoke either lands first (and this attempt sees
    # "revoked") or waits and finds the invitation already accepted. Without
    # the lock an accept and a revoke can interleave and resolve as acceptance
    # of a revoked invitation.
    inv = (
        await db.execute(
            select(WorkspaceInvitation)
            .where(WorkspaceInvitation.token_hash == _hash_token(body.token))
            .with_for_update()
        )
    ).scalar_one_or_none()
    if inv is None:
        raise problem(404, "not_found", "Invitation not found")

    # Accepting twice is safe: the second attempt gets a clean 409 and no
    # duplicate membership is created.
    if inv.status != "pending":
        raise problem(409, "not_pending", "This invitation is no longer open.")
    if inv.expires_at <= _now():
        raise problem(409, "expired", "This invitation has expired.")
    # Email binding: the link is only redeemable by the invited address.
    if user.email.strip().lower() != inv.email.strip().lower():
        raise problem(403, "email_mismatch", "This invitation was issued to a different email address.")

    existing = await get_membership(db, inv.workspace_id, user.id)
    if existing is not None:
        # Already a member — close the invitation without a second membership.
        inv.status = "accepted"
        inv.accepted_by = user.id
        inv.accepted_at = _now()
        await db.commit()
        raise problem(409, "already_member", "You are already a member of this workspace.")

    now = _now()
    db.add(WorkspaceMembership(
        workspace_id=inv.workspace_id,
        user_id=user.id,
        role=inv.role,
        invited_by=inv.invited_by,
        invited_at=inv.created_at,
        accepted_at=now,
        spend_limit_usd=inv.spend_limit_usd,
    ))
    inv.status = "accepted"
    inv.accepted_by = user.id
    inv.accepted_at = now
    await audit(
        db, inv.workspace_id, user, "invitation.accepted", "workspace_invitation", str(inv.id),
        {"role": inv.role},
    )
    try:
        await db.commit()
    except IntegrityError:
        # A concurrent accept won the race; treat as a safe double-accept.
        await db.rollback()
        raise problem(409, "already_member", "You are already a member of this workspace.")

    membership = await get_membership(db, inv.workspace_id, user.id)
    spend = await workspace_funded_spend_usd(db, inv.workspace_id, user.id, _month_start())
    return MemberOut(
        user_id=user.id, email=user.email, display_name=user.display_name,
        role=membership.role, spend_limit_usd=membership.spend_limit_usd,
        current_month_spend_usd=spend, joined_at=membership.accepted_at,
        created_at=membership.created_at,
    )


# --------------------------------------------------------------------------
# audit log
# --------------------------------------------------------------------------

@router.get("/workspaces/{workspace_id}/audit-log", response_model=AuditLogOut)
async def read_audit_log(
    workspace_id: uuid.UUID,
    action: str | None = Query(default=None),
    object_type: str | None = Query(default=None),
    actor_user_id: uuid.UUID | None = Query(default=None),
    created_after: datetime | None = Query(default=None),
    created_before: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=MAX_AUDIT_PAGE),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await require_workspace_role(db, workspace_id, user, "admin")

    conditions = [AuditEvent.workspace_id == workspace_id]
    if action is not None:
        conditions.append(AuditEvent.action == action)
    if object_type is not None:
        conditions.append(AuditEvent.object_type == object_type)
    if actor_user_id is not None:
        conditions.append(AuditEvent.actor_user_id == actor_user_id)
    if created_after is not None:
        conditions.append(AuditEvent.created_at >= created_after)
    if created_before is not None:
        conditions.append(AuditEvent.created_at <= created_before)

    # Fetch one extra row to decide whether another page exists.
    rows = list(
        (
            await db.execute(
                select(AuditEvent, User)
                .outerjoin(User, User.id == AuditEvent.actor_user_id)
                .where(*conditions)
                .order_by(AuditEvent.id.desc())
                .offset(offset)
                .limit(limit + 1)
            )
        ).all()
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    events = [
        AuditEventOut(
            id=ev.id, workspace_id=ev.workspace_id, actor_user_id=ev.actor_user_id,
            actor_email=actor.email if actor else None,
            actor_display_name=actor.display_name if actor else None,
            action=ev.action, object_type=ev.object_type, object_id=ev.object_id,
            metadata=ev.metadata_json or {}, created_at=ev.created_at,
        )
        for ev, actor in rows
    ]
    return AuditLogOut(events=events, next_offset=offset + limit if has_more else None)
