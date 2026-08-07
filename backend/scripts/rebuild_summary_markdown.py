"""Re-render stored summary markdown from each run's own structured record.

The markdown is a *rendering* of ``summary_json``; it carries no information the
record does not already hold, and it is not part of the integrity chain — the
manifest hashes ``summary_sha256``, which is taken over the canonical JSON. So
regenerating it is safe: the hashed record is never touched, only the readable
document derived from it.

This exists because earlier runs stored a document that omitted most of the
record (disagreements, assumptions, risks, next steps, confidence), which meant
exports shipped an incomplete read of a complete finding.

Idempotent: rows already matching the current renderer are left alone.

    backend/.venv/bin/python backend/scripts/rebuild_summary_markdown.py [--apply]
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.db import get_sessionmaker  # noqa: E402
from app.engine import _summary_markdown  # noqa: E402
from app.models import MeetingDefinition, Run, RunSummary, RunTurn  # noqa: E402
from app.providers import get_demo_provider  # noqa: E402

# Taken from the same sources the engine uses, so a rebuilt document never
# restates a run's provenance differently from how the run itself stated it.
REAL_DISCLOSURE = (
    "AI-generated decision support produced by a configured model provider. "
    "Requires human scientific review; not a validated result."
)


async def main(apply: bool) -> int:
    sessionmaker = get_sessionmaker()
    changed = unchanged = 0
    async with sessionmaker() as db:
        rows = (
            await db.execute(
                select(RunSummary, Run, MeetingDefinition)
                .join(Run, Run.id == RunSummary.run_id)
                .join(MeetingDefinition, MeetingDefinition.id == Run.meeting_definition_id)
            )
        ).all()

        for summary, run, definition in rows:
            final_turn = (
                await db.execute(
                    select(RunTurn)
                    .where(RunTurn.run_id == run.id, RunTurn.response_text.is_not(None))
                    .order_by(RunTurn.sequence.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()

            rendered = _summary_markdown(
                definition.title,
                get_demo_provider().disclosure if run.demo_mode else REAL_DISCLOSURE,
                summary.summary_json or {},
                final_turn.response_text if final_turn else "",
            )
            if rendered == summary.summary_markdown:
                unchanged += 1
                continue

            changed += 1
            print(
                f"run {str(run.id)[:8]}  {len(summary.summary_markdown):>7} -> {len(rendered):>7} chars"
            )
            if apply:
                summary.summary_markdown = rendered

        if apply:
            await db.commit()

    print(f"\n{changed} to rewrite, {unchanged} already current")
    if not apply:
        print("dry run — pass --apply to write")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main("--apply" in sys.argv)))
