"""Pre-registration: freeze immutability, supersede/amendment, hashing,
the launch gate, and withdraw."""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api.prereg import (  # noqa: E402
    PolicyIn,
    PreRegistrationCreateIn,
    PreRegistrationPatchIn,
    WithdrawIn,
    active_pre_registration,
    assert_pre_registration_gate,
    create_pre_registration,
    list_pre_registrations,
    register_pre_registration,
    set_pre_registration_policy,
    update_pre_registration,
    withdraw_pre_registration,
)
from app.models import PreRegistration, Project, User, Workspace, WorkspaceMembership  # noqa: E402


async def _fresh_workspace_and_user(db, role: str = "researcher") -> tuple[Workspace, User]:
    uniq = uuid.uuid4().hex[:12]
    ws = Workspace(name=f"WS {uniq}", slug=f"ws-{uniq}")
    db.add(ws)
    await db.flush()
    email = f"{role}-{uniq}@example.com"
    user = User(auth_provider="dev", auth_subject=email, email=email, display_name=role)
    db.add(user)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=ws.id, user_id=user.id, role=role))
    await db.commit()
    return ws, user


async def _project(db, ws: Workspace, user: User) -> Project:
    uniq = uuid.uuid4().hex[:8]
    p = Project(workspace_id=ws.id, slug=f"proj-{uniq}", name=f"Project {uniq}", created_by=user.id)
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return p


def _valid_body(**over) -> PreRegistrationCreateIn:
    data = dict(
        title="H1",
        hypothesis="LNPs outperform AAVs for hepatic delivery.",
        protocol="Run team meeting with 3 rounds, compare outputs.",
        expected_outcomes="LNP delivery scores higher on stated criteria.",
        success_criteria="Score delta > 0.2",
        analysis_plan="Compare structured summaries.",
    )
    data.update(over)
    return PreRegistrationCreateIn(**data)


@pytest.mark.asyncio
async def test_registered_document_cannot_be_edited(sessionmaker):
    async with sessionmaker() as db:
        ws, user = await _fresh_workspace_and_user(db)
        p = await _project(db, ws, user)
        draft = await create_pre_registration(p.id, _valid_body(), user=user, db=db)
        reg = await register_pre_registration(draft.id, user=user, db=db)
        assert reg.status == "registered"
        assert reg.content_hash is not None

        with pytest.raises(HTTPException) as exc:
            await update_pre_registration(
                reg.id, PreRegistrationPatchIn(hypothesis="changed"), user=user, db=db
            )
        assert exc.value.status_code == 409
        assert exc.value.detail["code"] == "pre_registration_frozen"

    # Confirm nothing changed on disk.
    async with sessionmaker() as db2:
        stored = (await db2.execute(select(PreRegistration).where(PreRegistration.id == reg.id))).scalar_one()
        assert stored.hypothesis == "LNPs outperform AAVs for hepatic delivery."


@pytest.mark.asyncio
async def test_register_rejected_when_other_active_without_matching_supersedes(sessionmaker):
    async with sessionmaker() as db:
        ws, user = await _fresh_workspace_and_user(db)
        p = await _project(db, ws, user)
        d1 = await create_pre_registration(p.id, _valid_body(title="A"), user=user, db=db)
        await register_pre_registration(d1.id, user=user, db=db)

        # A second draft that does NOT supersede the active one.
        d2 = await create_pre_registration(p.id, _valid_body(title="B"), user=user, db=db)
        with pytest.raises(HTTPException) as exc:
            await register_pre_registration(d2.id, user=user, db=db)
        assert exc.value.status_code == 409
        assert exc.value.detail["code"] == "pre_registration_conflict"


@pytest.mark.asyncio
async def test_correct_amendment_supersedes_and_one_active_remains(sessionmaker):
    async with sessionmaker() as db:
        ws, user = await _fresh_workspace_and_user(db)
        p = await _project(db, ws, user)
        d1 = await create_pre_registration(p.id, _valid_body(title="A"), user=user, db=db)
        r1 = await register_pre_registration(d1.id, user=user, db=db)

        d2 = await create_pre_registration(
            p.id, _valid_body(title="B", supersedes_id=r1.id, amendment_reason="revised protocol"),
            user=user, db=db,
        )
        r2 = await register_pre_registration(d2.id, user=user, db=db)
        assert r2.status == "registered"

    async with sessionmaker() as db2:
        actives = list(
            (
                await db2.execute(
                    select(PreRegistration).where(
                        PreRegistration.project_id == p.id,
                        PreRegistration.status == "registered",
                    )
                )
            ).scalars()
        )
        assert len(actives) == 1
        assert actives[0].id == r2.id
        old = (await db2.execute(select(PreRegistration).where(PreRegistration.id == r1.id))).scalar_one()
        assert old.status == "superseded"


