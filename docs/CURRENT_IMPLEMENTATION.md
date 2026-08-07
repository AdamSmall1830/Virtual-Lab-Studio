# Current Implementation — How the Platform Works Today

_Last updated: August 6, 2026. This is the authoritative description of what is actually
built and running, as opposed to the target contract in `docs/TECHNICAL_ARCHITECTURE.md`
and `MASTER_REPLIT_AGENT_PROMPT.md`. When the two disagree, this file describes reality;
the pack docs describe the destination._

## 1. Big picture

| Task | Scope | Status |
|------|-------|--------|
| #2 | Web interface (landing, methodology, dashboard, projects, agents, templates, evidence library, composer, live room, run detail, comparisons, settings) | **Done** — fully API-backed |
| #1 | Authoritative Python/FastAPI backend wrapping upstream `src/virtual_lab`: PostgreSQL schema + Alembic, auth + workspace roles, Demo Provider, async run queue/worker, SSE | **Done** |
| #3 | Evidence library, exports, reproducibility packets | **Done** — see notes below on what remains partial |

The former interim Express/Drizzle API has been **deleted**; the `artifacts/api-server`
workflow now runs the FastAPI backend. The React frontend is **fully wired to `/api/v1`**:
the client-side demo store was removed (there is no `artifacts/web/src/demo/`), and all
server state flows through the generated OpenAPI hooks aliased in
`artifacts/web/src/api/index.ts`, with session/workspace context in `src/api/session.tsx`
and a fetch-based SSE client in `src/api/sse.ts`.

Evidence, exports, and reproducibility packets are implemented end-to-end (evidence
library CRUD, `POST /runs/{id}/exports` producing a ZIP packet with the manifest,
transcript, summary, evidence, citations, agents, usage, interventions, reviews, and a
`hashes.json`). Genuinely partial: reproducibility integrity is **hash-based, not
signed** — the manifest's `signature`/`signature_algorithm` fields are `null`, so the
guarantee is content-checksum tamper detection (hashes stored alongside the content),
not a cryptographic signature; the export packet omits raw source bytes and per-call
provider parameters; citation validation confirms a cited evidence key was frozen into
the definition (and flags `unmatched_attachment` / `unknown_evidence`), but does not
verify a passage supports the claim; and nothing gates export/download on an approved
review. `ensemble_merge` meetings remain a follow-up.

## 2. Repository layout (actual)

```text
src/virtual_lab/            upstream package (MIT, commit 8a3a4fd) — DO NOT MODIFY
LICENSE, pyproject.toml,
UPSTREAM_README.md          upstream-owned files — DO NOT MODIFY
backend/                    FastAPI backend (own venv at backend/.venv)
backend/app/                config, db, models, security, providers, engine,
                            events, worker, seed, bootstrap, api/v1.py, main.py
backend/tests/              pytest suite (upstream compat, engine, seed, clean boot)
alembic/, alembic.ini       migrations; 0001 executes specs/database_schema.sql
artifacts/web/              React 19 + Vite frontend (served at previewPath "/")
artifacts/api-server/       thin package.json that launches uvicorn (no TS code)
lib/api-spec/openapi.yaml   OpenAPI contract used by the frontend codegen
lib/api-client-react/       Orval-generated TanStack Query hooks (frontend client)
docs/, specs/               build-pack product contract, tokens, seed data, schemas
```

## 3. Backend runtime

- Python 3.13 venv at `backend/.venv` (uv-managed; root `pyproject.toml` belongs to the
  upstream package and is untouched). Deps in `backend/requirements.txt`.
- Workflow `artifacts/api-server: API Server` runs
  `backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --port $PORT`.
- **Fresh-database boot is automatic:** the FastAPI lifespan applies
  `alembic upgrade head` and then runs the idempotent seed
  (`backend/app/bootstrap.py`) before serving, so an empty database comes up fully
  working with no manual steps. Verified by `backend/tests/test_clean_boot.py`.
- Config via env (`backend/app/config.py`): `DATABASE_URL`, `SESSION_SECRET`,
  `APP_ENV`, `RUN_WORKER_ENABLED`, worker lease/poll knobs. Real-provider options:
  `AI_INTEGRATIONS_OPENAI_BASE_URL` / `AI_INTEGRATIONS_OPENAI_API_KEY` (Replit AI
  Integrations proxy for the zero-key "Replit AI" provider source; empty = unavailable)
  and `REPLIT_AI_ALLOWED_EMAILS` (comma-separated allowlist for that owner-billed
  option; empty = nobody).

## 4. API surface (`backend/app/api/v1.py`, mounted at `/api/v1`)

