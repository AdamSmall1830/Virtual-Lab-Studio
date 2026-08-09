"""Adversarial concurrency tests for the team and pre-registration gates.

Every check in this file is a time-of-check/time-of-use hazard: something is
read, a decision is made, and a write follows. Read-committed isolation means a
second transaction doing the same thing sees neither the first one's uncommitted
write nor its intent, so without an explicit row lock both can pass the check and
both can commit. Money and research-integrity gates cannot be "usually right".

The lock-contention tests here work by holding a transaction open at the point
where the guard takes its lock, then asserting that a conflicting operation
*blocks* rather than sailing past. Blocking is the whole guarantee, so a
deliberate timeout is the assertion — not a flaky wait. Each ends by releasing
the lock and confirming the blocked operation then completes, so a test cannot
pass merely because the second operation was broken.
"""
from __future__ import annotations

import asyncio
import sys
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api.prereg import (  # noqa: E402
    PreRegistrationPatchIn,
    WithdrawIn,
    assert_pre_registration_gate,
    register_pre_registration,
    update_pre_registration,
    withdraw_pre_registration,
)
from app.api.team import (  # noqa: E402
    InvitationAcceptIn,
    InvitationCreateIn,
    accept_invitation,
    assert_within_spend_cap,
    create_invitation,
    revoke_invitation,
    _hash_token,
)
from app.models import (  # noqa: E402
    PreRegistration,
    Project,
    User,
    Workspace,
    WorkspaceInvitation,
    WorkspaceMembership,
)
from app.provenance import canonical_json, content_fields, sha256_text  # noqa: E402

pytestmark = pytest.mark.asyncio

# How long to wait before concluding an operation is genuinely blocked on a lock.
# Long enough that a slow-but-progressing query is not mistaken for a block,
# short enough to keep the suite quick.
BLOCK_TIMEOUT = 3.0

_HEX = lambda: uuid.uuid4().hex[:10]


async def _user(db, email: str | None = None) -> User:
    email = email or f"race-{_HEX()}@example.com"
    u = User(auth_provider="dev", auth_subject=email, email=email, display_name="Race")
    db.add(u)
    await db.flush()
    return u


async def _workspace(db, owner: User, *, spend_limit=None) -> Workspace:
    ws = Workspace(name=f"WS {_HEX()}", slug=f"ws-{_HEX()}", created_by=owner.id)
    db.add(ws)
    await db.flush()
    db.add(WorkspaceMembership(
        workspace_id=ws.id, user_id=owner.id, role="owner", spend_limit_usd=spend_limit,
    ))
    await db.flush()
    return ws


async def _project(db, ws: Workspace, *, requires_prereg: bool = False) -> Project:
    p = Project(
        workspace_id=ws.id, slug=f"p-{_HEX()}", name="Race project",
        pre_registration_required=requires_prereg,
    )
    db.add(p)
    await db.flush()
    return p


async def _registered_prereg(db, ws: Workspace, project: Project, user: User) -> PreRegistration:
    pr = PreRegistration(
        workspace_id=ws.id, project_id=project.id, version=1, status="registered",
        title="H1", hypothesis="h", protocol="p", expected_outcomes="e",
        success_criteria="s", analysis_plan="a",
        registered_at=datetime.now(UTC), registered_by=user.id, created_by=user.id,
    )
    pr.content_json = content_fields(pr)
    pr.content_hash = sha256_text(canonical_json(pr.content_json))
    db.add(pr)
    await db.flush()
    return pr


async def _blocked_until_released(coro, *, release, message):
    """Assert `coro` is blocked, then release the lock and require it to finish.

    A bare timeout is not enough on its own: any stalled or broken operation
    times out, so a test that stops there passes for the wrong reason. Releasing
    the holder and demanding the operation then completes proves the wait was
    lock contention specifically, and hands back the result so the caller can
    assert on the state it produced.
    """
    task = asyncio.create_task(coro)
    done, _ = await asyncio.wait({task}, timeout=BLOCK_TIMEOUT)
    if done:
        task.result()  # surface an exception rather than reporting "did not block"
        raise AssertionError(message)

    await release()
    try:
        return await asyncio.wait_for(task, timeout=BLOCK_TIMEOUT)
    except asyncio.TimeoutError:  # pragma: no cover - defensive
        task.cancel()
        raise AssertionError(
            "operation stayed blocked after the lock was released — it was not "
            "waiting on this lock"
        )