@pytest.mark.asyncio
async def test_amendment_requires_reason(sessionmaker):
    async with sessionmaker() as db:
        ws, user = await _fresh_workspace_and_user(db)
        p = await _project(db, ws, user)
        d1 = await create_pre_registration(p.id, _valid_body(), user=user, db=db)
        r1 = await register_pre_registration(d1.id, user=user, db=db)
        with pytest.raises(HTTPException) as exc:
            await create_pre_registration(
                p.id, _valid_body(supersedes_id=r1.id, amendment_reason="   "), user=user, db=db
            )
        assert exc.value.status_code == 422
        assert exc.value.detail["code"] == "amendment_reason_required"


@pytest.mark.asyncio
async def test_register_rejects_incomplete(sessionmaker):
    async with sessionmaker() as db:
        ws, user = await _fresh_workspace_and_user(db)
        p = await _project(db, ws, user)
        d = await create_pre_registration(
            p.id, _valid_body(hypothesis="   "), user=user, db=db
        )
        with pytest.raises(HTTPException) as exc:
            await register_pre_registration(d.id, user=user, db=db)
        assert exc.value.status_code == 422
        assert exc.value.detail["code"] == "incomplete_pre_registration"


@pytest.mark.asyncio
async def test_same_content_hashes_identically(sessionmaker):
    async with sessionmaker() as db:
        ws, user = await _fresh_workspace_and_user(db)
        p1 = await _project(db, ws, user)
        p2 = await _project(db, ws, user)
        d1 = await create_pre_registration(p1.id, _valid_body(), user=user, db=db)
        r1 = await register_pre_registration(d1.id, user=user, db=db)
        d2 = await create_pre_registration(p2.id, _valid_body(), user=user, db=db)
        r2 = await register_pre_registration(d2.id, user=user, db=db)
        assert r1.content_hash == r2.content_hash
        assert len(r1.content_hash) == 64


@pytest.mark.asyncio
async def test_gate_not_required(sessionmaker):
    async with sessionmaker() as db:
        ws, user = await _fresh_workspace_and_user(db)
        p = await _project(db, ws, user)
        assert p.pre_registration_required is False
        assert await assert_pre_registration_gate(db, p) == (None, None)


@pytest.mark.asyncio
async def test_gate_blocks_when_required_and_none_active(sessionmaker):
    async with sessionmaker() as db:
        ws, user = await _fresh_workspace_and_user(db, role="admin")
        p = await _project(db, ws, user)
        out = await set_pre_registration_policy(
            p.id, PolicyIn(pre_registration_required=True), user=user, db=db
        )
        assert out.pre_registration_required is True
        assert out.warning is not None
        await db.refresh(p)
        with pytest.raises(HTTPException) as exc:
            await assert_pre_registration_gate(db, p)
        assert exc.value.status_code == 409
        assert exc.value.detail["code"] == "pre_registration_required"


@pytest.mark.asyncio
async def test_gate_returns_id_and_hash_when_present(sessionmaker):
    async with sessionmaker() as db:
        ws, user = await _fresh_workspace_and_user(db, role="admin")
        p = await _project(db, ws, user)
        d = await create_pre_registration(p.id, _valid_body(), user=user, db=db)
        r = await register_pre_registration(d.id, user=user, db=db)
        await set_pre_registration_policy(
            p.id, PolicyIn(pre_registration_required=True), user=user, db=db
        )
        await db.refresh(p)
        pr_id, pr_hash = await assert_pre_registration_gate(db, p)
        assert pr_id == r.id
        assert pr_hash == r.content_hash


@pytest.mark.asyncio
async def test_withdraw_leaves_no_active(sessionmaker):
    async with sessionmaker() as db:
        ws, user = await _fresh_workspace_and_user(db, role="admin")
        p = await _project(db, ws, user)
        d = await create_pre_registration(p.id, _valid_body(), user=user, db=db)
        r = await register_pre_registration(d.id, user=user, db=db)
        assert await active_pre_registration(db, p.id) is not None

        out = await withdraw_pre_registration(r.id, WithdrawIn(reason="protocol invalidated"), user=user, db=db)
        assert out.status == "withdrawn"
        assert out.withdrawn_reason == "protocol invalidated"
        assert await active_pre_registration(db, p.id) is None


@pytest.mark.asyncio
async def test_list_newest_first_and_no_body(sessionmaker):
    async with sessionmaker() as db:
        ws, user = await _fresh_workspace_and_user(db)
        p = await _project(db, ws, user)
        await create_pre_registration(p.id, _valid_body(title="v1"), user=user, db=db)
        await create_pre_registration(p.id, _valid_body(title="v2"), user=user, db=db)
        items = await list_pre_registrations(p.id, user=user, db=db)
        assert [i.version for i in items] == sorted([i.version for i in items], reverse=True)
        # list items carry no body field
        assert not hasattr(items[0], "hypothesis")
