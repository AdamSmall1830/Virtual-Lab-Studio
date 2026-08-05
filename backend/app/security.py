"""Session auth (signed cookie) with a development bypass login."""
from __future__ import annotations

import uuid

from fastapi import Depends, HTTPException, Request, Response
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .db import get_db
from .models import User, WorkspaceMembership

ROLE_ORDER = {"viewer": 0, "reviewer": 1, "researcher": 2, "admin": 3, "owner": 4}


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().session_secret, salt="vls-session")


def set_session_cookie(response: Response, user_id: uuid.UUID) -> None:
    settings = get_settings()
    token = _serializer().dumps({"uid": str(user_id)})
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=settings.session_max_age_seconds,
        httponly=True,
        samesite="lax",
        secure=not settings.is_development,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(get_settings().session_cookie_name, path="/")


async def get_current_user(
    request: Request, db: AsyncSession = Depends(get_db)
) -> User:
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status_code=401, detail={"code": "unauthenticated", "message": "Sign in required"})
    try:
        data = _serializer().loads(token, max_age=settings.session_max_age_seconds)
    except BadSignature:
        raise HTTPException(status_code=401, detail={"code": "invalid_session", "message": "Session invalid"})
    user = await db.get(User, uuid.UUID(data["uid"]))
    if user is None:
        raise HTTPException(status_code=401, detail={"code": "unknown_user", "message": "Session user not found"})
    return user


async def get_membership(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> WorkspaceMembership | None:
    result = await db.execute(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id,
            WorkspaceMembership.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()


async def require_workspace_role(
    db: AsyncSession, workspace_id: uuid.UUID, user: User, minimum_role: str = "viewer"
) -> WorkspaceMembership:
    membership = await get_membership(db, workspace_id, user.id)
    if membership is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Not found"})
    if ROLE_ORDER[membership.role] < ROLE_ORDER[minimum_role]:
        raise HTTPException(
            status_code=403,
            detail={"code": "insufficient_role", "message": f"Requires {minimum_role} role"},
        )
    return membership
