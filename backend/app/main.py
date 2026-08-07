"""Virtual Lab Studio FastAPI application."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .bootstrap import bootstrap
from .config import Settings, get_settings
from .db import get_engine, get_sessionmaker
from .api.v1 import router as v1_router
from .api.library import router as library_router
from .api.recursive import router as recursive_router
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
    if settings.dev_login_enabled:
        logger.warning(
            "SECURITY: /api/v1/auth/dev-login is ENABLED — this is a PASSWORDLESS "
            "AUTH BYPASS that grants a session for any email. It is gated on "
            "APP_ENV=development AND absence of REPLIT_DEPLOYMENT; it must never "
            "be reachable in a deployment."
        )
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


# ---------------------------------------------------------------------------
# Clerk Frontend API proxy (production only). Serves /api/__clerk/* so the
# Clerk browser SDK works on the deployed domain without DNS setup. In
# development the SDK talks to Clerk's dev instance directly.
# ---------------------------------------------------------------------------
CLERK_FAPI = "https://frontend-api.clerk.dev"
CLERK_PROXY_PATH = "/api/__clerk"
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length", "host",
}


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the application for one configuration.

    A factory rather than a module-level singleton because the Recursive Agent
    routes are *registered* conditionally, not merely refused at request time.
    An optional feature that lets an unattended machine credential reach the
    server should leave no trace when it is switched off: no entry in the
    OpenAPI document, no path that answers anything other than the ordinary
    404, not even a body-size or validation error to confirm the shape of a
    request. Gating inside a dependency cannot achieve that, because routing
    and body handling both happen before dependencies run.
    """
    settings = settings or get_settings()

    app = FastAPI(
        title="Virtual Lab Studio API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/v1/openapi.json",
    )

    app.include_router(v1_router, prefix="/api/v1")
    app.include_router(library_router, prefix="/api/v1")
    if settings.recursive_agents_enabled:
        app.include_router(recursive_router, prefix="/api/v1")

    @app.api_route(CLERK_PROXY_PATH + "/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"], include_in_schema=False)
    async def clerk_proxy(path: str, request: Request):
        settings = get_settings()
        if settings.is_development or not settings.clerk_secret_key:
            return JSONResponse(status_code=404, content={"detail": "Not found"})

        forwarded_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
        host = forwarded_host or request.headers.get("host", "")
        proto = request.headers.get("x-forwarded-proto", "https")
        headers = {
            k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP
        }
        headers["Clerk-Proxy-Url"] = f"{proto}://{host}{CLERK_PROXY_PATH}"
        headers["Clerk-Secret-Key"] = settings.clerk_secret_key
        xff = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        if xff:
            headers["X-Forwarded-For"] = xff

        url = f"{CLERK_FAPI}/{path}"
        body = await request.body()
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=False) as client:
            upstream = await client.request(
                request.method, url, params=request.query_params, content=body, headers=headers
            )
        response_headers = {
            k: v for k, v in upstream.headers.items() if k.lower() not in _HOP_BY_HOP
        }
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers=response_headers,
        )

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

    return app


app = create_app()
