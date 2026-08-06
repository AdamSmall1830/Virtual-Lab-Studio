"""Regenerate lib/api-spec/openapi.yaml from the live FastAPI app.

The spec is generated, never hand-edited. Run this after changing any route or
schema, then run `pnpm --filter @workspace/api-spec codegen` to refresh the
generated client — a stale client is the usual cause of "property does not
exist" type errors in artifacts/web.

Two transformations are applied to FastAPI's own output:

1. The ``/api`` mount prefix is stripped from every path. The frontend prepends
   its own base path, so the spec describes routes from ``/v1`` down.
2. Query parameters are dropped. orval's zod client generates a ``Params`` type
   per operation and collides with itself when query params are present; the
   frontend passes query strings manually instead.

Usage:  backend/.venv/bin/python backend/scripts/export_openapi.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPO_ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import yaml  # noqa: E402

from app.main import app  # noqa: E402

OUTPUT = REPO_ROOT / "lib" / "api-spec" / "openapi.yaml"
MOUNT_PREFIX = "/api"


def build_spec() -> dict:
    spec = app.openapi()

    paths = {}
    for route, item in spec.get("paths", {}).items():
        key = route[len(MOUNT_PREFIX):] if route.startswith(MOUNT_PREFIX) else route
        for operation in item.values():
            if not isinstance(operation, dict):
                continue
            params = operation.get("parameters")
            if params:
                kept = [p for p in params if p.get("in") != "query"]
                if kept:
                    operation["parameters"] = kept
                else:
                    operation.pop("parameters")
        paths[key] = item
    spec["paths"] = paths
    return spec


def main() -> None:
    spec = build_spec()
    OUTPUT.write_text(yaml.safe_dump(spec, sort_keys=False, allow_unicode=True))
    print(f"Wrote {OUTPUT.relative_to(REPO_ROOT)} ({len(spec['paths'])} paths)")


if __name__ == "__main__":
    main()