| Method & path | Purpose |
|---|---|
| `POST /auth/dev-login`, `POST /auth/logout` | dev-only login (403 outside development) + signed session cookie |
| `GET /me`, `GET /workspaces` | current user, memberships, workspaces |
| `GET /workspaces/{id}/projects|agents|templates|providers` | catalog reads (system + workspace scope) |
| `POST /projects/{id}/meeting-drafts` | create a draft |
| `POST /meeting-drafts/{id}/validate` | validation + call/token/cost estimate |
| `POST /meeting-drafts/{id}/launch` | freeze sha256 definition + agents, enqueue run |
| `GET /runs/{id}` (+ `/turns`, `/summary`, `/interventions`) | run inspection |
| `GET /runs/{id}/events?after=N` | append-only event log replay |
| `GET /runs/{id}/events/stream` | SSE with Last-Event-ID replay + heartbeats |
| `POST /runs/{id}/pause|resume|cancel` | control requests honored at checkpoints |
| `POST /runs/{id}/interventions` | human instructions injected at next checkpoint |
| `POST /runs/{id}/exports`, `GET /runs/{id}/report.pdf` | reproducibility packet (ZIP) and typeset report |
| `GET /api/health/live|ready|worker` | health + queue depth (unversioned) |

Authorization: role ladder viewer < reviewer < researcher < admin < owner; non-members
get 404 (`backend/app/security.py`).

When `RECURSIVE_AGENTS_ENABLED=true`, a second router (`backend/app/api/recursive.py`)
adds the recursive-agent surface: researcher-facing reads
(`GET /workspaces/{id}/recursive-workers`, `GET /runs/{id}/recursive-jobs`,
`GET /runs/{id}/recursive-tree`, `GET /recursive-jobs/{id}`), workspace administration
(enrollment-token mint, enable/disable, revoke), and the machine-facing worker protocol
(`POST /recursive-workers/enroll|heartbeat|jobs/lease`,
`POST /recursive-jobs/{id}/heartbeat|events|complete|fail|release`,
`GET /recursive-jobs/{id}/bundle`). The router is *registered* conditionally rather than
refused at request time, so with the feature off those paths 404 like any unknown URL and
leave no trace in the OpenAPI document. Worker calls authenticate with a bearer worker
token and never with a session cookie.

## 5. Meeting engine and run worker

- `backend/app/engine.py` builds the turn plan with upstream semantics:
  team = `R × (M + 1) + 1` calls (lead, members…, final lead synthesis);
  individual = `2R + 1` (expert/critic alternation, final expert). Prompts reuse
  `virtual_lab.prompts` and ephemeral upstream `Agent` objects.
- `backend/app/worker.py`: in-process asyncio worker claims queued runs via the
  `claim_next_run` SQL function (`FOR UPDATE SKIP LOCKED`), with leases, heartbeats,
  expired-lease recovery, and max-attempt failure.
- Checkpoints before every provider call honor pause/resume/cancel, inject human
  interventions, renew leases, and enforce budgets (`max_provider_calls`,
  `max_cost_usd` → `budget_stopped`).
- Events (`run_events`) are append-only with a per-run monotonic `run_sequence`
  allocated under an advisory lock; an in-process broadcaster wakes SSE streams.
- Structured summaries are validated against `specs/meeting_summary.schema.json` and
  stored with a sha256 in `run_summaries`.
- Providers (`backend/app/providers.py`): the deterministic **Demo Provider** (scripted
  scenario for the seeded demo project, hash-labeled fallback otherwise, always labeled
  as simulation, zero cost) plus **real OpenAI-compatible providers**, constructed per
  `ProviderConfig`. API keys are AES-256-GCM encrypted (key derived from
  `SESSION_SECRET`) and write-only through the API; user-supplied base URLs pass SSRF
  validation. A zero-key **Replit AI** source resolves credentials from the
  `AI_INTEGRATIONS_OPENAI_*` env at runtime and is gated by the
  `REPLIT_AI_ALLOWED_EMAILS` allowlist. Model pricing lives in
  `ProviderModel.capabilities["pricing"]` and drives real cost estimates. Truthful
  labeling: only demo runs (`run.demo_mode`) get the simulation summary; real runs get
  a model-generated summary with a human-review disclosure. `ensemble_merge` meetings
  remain a follow-up.

## 6. Recursive agents (optional, off by default)

A *recursive participant* is a seat in a meeting that is executed by an external machine
the researcher owns — typically their own GPU workstation running local models — instead
of by this deployment. The studio never runs agent-generated code: it queues the turn and
waits. The feature is off unless `RECURSIVE_AGENTS_ENABLED=true` and a ≥32-character
`RECURSIVE_WORKER_TOKEN_PEPPER` is set.

- **Code** (`backend/app/recursive/`): `tokens.py` (enrollment/worker credential minting
  and verification — peppered hashes, raw tokens never stored), `policy.py` (per-job
  limits, clamped to the `RECURSIVE_JOB_HARD_MAX_*` ceilings before dispatch),
  `broker.py` (dispatch, leasing, heartbeats, completion, failure, cancellation
  precedence), `bundle.py` (the ZIP of request + task brief + evidence handed to a
  leaseholder), `worker_events.py` (allow-listed ingestion of worker events into the
  run's event stream), `record.py` (the single shared definition of the recursive
  execution record used by the manifest, the export packet and the PDF appendix), and
  `fake_worker.py` (an in-process simulator for development, gated on
  `RECURSIVE_AGENTS_ALLOW_FAKE_WORKER`).
