"""Virtual Lab Studio FastAPI application."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .bootstrap import bootstrap
from .config import get_settings
from .db import get_engine, get_sessionmaker
from .api.v1 import router as v1_router
from .worker import worker_loop

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("vls")

_worker_task: asyncio.Task | None = None
_worker_stop = asyncio.Event()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _worker_task
    settings = get_settings()
    get_engine()
    # A fresh database must come up working: migrations + idempotent seed.
    await bootstrap()
    if settings.run_worker_enabled:
        _worker_stop.clear()
        _worker_task = asyncio.create_task(worker_loop(get_sessionmaker(), _worker_stop))
    yield
    _worker_stop.set()
    if _worker_task is not None:
        try:
            await asyncio.wait_for(_worker_task, timeout=10)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            _worker_task.cancel()
    await get_engine().dispose()


app = FastAPI(
    title="Virtual Lab Studio API",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url="/api/v1/openapi.json",
)

app.include_router(v1_router, prefix="/api/v1")


@app.get("/api/health")
@app.get("/api/health/live")
async def health_live():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}


@app.get("/api/health/ready")
async def health_ready():
    try:
        async with get_sessionmaker()() as db:
            migration = (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one_or_none()
        return {"status": "ok", "database": "ok", "migration": migration}
    except Exception as exc:  # noqa: BLE001
        logger.exception("Readiness check failed")
        return JSONResponse(status_code=503, content={"status": "degraded", "database": "error", "error": type(exc).__name__})


@app.get("/api/health/worker")
async def health_worker():
    settings = get_settings()
    async with get_sessionmaker()() as db:
        row = (
            await db.execute(
                text(
                    """
                    SELECT
                      count(*) FILTER (WHERE status = 'queued') AS queued,
                      count(*) FILTER (WHERE status IN ('leased','running','pausing','paused','cancelling')) AS active,
                      min(created_at) FILTER (WHERE status = 'queued') AS oldest_queued,
                      max(heartbeat_at) AS last_heartbeat
                    FROM runs
                    """
                )
            )
        ).one()
    worker_running = _worker_task is not None and not _worker_task.done()
    return {
        "worker_enabled": settings.run_worker_enabled,
        "worker_running": worker_running,
        "queued": row.queued,
        "active": row.active,
        "oldest_queued_at": row.oldest_queued.isoformat() if row.oldest_queued else None,
        "last_heartbeat_at": row.last_heartbeat.isoformat() if row.last_heartbeat else None,
    }