# ---------------------------------------------------------------------------
# spend cap
# ---------------------------------------------------------------------------

async def test_spend_cap_check_serializes_concurrent_launches(sessionmaker):
    """A second launch cannot evaluate the cap while the first is mid-flight.

    Without the membership row lock both launches read the same "spend so far",
    both find headroom for the last of the budget, and both commit a run: the
    member spends twice the cap. The lock is what makes the check mean anything,
    so this asserts the second caller waits rather than proceeding.
    """
    async with sessionmaker() as setup:
        owner = await _user(setup)
        ws = await _workspace(setup, owner, spend_limit=Decimal("100.00"))
        await setup.commit()
        ws_id, owner_id = ws.id, owner.id

    async with sessionmaker() as first, sessionmaker() as second:
        # First launch takes the lock and, like the real launch path, keeps it
        # until it commits its run.
        await assert_within_spend_cap(first, ws_id, owner_id, Decimal("10.00"))

        await _blocked_until_released(
            assert_within_spend_cap(second, ws_id, owner_id, Decimal("10.00")),
            release=first.rollback,
            message="the cap check did not serialize: two launches can spend the same headroom",
        )
        await second.rollback()


async def test_spend_cap_still_refuses_an_over_limit_launch(sessionmaker):
    """The lock must not have turned the refusal itself into a no-op."""
    async with sessionmaker() as db:
        owner = await _user(db)
        ws = await _workspace(db, owner, spend_limit=Decimal("5.00"))
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await assert_within_spend_cap(db, ws.id, owner.id, Decimal("50.00"))
        assert exc.value.status_code == 402
        assert exc.value.detail["code"] == "spend_cap_exceeded"
        await db.rollback()


# ---------------------------------------------------------------------------
# pre-registration gate
# ---------------------------------------------------------------------------

async def test_launch_gate_blocks_a_concurrent_withdrawal(sessionmaker):
    """A withdrawal cannot slip in between the gate's read and the run's insert.

    The gate returns the id and hash of the active document and the caller then
    freezes them onto a run. If a withdrawal commits in that window, the run
    records a pre-registration that was already gone when it started — the run
    would claim a warrant it did not have.
    """
    async with sessionmaker() as setup:
        user = await _user(setup)
        ws = await _workspace(setup, user)
        project = await _project(setup, ws, requires_prereg=True)
        pr = await _registered_prereg(setup, ws, project, user)
        await setup.commit()
        project_id, prereg_id = project.id, pr.id

    async with sessionmaker() as launching, sessionmaker() as withdrawing:
        proj = await launching.get(Project, project_id)
        found_id, found_hash = await assert_pre_registration_gate(launching, proj)
        assert found_id == prereg_id and found_hash

        withdrawer = await withdrawing.get(
            User, (await withdrawing.get(PreRegistration, prereg_id)).created_by
        )
        await _blocked_until_released(
            withdraw_pre_registration(
                prereg_id, WithdrawIn(reason="pulling it out from under the launch"),
                user=withdrawer, db=withdrawing,
            ),
            release=launching.rollback,
            message="withdrawal is not serialized against the launch gate",
        )

    # The withdrawal was only ever delayed, never lost.
    async with sessionmaker() as check:
        assert (await check.get(PreRegistration, prereg_id)).status == "withdrawn"


async def test_gate_refuses_when_the_project_requires_and_has_none(sessionmaker):
    """The lock must not have swallowed the refusal."""
    async with sessionmaker() as db:
        user = await _user(db)
        ws = await _workspace(db, user)
        project = await _project(db, ws, requires_prereg=True)
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await assert_pre_registration_gate(db, project)
        assert exc.value.status_code == 409
        assert exc.value.detail["code"] == "pre_registration_required"
        await db.rollback()


