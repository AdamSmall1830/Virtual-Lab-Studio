"""Regenerate lib/api-spec/openapi.yaml from the FastAPI application.

The OpenAPI document is generated, never hand-edited: it is the contract the
typed frontend client is built from, and a hand-edit is a silent lie about what
the server actually serves.

Two details matter and are easy to get wrong by hand:

* The ``/api`` prefix is stripped. The generated client sets ``baseUrl: "/api"``
  in orval.config.ts, so leaving the prefix in would produce ``/api/api/v1/...``.
* Optional routes are included. Recursive Agent routes are registered
  conditionally, so the document is produced with that feature switched on;
  otherwise regenerating on a machine where it happens to be off would silently
  delete those operations from the client.

Usage:
    backend/.venv/bin/python backend/dump_openapi.py
then regenerate the client with:
    pnpm --filter @workspace/api-spec run codegen
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

# Settings are validated at import time and a real database is not needed to
# describe the API surface, so supply the minimum a Settings object requires.
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost/placeholder")
os.environ.setdefault("SESSION_SECRET", "x" * 32)

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

OUT = ROOT / "lib" / "api-spec" / "openapi.yaml"
PREFIX = "/api"


def main() -> int:
    settings = Settings(
        database_url=os.environ["DATABASE_URL"],
        session_secret=os.environ["SESSION_SECRET"],
        recursive_agents_enabled=True,
        recursive_worker_token_pepper="p" * 32,
    )
    spec = create_app(settings).openapi()

    paths = {}
    for path, item in spec["paths"].items():
        if not path.startswith(PREFIX + "/"):
            raise SystemExit(
                f"path {path!r} does not start with {PREFIX!r}; the client baseUrl "
                "assumption in lib/api-spec/orval.config.ts no longer holds"
            )
        paths[path[len(PREFIX):]] = item
    spec["paths"] = paths

    OUT.write_text(yaml.safe_dump(spec, sort_keys=False, width=88, allow_unicode=True))
    print(f"wrote {OUT.relative_to(ROOT)} — {len(paths)} paths")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
