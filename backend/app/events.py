"""Durable run event log with per-run monotonic sequences and in-process fanout.

Events are persisted before broadcast. run_sequence is allocated under a
per-run advisory transaction lock so concurrent writers cannot collide.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .models import RunEvent


class RunEventBroadcaster:
    """Wakes SSE streams when a run has new persisted events."""

    def __init__(self) -> None:
        self._conditions: dict[str, asyncio.Condition] = {}
        self._lock = asyncio.Lock()

    async def condition_for(self, run_id: uuid.UUID) -> asyncio.Condition:
        async with self._lock:
            key = str(run_id)
            if key not in self._conditions:
                self._conditions[key] = asyncio.Condition()
            return self._conditions[key]

    async def notify(self, run_id: uuid.UUID) -> None:
        condition = await self.condition_for(run_id)
        async with condition:
            condition.notify_all()


broadcaster = RunEventBroadcaster()


async def append_event(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    run_id: uuid.UUID,
    event_type: str,
    payload: dict[str, Any] | None = None,
    actor_user_id: uuid.UUID | None = None,
    commit: bool = True,
) -> RunEvent:
    """Append an event with a per-run monotonic sequence. Caller must ensure
    payload is workspace-safe and secret-free."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 42))"),
        {"key": f"run-events:{run_id}"},
    )
    next_seq = (
        await db.execute(
            text("SELECT coalesce(max(run_sequence), 0) + 1 FROM run_events WHERE run_id = :rid"),
            {"rid": str(run_id)},
        )
    ).scalar_one()
    event = RunEvent(
        workspace_id=workspace_id,
        run_id=run_id,
        run_sequence=next_seq,
        event_type=event_type,
        payload=payload or {},
        actor_user_id=actor_user_id,
    )
    db.add(event)
    if commit:
        await db.commit()
        await broadcaster.notify(run_id)
    return event


async def fetch_events_after(
    db: AsyncSession, run_id: uuid.UUID, after_sequence: int, limit: int = 500
) -> list[RunEvent]:
    result = await db.execute(
        select(RunEvent)
        .where(RunEvent.run_id == run_id, RunEvent.run_sequence > after_sequence)
        .order_by(RunEvent.run_sequence)
        .limit(limit)
    )
    return list(result.scalars())
