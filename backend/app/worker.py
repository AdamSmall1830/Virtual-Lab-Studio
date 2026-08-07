"""PostgreSQL-backed run worker.

Claims queued runs with the claim_next_run() function (FOR UPDATE SKIP
LOCKED), renews leases via heartbeats, requeues expired leases, and executes
runs through the meeting engine.
"""
from __future__ import annotations

import asyncio
import logging
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .config import get_settings
from .engine import execute_run
from .events import append_event
from .recursive import fake_worker
from .recursive.broker import sweep_recursive_jobs

logger = logging.getLogger("vls.worker")


async def _recover_expired_leases(db: AsyncSession) -> None:
    rows = (
        await db.execute(
            text(
                """
                UPDATE runs
                SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed'::run_status
                                  ELSE 'queued'::run_status END,
                    failure_code = CASE WHEN attempt_count >= max_attempts THEN 'lease_expired' ELSE failure_code END,
                    failure_safe_message = CASE WHEN attempt_count >= max_attempts
                        THEN 'Run lease expired after repeated attempts.' ELSE failure_safe_message END,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = now()
                WHERE status IN ('leased', 'running', 'pausing', 'cancelling')
                  AND lease_expires_at IS NOT NULL
                  AND lease_expires_at < now()
                RETURNING id, workspace_id, status
                """
            )
        )
    ).all()
    await db.commit()
    for row in rows:
        logger.warning("Recovered expired lease for run %s -> %s", row.id, row.status)
        if row.status == "failed":
            await append_event(
                db,
                workspace_id=row.workspace_id,
                run_id=row.id,
                event_type="run.failed",
                payload={"failure_code": "lease_expired",
                         "message": "Run lease expired after repeated attempts."},
            )


async def worker_loop(sessionmaker: async_sessionmaker[AsyncSession], stop: asyncio.Event) -> None:
    settings = get_settings()
    worker_id = settings.worker_id
    logger.info("Run worker %s started", worker_id)
    while not stop.is_set():
        try:
            claimed: uuid.UUID | None = None
            async with sessionmaker() as db:
                await _recover_expired_leases(db)
                # Deliberately not gated on the recursive feature flag. Turning
                # the flag off while a meeting is parked on an external worker
                # must not strand that meeting: the sweeper still has to bring
                # it to a terminal state.
                try:
                    await sweep_recursive_jobs(db)
                except Exception:  # noqa: BLE001
                    logger.exception("Recursive job sweep failed")
                    await db.rollback()
                # Development-only simulator. Gated inside tick(), which is a
                # no-op unless the deployment explicitly allows a fake worker.
                try:
                    await fake_worker.tick(sessionmaker)
                except Exception:  # noqa: BLE001
                    logger.exception("Simulated recursive worker failed")
                row = (
                    await db.execute(
                        text("SELECT id, workspace_id FROM claim_next_run(:wid, :secs)"),
                        {"wid": worker_id, "secs": settings.worker_lease_seconds},
                    )
                ).first()
                await db.commit()
                if row is not None:
                    claimed = row.id
            if claimed is not None:
                logger.info("Worker %s claimed run %s", worker_id, claimed)
                try:
                    await execute_run(sessionmaker, claimed, worker_id)
                except Exception:  # noqa: BLE001
                    logger.exception("Run %s failed", claimed)
                continue  # look for next run immediately
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Worker loop error")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.worker_poll_seconds)
        except asyncio.TimeoutError:
            pass
    logger.info("Run worker %s stopped", worker_id)