async def test_gate_reads_the_policy_under_the_lock_not_from_a_stale_object(sessionmaker):
    """A project loaded before the policy changed must not launch on stale state.

    The launch path may hold a Project object read earlier in the request. The
    gate refreshes the flag after taking the lock precisely so a policy switched
    on in the meantime is honoured.
    """
    async with sessionmaker() as setup:
        user = await _user(setup)
        ws = await _workspace(setup, user)
        project = await _project(setup, ws, requires_prereg=False)
        await setup.commit()
        project_id = project.id

    async with sessionmaker() as launching:
        stale = await launching.get(Project, project_id)
        assert stale.pre_registration_required is False

        # Someone turns the requirement on and commits before the launch reaches
        # the gate.
        async with sessionmaker() as admin:
            other = await admin.get(Project, project_id)
            other.pre_registration_required = True
            await admin.commit()

        with pytest.raises(HTTPException) as exc:
            await assert_pre_registration_gate(launching, stale)
        assert exc.value.detail["code"] == "pre_registration_required"
        await launching.rollback()


# ---------------------------------------------------------------------------
# invitation accept vs revoke
# ---------------------------------------------------------------------------

async def test_accept_and_revoke_cannot_both_win(sessionmaker):
    """Whichever lands first, the outcome must be self-consistent.

    The forbidden end state is a revoked invitation that nevertheless produced a
    membership: the workspace believes it withdrew access while the invitee
    holds it.
    """
    async with sessionmaker() as setup:
        owner = await _user(setup)
        ws = await _workspace(setup, owner)
        invited_email = f"invitee-{_HEX()}@example.com"
        invitee = await _user(setup, email=invited_email)
        token = uuid.uuid4().hex
        inv = WorkspaceInvitation(
            workspace_id=ws.id, email=invited_email, role="viewer",
            token_hash=_hash_token(token), invited_by=owner.id,
            expires_at=datetime.now(UTC) + timedelta(days=7), status="pending",
        )
        setup.add(inv)
        await setup.commit()
        ws_id, inv_id, invitee_id, owner_id = ws.id, inv.id, invitee.id, owner.id

    async def _accept():
        async with sessionmaker() as db:
            try:
                await accept_invitation(
                    InvitationAcceptIn(token=token), user=await db.get(User, invitee_id), db=db
                )
                return "accepted"
            except HTTPException as e:
                return f"rejected:{e.status_code}"

    async def _revoke():
        async with sessionmaker() as db:
            try:
                await revoke_invitation(
                    ws_id, inv_id, user=await db.get(User, owner_id), db=db
                )
                return "revoked"
            except HTTPException as e:
                return f"rejected:{e.status_code}"

    await asyncio.gather(_accept(), _revoke())

    async with sessionmaker() as check:
        final = await check.get(WorkspaceInvitation, inv_id)
        membership = (
            await check.execute(
                select(WorkspaceMembership).where(
                    WorkspaceMembership.workspace_id == ws_id,
                    WorkspaceMembership.user_id == invitee_id,
                )
            )
        ).scalar_one_or_none()

        if membership is not None:
            assert final.status == "accepted", (
                f"membership was granted but the invitation is {final.status!r}: "
                "a revoked invitation still let someone in"
            )
        else:
            assert final.status in ("revoked", "pending"), final.status


async def test_revoke_waits_for_an_in_flight_acceptance(sessionmaker):
    """Revoke must contend on the row an acceptance has locked, not skip past it."""
    async with sessionmaker() as setup:
        owner = await _user(setup)
        ws = await _workspace(setup, owner)
        invited_email = f"invitee-{_HEX()}@example.com"
        token = uuid.uuid4().hex
        inv = WorkspaceInvitation(
            workspace_id=ws.id, email=invited_email, role="viewer",
            token_hash=_hash_token(token), invited_by=owner.id,
            expires_at=datetime.now(UTC) + timedelta(days=7), status="pending",
        )
        setup.add(inv)
        await setup.commit()
        ws_id, inv_id, owner_id = ws.id, inv.id, owner.id

    async with sessionmaker() as accepting, sessionmaker() as revoking:
        # Exactly the lock accept_invitation takes as its first act.
        await accepting.execute(
            select(WorkspaceInvitation)
            .where(WorkspaceInvitation.id == inv_id)
            .with_for_update()
        )

        await _blocked_until_released(
            revoke_invitation(ws_id, inv_id, user=await revoking.get(User, owner_id), db=revoking),
            release=accepting.rollback,
            message="revoke did not contend with an in-flight acceptance",
        )

    async with sessionmaker() as check:
        assert (await check.get(WorkspaceInvitation, inv_id)).status == "revoked"


