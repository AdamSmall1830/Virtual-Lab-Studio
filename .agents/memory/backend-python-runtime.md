---
name: Backend Python runtime decisions
description: Durable decisions/constraints for the FastAPI backend runtime
---

# Backend Python runtime decisions

- The FastAPI backend uses a dedicated uv-managed venv rather than a root Python project. **Why:** root `pyproject.toml` belongs to the preserved upstream `src/virtual_lab` package (MIT) and must never be repurposed; do not use `installLanguagePackages` for Python in this repo. **How to apply:** provision through the committed ensure-venv bootstrap, which the api-server artifact scripts invoke before uvicorn.
- Production is the safe default (`APP_ENV`); development conveniences (dev-login, non-secure cookies) require an explicit development opt-in. **Why:** a defaults-to-development deployment exposed an auth bypass. **How to apply:** never add a dev-only bypass gated on anything other than `is_development`.
- Fresh-empty-database boot must stay fully automatic (migrations + idempotent seed at startup). **Why:** deployments must not need manual init. **How to apply:** keep the startup bootstrap covered by the clean-boot test when adding migrations or seed data.
- The run engine must stay resume-safe: re-execution reuses persisted turns (unique run_id+sequence) and replays the transcript rather than restarting. **Why:** lease expiry/worker restarts otherwise cause duplicate-key failures.
- Integration tests that create runs must lease them to a test worker with a far-future expiry. **Why:** the live dev server's worker polls the same database and races tests for `queued` runs, causing flaky duplicates.
- SQLAlchemy `postgresql.ENUM(create_type=False)` still needs enum values listed or row reads fail — keep model enum lists in sync with the spec SQL.
- `provenance.py` is upstream of `engine.py` (engine imports it) and defines the canonical `sha256_text`/`canonical_json`. **Why:** importing engine from provenance, or importing an `api/` module from it, creates a cycle that only shows up at test collection. **How to apply:** shared hashing/serialization helpers belong in provenance; api routers import down into it, never the reverse.