- **Data** (migration `0003_recursive_agents`): `recursive_workers`,
  `recursive_worker_enrollments`, `recursive_agent_jobs`, `recursive_agent_nodes`,
  `recursive_job_events` (dedup ledger only). Worker-reported activity lands in the
  ordinary `run_events` stream so the live room and the export see one timeline.
- **Execution model.** The engine reaches a recursive seat, freezes a request contract
  (hashed), parks the run in `waiting_external`, and stops holding a lease. A worker
  leases the job, downloads the bundle, streams events, and posts a result that must echo
  the request hash. Acceptance re-checks identity, lease, spend, node shape and citations
  in one transaction, then requeues the run. A worker cannot declare a terminal state
  through the event stream, spend past its grant, cite evidence that was not frozen, or
  touch a job it does not hold.
- **Trust.** A worker is authenticated but not trusted; everything it reports is a claim.
  What it says is filtered to an allow-list of fields on the way in, so credentials,
  environment dumps, host paths and private reasoning have no route into the record.
  `docs/WORKER_SECURITY_MODEL.md` states the boundary in full;
  `backend/tests/test_recursive_hostile_inputs.py` is its executable form.
- **Provenance.** Every run manifest carries a `recursive_execution` block inside the
  hashed payload — `job_count: 0` for an ordinary meeting, so absence is a statement
  rather than a gap. The export packet always contains `recursive/jobs.json`,
  `nodes.json`, `events.json`, `workers.json` and a per-job result file, each bound by a
  digest in the manifest. The PDF has an opt-in **Recursive execution** appendix
  (`recursive_execution` section, off by default) which says on the page that this
  deployment did not observe the work itself.

## 7. Data model and migrations

The schema is `specs/database_schema.sql`, applied verbatim by Alembic migration
`0001_initial_schema`. SQLAlchemy models (`backend/app/models.py`) mirror the used
subset; Postgres enum values are listed in `_ENUM_VALUES` and must stay in sync with the
spec SQL.

## 8. Seeding (`backend/app/seed.py`, idempotent — safe to run twice)

- 12 system agent profiles + version 1 (upstream-format system prompts + behavioral
  rules) from `specs/seed_agents.json`
- 10 system meeting templates from `specs/seed_meeting_templates.json`
- system tools `pmc_search`, `workspace_evidence_search`
- demo workspace `virtual-lab`, demo user, demo project
  `biodegradable-packaging-pilot` with two note evidence items, Demo Provider config +
  `demo-research-v1` model

## 9. Tests

`cd backend && .venv/bin/python -m pytest` — upstream compatibility (call-count
formulas, exact speaking order, transcript visibility, `Agent.prompt` format), turn-plan
units, seed idempotency, engine end-to-end (events, summary, pause/resume/cancel,
budget stop), and a clean-database boot test (new empty DB → uvicorn boot → dev login →
demo launch → completed run).

The recursive-agent feature carries three suites of its own, sharing one scaffold
(`backend/tests/recursive_support.py`) so that all three describe the same system:

| Suite | Asks |
|---|---|
| `test_recursive_broker.py` | does a turn survive the round trip — dispatch, lease, heartbeat, events, completion, failure, cancellation, lease loss, requeue |
| `test_recursive_provenance.py` | does the permanent record tell the truth — a standard run states that nothing was delegated, every recursive packet file is bound by a manifest digest, the packet holds no credential or host path, and the appendix says what it cannot attest to |
| `test_recursive_hostile_inputs.py` | what can a compromised worker make this deployment do — path traversal and device names in filenames, prompt injection in evidence, fabricated citations, credential and environment dumps in events, replayed and stolen jobs, SSRF strings, over-deep JSON, oversized text, trees deeper than the granted policy |

The suites run against the development database and clean up after themselves.

## 10. Frontend map (`artifacts/web/src/`)

Single canonical React frontend served at preview path `/` (the older duplicate
`artifacts/studio` was deleted): landing, methodology, sign-in (dev-login), dashboard,
projects, Agent Studio, templates, evidence library, 6-step composer, live meeting room,
run detail (summary/transcript/citations/manifest/reviews/exports), comparisons, and
settings. It is fully API-backed via the generated OpenAPI React Query hooks aliased in
`src/api/index.ts`, with session/workspace context in `src/api/session.tsx` and a
fetch-based SSE client (with polling fallback) in `src/api/sse.ts`; there is no
localStorage demo layer. Design system: restrained glassmorphism per
`specs/design_tokens.css`; no emojis in UI.

## 11. Operating the project

- Workflows: `artifacts/api-server: API Server` (uvicorn) and `artifacts/web: web`, plus
  the canvas mockup sandbox. Restart after code changes.
- Schema changes: add an Alembic migration (never edit migration 0001), keep
  `specs/database_schema.sql` and `_ENUM_VALUES` in sync.
- Backend commands run with `backend/.venv/bin/python` from the repo root
  (`-m alembic upgrade head`) or `backend/` (`-m pytest`).
