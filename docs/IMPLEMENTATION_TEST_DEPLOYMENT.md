# Implementation, Test, and Deployment Plan

## Phase 0 — Baseline

- inspect upstream repository/version/commit/license
- test `Agent` and `run_meeting` behavior
- add provider seam/fake client without breaking importability
- establish lint/type/test commands

Exit: upstream behavior is covered.

## Phase 1 — Foundation

- backend/frontend layout
- FastAPI health and production static serving
- React shell and tokens
- configuration validation
- Replit PostgreSQL integration
- SQLAlchemy/Alembic migration
- Clerk/Replit Auth integration
- local user and workspace membership guard

Exit: authenticated seeded workspace opens.

## Phase 2 — Core domain

- projects
- agent profiles/versions
- template profiles/versions
- provider configs/models/pricing
- audit
- idempotent seed

Exit: project and team can be assembled.

## Phase 3 — Providers

- provider protocol
- OpenAI
- OpenAI-compatible
- secret encryption
- SSRF-safe test
- model capability/catalog
- deterministic Demo Provider

Exit: Demo Provider produces normalized turns/usage.

## Phase 4 — Run engine

- meeting draft schemas
- validation/estimate
- frozen definition
- team/individual/ensemble/merge engine
- state machine
- PostgreSQL queue/lease/heartbeat/recovery
- events and SSE/replay
- budgets
- pause/cancel/interventions
- structured summary/repair

Exit: API can run and complete a demo meeting.

## Phase 5 — Evidence/tools

- App Storage
- PDF/Markdown/text extraction
- chunk/hash/page metadata
- full-text search
- evidence snapshots
- tool registry
- PMC with limits/timeouts
- citations

Exit: attached evidence appears in run and summary.

## Phase 6 — Primary UI

- landing/dashboard
- projects
- Agent Studio
- templates
- evidence
- composer
- Live Meeting Room
- Run Detail

Exit: primary browser workflow works end-to-end.

## Phase 7 — Academic ecosystem

- notebook
- evaluations/rubrics
- blinded comparison
- manifests
- exports/ZIP
- methodology/about
- project timeline

Exit: review, compare, document, export.

## Phase 8 — Security/reliability

- rate limits
- secure headers
- upload hardening
- secret redaction
- tenant isolation
- SSRF tests
- failure/recovery tests
- archive/retention behavior

## Phase 9 — Polish/publish

- dark/light
- responsive widths
- keyboard/reduced motion
- route splitting/performance
- Playwright
- README
- Reserved VM publish commands

## Backend tests

### Core

- prompt compilation
- team/individual order and formulas
- zero-round compatibility
- configurable critic
- mixed models
- iterative tools/cap
- budget stop
- structured validation and one repair
- evidence ID validation

### Lifecycle

- queued -> validating -> running -> completed
- pause request -> paused checkpoint
- intervention -> resume
- cancel before/after in-flight request
- provider timeout/retry
- budget-exceeded
- lease recovery without duplicate completed turn
- partial results retained on failure

### Authorization/security

- every role
- cross-workspace ID swapping
- secret never returned/logged
- SSRF block cases and unsafe redirect
- HTTPS requirement
- safe error response

### Evidence

- valid PDF/text/Markdown
- unsupported/spoofed/oversized
- extraction failure
- duplicate hash
- page/section metadata
- workspace search isolation
- prompt-injection wrapper
- citation opens correct excerpt

## Frontend tests

- composer validation and autosave revision
- keyboard agent reorder
- live SSE replay/reconnect
- source drawer/citation navigation
- provider secret masking
- role-based disabled/hidden actions
- dark/light/reduced-motion
- sanitized Markdown

## Playwright journeys

### Demo

1. authenticate/dev bypass
2. open demo project
3. use Literature Review template
4. launch Demo Provider
5. watch events and completion
6. inspect summary/transcript/evidence
7. submit review
8. export ZIP

### Custom

1. create project
2. clone/edit agent
3. upload sample source
4. create two-round team
5. validate call/token estimate
6. pause after round one
7. intervene and resume
8. complete/review

### Compare

1. create two completed runs
2. blind A/B
3. score rubric
4. select preferred run
5. create follow-up draft

## Quality gates

- empty DB migration succeeds
- seed twice yields no duplicates
- Python lint/type/tests
- frontend lint/type/unit tests
- key Playwright test
- no breaking browser console/network error
- manual responsive inspection at 1440, 1024, 768, 390
- accessible focus/keyboard/status
- secret scan/dependency review
- upstream license intact

## Replit deployment

Use Replit PostgreSQL, App Storage, Auth/Clerk, and Secrets.

Use a Reserved VM for v1:

- worker always available
- long meetings
- SSE stability
- predictable single-process behavior

Suggested production sequence:

1. install Python dependencies
2. install locked frontend dependencies
3. build frontend
4. run Alembic upgrade
5. start one ASGI process on `$PORT`

Do not start one worker loop per multiple Uvicorn worker. Use one process or database singleton election.

## Startup

- validate config
- verify database schema
- initialize storage
- start worker if enabled
- production rejects weak encryption key
- Demo Provider works without OpenAI key

## Failure playbooks

- provider outage: no silent fallback, preserve partial, explicit retry
- database outage: stop provider calls if persistence is unsafe
- storage outage: database pages continue; upload/export jobs retriable
- worker restart: lease expiry, safe-boundary recovery or transparent failure

## README requirements

- upstream attribution/license
- architecture
- Replit/local setup
- auth/database/storage integrations
- secrets
- migrations/seed
- provider setup and localhost limitation
- commands
- Reserved VM publication
- security/research limitations
- backup/export/troubleshooting
