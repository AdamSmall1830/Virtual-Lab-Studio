"""Startup initialization: apply migrations and idempotent seed.

Called from the FastAPI lifespan so a fresh deployment (empty database) comes
up fully working: schema via Alembic, then baseline system agents/templates/
tools and the demo workspace via the idempotent seed routine.
"""
from __future__ import annotations

import asyncio
import logging

from alembic import command
from alembic.config import Config

from .config import REPO_ROOT

logger = logging.getLogger("vls.bootstrap")


def _upgrade_head() -> None:
    config = Config(str(REPO_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    command.upgrade(config, "head")


async def run_migrations() -> None:
    """Apply Alembic migrations (blocking work moved off the event loop)."""
    await asyncio.to_thread(_upgrade_head)
    logger.info("Alembic migrations applied (head)")


async def run_seed() -> None:
    from .db import get_sessionmaker
    from .seed import seed

    async with get_sessionmaker()() as db:
        counts = await seed(db)
    logger.info("Idempotent seed applied: %s", counts)


async def bootstrap() -> None:
    await run_migrations()
    await run_seed()
