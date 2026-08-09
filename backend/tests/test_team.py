"""Team collaboration: members, invitations, spend caps, audit log.

Every fixture creates its own workspace/user with unique identifiers so the
suite is safe against a live shared dev database and a parallel test run.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api.team import (  # noqa: E402
    InvitationAcceptIn,
    InvitationCreateIn,
    MemberUpdateIn,
    accept_invitation,
    assert_within_spend_cap,
    create_invitation,
    list_members,
    preview_invitation,
    read_audit_log,
    remove_member,
    update_member,
    workspace_funded_spend_usd,
)
from app.engine import canonical_json, sha256_text  # noqa: E402
from app.models import (  # noqa: E402
    AgentProfile,
    AgentVersion,
    MeetingDefinition,
    MeetingDefinitionAgent,
    ProviderConfig,
    ProviderModel,
    Project,
    Run,
    RunTurn,
    User,
    Workspace,
    WorkspaceInvitation,
    WorkspaceMembership,
)

pytestmark = pytest.mark.asyncio

_HEX = lambda: uuid.uuid4().hex[:10]


async def _mk_user(db, *, email: str | None = None) -> User:
    email = email or f"u-{_HEX()}@example.com"
    user = User(auth_provider="dev", auth_subject=email, email=email, display_name=email.split("@")[0])
    db.add(user)
    await db.flush()
    return user


async def _mk_workspace(db, owner: User) -> Workspace:
    ws = Workspace(name=f"WS {_HEX()}", slug=f"ws-{_HEX()}", created_by=owner.id)
    db.add(ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=ws.id, user_id=owner.id, role="owner"))
    await db.flush()
    return ws


async def _add_member(db, ws: Workspace, user: User, role: str, spend_limit=None):
    db.add(WorkspaceMembership(
        workspace_id=ws.id, user_id=user.id, role=role, spend_limit_usd=spend_limit,
    ))
    await db.flush()


async def _mk_project(db, ws: Workspace) -> Project:
    p = Project(workspace_id=ws.id, slug=f"p-{_HEX()}", name="Spend project")
    db.add(p)
    await db.flush()
    return p


async def _mk_agent_version(db) -> AgentVersion:
    profile = AgentProfile(workspace_id=None, slug=f"a-{_HEX()}", title="Agent")
    db.add(profile)
    await db.flush()
    av = AgentVersion(
        agent_profile_id=profile.id, version_number=1, expertise="x", goal="y", role="z",
        system_prompt="hello", system_prompt_sha256=sha256_text("hello"),
    )
    db.add(av)
    await db.flush()
    return av


async def _mk_provider(db, ws: Workspace, scope: str, owner: User | None = None) -> tuple[ProviderConfig, ProviderModel]:
    pc = ProviderConfig(
        workspace_id=ws.id, name=f"prov-{_HEX()}", provider_type="demo",
        scope=scope, owner_user_id=owner.id if owner else None,
    )
    db.add(pc)
    await db.flush()
    pm = ProviderModel(provider_config_id=pc.id, model_key="demo-1", display_name="Demo")
    db.add(pm)
    await db.flush()
    return pc, pm


async def _mk_definition(db, ws: Workspace, project: Project, av: AgentVersion,
                         pc: ProviderConfig, pm: ProviderModel) -> MeetingDefinition:
    dj = {"t": str(uuid.uuid4())}
    d = MeetingDefinition(
        workspace_id=ws.id, project_id=project.id, title="Def", meeting_type="team",
        agenda="A", questions=["Q"], rules=[], contexts=[], rounds=1, default_temperature=Decimal("0.2"),
        budget={"max_cost_usd": 100}, definition_json=dj, definition_sha256=sha256_text(canonical_json(dj)),
    )
    db.add(d)
    await db.flush()
    db.add(MeetingDefinitionAgent(
        meeting_definition_id=d.id, position=0, role_type="lead",
        agent_version_id=av.id, provider_config_id=pc.id, provider_model_id=pm.id,
    ))
    await db.flush()
    return d


async def _mk_run(db, ws, project, definition, user, *, status, estimate="0") -> Run:
    run = Run(
        workspace_id=ws.id, project_id=project.id, meeting_definition_id=definition.id,
        status=status, created_by=user.id, workspace_funded_estimate_usd=Decimal(estimate),
    )
    db.add(run)
    await db.flush()
    return run


async def _mk_turn(db, ws, run, av, pc, pm, *, cost):
    turn = RunTurn(
        workspace_id=ws.id, run_id=run.id, sequence=1, round_number=1, position_in_round=0,
        agent_version_id=av.id, role_type="lead", status="completed",
        provider_config_id=pc.id, provider_model_id=pm.id,
        system_prompt_sha256=sha256_text("hello"), cost_usd=Decimal(cost),
    )
    db.add(turn)
    await db.flush()
    return turn


# ---------------------------------------------------------------------------
# members
# ---------------------------------------------------------------------------

async def test_last_owner_demotion_rejected(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        await db.commit()
        # The sole owner cannot be demoted, even by an owner action.
        with pytest.raises(HTTPException) as exc:
            await update_member(
                ws.id, owner.id, MemberUpdateIn(role="admin"), user=owner, db=db,
            )
        assert exc.value.status_code == 409
        assert exc.value.detail["code"] == "last_owner"


async def test_demoting_one_of_two_owners_succeeds(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        second = await _mk_user(db)
        await _add_member(db, ws, second, "owner")
        await db.commit()
        out = await update_member(ws.id, second.id, MemberUpdateIn(role="admin"), user=owner, db=db)
        assert out.role == "admin"


async def test_self_role_change_rejected(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        admin = await _mk_user(db)
        await _add_member(db, ws, admin, "admin")
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await update_member(ws.id, admin.id, MemberUpdateIn(role="researcher"), user=admin, db=db)
        assert exc.value.detail["code"] == "self_role_change"


async def test_non_owner_admin_cannot_grant_admin(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        admin = await _mk_user(db)
        researcher = await _mk_user(db)
        await _add_member(db, ws, admin, "admin")
        await _add_member(db, ws, researcher, "researcher")
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await update_member(ws.id, researcher.id, MemberUpdateIn(role="admin"), user=admin, db=db)
        assert exc.value.status_code == 403
        assert exc.value.detail["code"] == "owner_required"


async def test_cannot_remove_owner_or_self(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        admin = await _mk_user(db)
        await _add_member(db, ws, admin, "admin")
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await remove_member(ws.id, admin.id, user=admin, db=db)
        assert exc.value.detail["code"] == "self_removal"
        with pytest.raises(HTTPException) as exc2:
            await remove_member(ws.id, owner.id, user=admin, db=db)
        assert exc2.value.detail["code"] == "cannot_remove_owner"


async def test_update_spend_limit_and_list_members(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        member = await _mk_user(db)
        await _add_member(db, ws, member, "researcher")
        await db.commit()
        out = await update_member(
            ws.id, member.id,
            MemberUpdateIn(spend_limit_usd=Decimal("25"), set_spend_limit=True),
            user=owner, db=db,
        )
        assert out.spend_limit_usd == Decimal("25")
        members = await list_members(ws.id, user=owner, db=db)
        assert any(m.user_id == member.id and m.spend_limit_usd == Decimal("25") for m in members)


# ---------------------------------------------------------------------------
# invitations
# ---------------------------------------------------------------------------

async def test_invitation_email_mismatch_rejected(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        await db.commit()
        invited_email = f"invitee-{_HEX()}@example.com"
        created = await create_invitation(
            ws.id, InvitationCreateIn(email=invited_email, role="researcher"),
            user=owner, db=db,
        )
        wrong = await _mk_user(db)
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await accept_invitation(InvitationAcceptIn(token=created.token), user=wrong, db=db)
        assert exc.value.status_code == 403
        assert exc.value.detail["code"] == "email_mismatch"


async def test_invitation_expired_rejected(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        await db.commit()
        invited_email = f"invitee-{_HEX()}@example.com"
        created = await create_invitation(
            ws.id, InvitationCreateIn(email=invited_email, role="researcher"),
            user=owner, db=db,
        )
        # Force the stored row to be past its deadline.
        inv = await db.get(WorkspaceInvitation, created.id)
        inv.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
        await db.commit()
        invitee = await _mk_user(db, email=invited_email)
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await accept_invitation(InvitationAcceptIn(token=created.token), user=invitee, db=db)
        assert exc.value.status_code == 409
        assert exc.value.detail["code"] == "expired"


async def test_invitation_double_accept_is_safe(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        await db.commit()
        invited_email = f"invitee-{_HEX()}@example.com"
        created = await create_invitation(
            ws.id, InvitationCreateIn(email=invited_email, role="reviewer", spend_limit_usd=Decimal("10")),
            user=owner, db=db,
        )
        invitee = await _mk_user(db, email=invited_email)
        await db.commit()

        first = await accept_invitation(InvitationAcceptIn(token=created.token), user=invitee, db=db)
        assert first.role == "reviewer"
        assert first.spend_limit_usd == Decimal("10")

        with pytest.raises(HTTPException) as exc:
            await accept_invitation(InvitationAcceptIn(token=created.token), user=invitee, db=db)
        assert exc.value.status_code == 409

        # Exactly one membership exists.
        count = len((
            await db.execute(
                select(WorkspaceMembership).where(
                    WorkspaceMembership.workspace_id == ws.id,
                    WorkspaceMembership.user_id == invitee.id,
                )
            )
        ).scalars().all())
        assert count == 1


async def test_reinvite_revokes_prior_pending(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        await db.commit()
        email = f"invitee-{_HEX()}@example.com"
        first = await create_invitation(ws.id, InvitationCreateIn(email=email, role="viewer"), user=owner, db=db)
        second = await create_invitation(ws.id, InvitationCreateIn(email=email, role="researcher"), user=owner, db=db)
        first_row = await db.get(WorkspaceInvitation, first.id)
        second_row = await db.get(WorkspaceInvitation, second.id)
        assert first_row.status == "revoked"
        assert second_row.status == "pending"


async def test_preview_unknown_token_is_404(sessionmaker):
    async with sessionmaker() as db:
        stranger = await _mk_user(db)
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await preview_invitation(InvitationAcceptIn(token="not-a-real-token"), user=stranger, db=db)
        assert exc.value.status_code == 404


async def test_preview_reports_email_match(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        await db.commit()
        email = f"invitee-{_HEX()}@example.com"
        created = await create_invitation(ws.id, InvitationCreateIn(email=email, role="viewer"), user=owner, db=db)
        invitee = await _mk_user(db, email=email)
        await db.commit()
        preview = await preview_invitation(InvitationAcceptIn(token=created.token), user=invitee, db=db)
        assert preview.email_matches is True
        assert preview.role == "viewer"
        assert preview.workspace_name == ws.name


# ---------------------------------------------------------------------------
# spend cap
# ---------------------------------------------------------------------------

async def test_personal_scope_cost_not_counted(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        member = await _mk_user(db)
        await _add_member(db, ws, member, "researcher", spend_limit=Decimal("5"))
        project = await _mk_project(db, ws)
        av = await _mk_agent_version(db)
        personal_pc, personal_pm = await _mk_provider(db, ws, "personal", owner=member)
        definition = await _mk_definition(db, ws, project, av, personal_pc, personal_pm)
        # A completed run entirely on the member's personal key.
        run = await _mk_run(db, ws, project, definition, member, status="completed", estimate="0")
        await _mk_turn(db, ws, run, av, personal_pc, personal_pm, cost="100")
        await db.commit()

        month = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        spend = await workspace_funded_spend_usd(db, ws.id, member.id, month)
        assert spend == Decimal("0")
        # And the cap must not fire despite a huge personal spend.
        await assert_within_spend_cap(db, ws.id, member.id, Decimal("1"))


async def test_nonterminal_run_reserves_unspent_estimate(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        member = await _mk_user(db)
        await _add_member(db, ws, member, "researcher", spend_limit=Decimal("50"))
        project = await _mk_project(db, ws)
        av = await _mk_agent_version(db)
        pc, pm = await _mk_provider(db, ws, "workspace")
        definition = await _mk_definition(db, ws, project, av, pc, pm)
        # Non-terminal run: estimate 40, already spent 10 -> reserves 30.
        run = await _mk_run(db, ws, project, definition, member, status="running", estimate="40")
        await _mk_turn(db, ws, run, av, pc, pm, cost="10")
        await db.commit()

        month = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        spend = await workspace_funded_spend_usd(db, ws.id, member.id, month)
        # settled 10 + reserved 30 = 40.
        assert spend == Decimal("40")

        # Under cap by exactly the reservation slack; another 10 keeps it at 50.
        await assert_within_spend_cap(db, ws.id, member.id, Decimal("10"))
        # One more dollar over 50 must be refused.
        with pytest.raises(HTTPException) as exc:
            await assert_within_spend_cap(db, ws.id, member.id, Decimal("10.01"))
        assert exc.value.status_code == 402
        assert exc.value.detail["code"] == "spend_cap_exceeded"


async def test_terminal_run_holds_no_reservation(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        member = await _mk_user(db)
        await _add_member(db, ws, member, "researcher", spend_limit=Decimal("50"))
        project = await _mk_project(db, ws)
        av = await _mk_agent_version(db)
        pc, pm = await _mk_provider(db, ws, "workspace")
        definition = await _mk_definition(db, ws, project, av, pc, pm)
        # Completed run: estimate 40 but only settled cost (5) is counted.
        run = await _mk_run(db, ws, project, definition, member, status="completed", estimate="40")
        await _mk_turn(db, ws, run, av, pc, pm, cost="5")
        await db.commit()

        month = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        spend = await workspace_funded_spend_usd(db, ws.id, member.id, month)
        assert spend == Decimal("5")


async def test_uncapped_membership_never_refuses(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        member = await _mk_user(db)
        await _add_member(db, ws, member, "researcher", spend_limit=None)
        await db.commit()
        # Even a huge additional estimate is allowed when uncapped.
        await assert_within_spend_cap(db, ws.id, member.id, Decimal("1000000"))


# ---------------------------------------------------------------------------
# audit log
# ---------------------------------------------------------------------------

async def test_audit_log_reads_recent_events(sessionmaker):
    async with sessionmaker() as db:
        owner = await _mk_user(db)
        ws = await _mk_workspace(db, owner)
        await db.commit()
        email = f"invitee-{_HEX()}@example.com"
        await create_invitation(ws.id, InvitationCreateIn(email=email, role="viewer"), user=owner, db=db)

        log = await read_audit_log(
            ws.id, action=None, object_type=None, actor_user_id=None,
            created_after=None, created_before=None, limit=50, offset=0,
            user=owner, db=db,
        )
        actions = {e.action for e in log.events}
        assert "invitation.created" in actions
        # Newest first and actor joined for display.
        created_ev = next(e for e in log.events if e.action == "invitation.created")
        assert created_ev.actor_email == owner.email
