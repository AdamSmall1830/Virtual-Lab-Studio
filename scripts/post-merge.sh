#!/bin/bash
set -e
# Prefer a frozen install, but fall back if a merged task changed a package.json
# without regenerating pnpm-lock.yaml (e.g. lib/api-zod's zod v4 pin).
pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile

# NOTE: do not add `pnpm --filter db push` here. The Postgres schema is owned by
# the FastAPI backend's Alembic migrations, which run automatically when the API
# server boots (backend/app/bootstrap.py). lib/db is an unused leftover from the
# workspace template and its Drizzle schema does not describe the real database —
# pushing it would reconcile the live schema down to that stale definition.

# A merged task may have added Python dependencies to the backend. The venv is
# uv-managed and has no pip of its own, so install through uv.
if [ -f backend/requirements.txt ] && [ -x backend/.venv/bin/python ]; then
  uv pip install --quiet --python backend/.venv/bin/python -r backend/requirements.txt
fi