async def test_a_replacement_invitation_cannot_revoke_one_just_accepted(sessionmaker):
    """Issuing a fresh invitation supersedes pending ones — but not accepted ones.

    Only one pending invitation per address may exist, so creating one revokes
    any live predecessor. Read without a lock, that supersede-sweep is the same
    lost update as revoke: it can overwrite an acceptance that committed while it
    was deciding, leaving a revoked invitation whose membership is live.
    """
    async with sessionmaker() as setup:
        owner = await _user(setup)
        ws = await _workspace(setup, owner)
        invited_email = f"invitee-{_HEX()}@example.com"
        invitee = await _user(setup, email=invited_email)
        token = uuid.uuid4().hex
        setup.add(WorkspaceInvitation(
            workspace_id=ws.id, email=invited_email, role="viewer",
            token_hash=_hash_token(token), invited_by=owner.id,
            expires_at=datetime.now(UTC) + timedelta(days=7), status="pending",
        ))
        await setup.commit()
        ws_id, invitee_id, owner_id = ws.id, invitee.id, owner.id

    async def _accept():
        async with sessionmaker() as db:
            try:
                await accept_invitation(
                    InvitationAcceptIn(token=token), user=await db.get(User, invitee_id), db=db
                )
            except HTTPException:
                pass

    async def _reinvite():
        async with sessionmaker() as db:
            try:
                await create_invitation(
                    ws_id,
                    InvitationCreateIn(email=invited_email, role="reviewer"),
                    user=await db.get(User, owner_id), db=db,
                )
            except HTTPException:
                pass

    await asyncio.gather(_accept(), _reinvite())

    async with sessionmaker() as check:
        membership = (
            await check.execute(
                select(WorkspaceMembership).where(
                    WorkspaceMembership.workspace_id == ws_id,
                    WorkspaceMembership.user_id == invitee_id,
                )
            )
        ).scalar_one_or_none()
        accepted = (
            await check.execute(
                select(WorkspaceInvitation).where(
                    WorkspaceInvitation.workspace_id == ws_id,
                    WorkspaceInvitation.status == "accepted",
                )
            )
        ).scalars().all()

        if membership is not None:
            assert accepted, (
                "a membership exists but no invitation records the acceptance: "
                "the replacement invitation overwrote it"
            )


async def test_a_draft_edit_cannot_land_on_a_document_just_registered(sessionmaker):
    """Editing a draft must lose to a concurrent registration, not follow it.

    Registration hashes the document and freezes it. An edit that commits after
    that hash is computed would leave a registered pre-registration whose stored
    hash no longer describes its own text — the one thing the whole feature
    exists to make impossible.
    """
    async with sessionmaker() as setup:
        user = await _user(setup)
        ws = await _workspace(setup, user)
        project = await _project(setup, ws)
        draft = PreRegistration(
            workspace_id=ws.id, project_id=project.id, version=1, status="draft",
            title="Original", hypothesis="original hypothesis", protocol="original protocol",
            expected_outcomes="original outcomes", success_criteria="s", analysis_plan="a",
            created_by=user.id,
        )
        setup.add(draft)
        await setup.commit()
        prereg_id, user_id = draft.id, user.id

    async def _register():
        async with sessionmaker() as db:
            try:
                await register_pre_registration(
                    prereg_id, user=await db.get(User, user_id), db=db
                )
            except HTTPException:
                pass

    async def _edit():
        async with sessionmaker() as db:
            try:
                await update_pre_registration(
                    prereg_id,
                    PreRegistrationPatchIn(hypothesis="SNEAKED IN AFTER THE FREEZE"),
                    user=await db.get(User, user_id), db=db,
                )
            except HTTPException:
                pass

    await asyncio.gather(_register(), _edit())

    async with sessionmaker() as check:
        pr = await check.get(PreRegistration, prereg_id)
        if pr.status == "registered":
            recomputed = sha256_text(canonical_json(content_fields(pr)))
            assert recomputed == pr.content_hash, (
                "a registered pre-registration no longer matches its own frozen hash: "
                "an edit landed after the freeze"
            )
            assert "SNEAKED IN" not in pr.hypothesis
