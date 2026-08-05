"""Shared fixtures. Each test gets a fresh engine bound to its own event loop."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402


@pytest_asyncio.fixture()
async def sessionmaker():
    engine = create_async_engine(get_settings().async_database_url, poolclass=NullPool)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    finally:
        await engine.dispose()
