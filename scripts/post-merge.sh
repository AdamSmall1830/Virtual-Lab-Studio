#!/bin/bash
set -e
# Prefer a frozen install, but fall back if a merged task changed a package.json
# without regenerating pnpm-lock.yaml (e.g. lib/api-zod's zod v4 pin).
pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile
pnpm --filter db push
