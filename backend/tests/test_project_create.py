"""Project creation: role enforcement, slug uniqueness, persistence."""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api.v1 import create_project  # noqa: E402
from app.models import Project, User, Workspace, WorkspaceMembership  # noqa: E402
from app.schemas import ProjectCreateIn  # noqa: E402
from app.seed import seed  # noqa: E402


async def _seeded_workspace(db):
    await seed(db)
    return (await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))).scalar_one()


async def _user_with_role(db, workspace_id, role: str) -> User:
    email = f"{role}-{uuid.uuid4().hex[:8]}@example.com"
    user = User(auth_provider="dev", auth_subject=email, email=email, display_name=f"{role} user")
    db.add(user)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=workspace_id, user_id=user.id, role=role))
    await db.commit()
    return user


@pytest.mark.asyncio
async def test_researcher_can_create_project_and_it_persists(sessionmaker):
    async with sessionmaker() as db:
        workspace = await _seeded_workspace(db)
        user = await _user_with_role(db, workspace.id, "researcher")

        unique = uuid.uuid4().hex[:8]
        name = f"CRISPR Delivery Vehicles {unique}!"
        out = await create_project(
            workspace.id,
            ProjectCreateIn(
                name=name,
                description="Compare delivery vehicle options.",
                discipline="bioengineering",
                research_question="Which vehicle best fits in-vivo editing?",
                tags=["crispr"],
                hypotheses=["LNPs outperform AAVs for hepatic targets"],
            ),
            user=user,
            db=db,
        )
        assert out.name == name
        assert out.slug == f"crispr-delivery-vehicles-{unique}"
        assert out.status == "active"

        # Same name again -> unique suffixed slug.
        again = await create_project(workspace.id, ProjectCreateIn(name=name), user=user, db=db)
        assert again.slug == f"crispr-delivery-vehicles-{unique}-2"

    # Persisted beyond the creating session.
    async with sessionmaker() as db2:
        stored = (await db2.execute(select(Project).where(Project.id == out.id))).scalar_one()
        assert stored.research_question == "Which vehicle best fits in-vivo editing?"
        assert stored.hypotheses == ["LNPs outperform AAVs for hepatic targets"]


@pytest.mark.asyncio
async def test_viewer_cannot_create_project(sessionmaker):
    async with sessionmaker() as db:
        workspace = await _seeded_workspace(db)
        viewer = await _user_with_role(db, workspace.id, "viewer")
        with pytest.raises(HTTPException) as exc:
            await create_project(
                workspace.id, ProjectCreateIn(name="Not allowed"), user=viewer, db=db
            )
        assert exc.value.status_code == 403