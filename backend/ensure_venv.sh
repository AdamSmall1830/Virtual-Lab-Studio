#!/usr/bin/env bash
# Idempotently provision the backend Python environment.
# Creates backend/.venv and installs backend/requirements.txt when missing or
# stale, so a clean checkout boots without manual steps.
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$BACKEND_DIR/.venv"
REQ="$BACKEND_DIR/requirements.txt"
STAMP="$VENV/.requirements.sha256"

req_hash="$(sha256sum "$REQ" | cut -d' ' -f1)"

if [ -x "$VENV/bin/python" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$req_hash" ]; then
  exit 0
fi

echo "[ensure_venv] provisioning backend Python environment..." >&2
if command -v uv >/dev/null 2>&1; then
  uv venv "$VENV" --python 3.13 --allow-existing >&2
  uv pip install --python "$VENV/bin/python" -r "$REQ" >&2
else
  python3 -m venv "$VENV" >&2
  "$VENV/bin/pip" install --upgrade pip >&2
  "$VENV/bin/pip" install -r "$REQ" >&2
fi
echo "$req_hash" > "$STAMP"
echo "[ensure_venv] done" >&2
