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

The app is built here with every optional feature switched on. A deployment
decides which routes it actually serves -- the Recursive Agent routes are only
registered when that feature is enabled -- but the spec is the whole contract,
so the generated client always has types for them. The frontend asks the server
at runtime whether a feature is available; it never infers that from the spec.

Usage:  backend/.venv/bin/python backend/scripts/export_openapi.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPO_ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

os.environ["RECURSIVE_AGENTS_ENABLED"] = "true"
# The pepper is only a startup precondition of the feature flag. This app is
# never served and never signs a token; it is introspected for its schema and
# thrown away, so a fixed placeholder is correct here and a real secret would
# be wrong -- it would put a live credential in a build step.
os.environ.setdefault(
    "RECURSIVE_WORKER_TOKEN_PEPPER", "openapi-export-placeholder-not-a-secret"
)

import yaml  # noqa: E402

from app.main import create_app  # noqa: E402

app = create_app()

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
