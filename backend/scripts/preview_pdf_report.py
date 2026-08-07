"""Render a run's PDF report to a local file, for eyeballing the layout.

Usage:
    backend/.venv/bin/python -m scripts.preview_pdf_report <run_id> [out.pdf] [--all]

Without ``--all`` only the default appendix selection is included.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import get_sessionmaker  # noqa: E402
from app.models import Run  # noqa: E402
from app.pdf_report import build_pdf_report  # noqa: E402
from app.schemas import PDF_REPORT_SECTIONS  # noqa: E402


async def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    run_id = args[0]
    out = Path(args[1]) if len(args) > 1 else Path(f"/tmp/run-{run_id[:8]}.pdf")
    sections = (
        list(PDF_REPORT_SECTIONS)
        if "--all" in sys.argv
        else ["meeting_brief", "evidence", "citations", "usage", "provenance"]
    )

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        if run is None:
            print(f"run {run_id} not found")
            return 1
        payload = await build_pdf_report(db, run, sections)
    out.write_bytes(payload)
    print(f"{out}  {len(payload):,} bytes  sections={sections}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
