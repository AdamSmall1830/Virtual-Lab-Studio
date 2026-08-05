# Current Implementation — How the Platform Works Today

_Last updated: August 5, 2026. This is the authoritative description of what is actually
built and running, as opposed to the target contract in `docs/TECHNICAL_ARCHITECTURE.md`
and `MASTER_REPLIT_AGENT_PROMPT.md`. When the two disagree, this file describes reality;
the pack docs describe the destination._

## 1. Big picture

Virtual Lab Studio is being delivered in three planned tasks:

| Task | Scope | Status |
|------|-------|--------|
| #2 | Web interface (landing, methodology, dashboard, projects, agents, templates, composer, live room, run detail) + interim API with a deterministic Demo Provider engine | **Done** |
| #1 | Authoritative Python/FastAPI meeting engine wrapping upstream `src/virtual_lab`, real providers, run queue/worker | Pending |
| #3 | Evidence library, exports, reproducibility packets | Pending |

The interim stack was chosen so the full UI could ship with **zero dead buttons** before
the Python engine exists: every screen is backed by real persisted data and a working,
visibly-labeled simulation engine.

## 2. Repository layout (actual)

```text
src/virtual_lab/            upstream package (MIT, commit 8a3a4fd) — DO NOT MODIFY
LICENSE, pyproject.toml,
UPSTREAM_README.md          upstream-owned files — DO NOT MODIFY
artifacts/studio/           React 19 + Vite frontend (served at previewPath "/")
artifacts/api-server/       Express API (mounted at /api by the platform proxy)
lib/api-spec/openapi.yaml   single source of truth for the API contract
lib/api-client-react/       Orval-generated TanStack Query hooks (frontend client)
lib/api-zod/                Orval-generated Zod schemas (server-side validation)
lib/db/                     Drizzle ORM schema + client (Replit PostgreSQL)
docs/, specs/               build-pack product contract, tokens, seed data, schemas
.agents/skills/...          project skill for builders
```

Monorepo is pnpm workspaces. The frontend never hardcodes URLs; it uses generated hooks
with base `/api`, and routing uses `import.meta.env.BASE_URL`.

## 3. API contract and codegen flow

- Edit `lib/api-spec/openapi.yaml` (paths are `/v1/...` under base `/api`, so public URLs
  match the pack's `/api/v1/...` contract).
- Run `pnpm --filter @workspace/api-spec run codegen`. This regenerates:
  - `lib/api-client-react/src/generated/` — typed fetchers + React Query hooks
  - `lib/api-zod/src/generated/` — Zod schemas the Express routes use to validate bodies
- Known quirks (see `.agents/memory/orval-zod-codegen.md`): `lib/api-zod` pins `zod@^4`
  directly (workspace catalog is v3); avoid operation query parameters (generated name
  collision) — the events endpoint returns the full list and the client filters.

### Endpoints (all implemented in `artifacts/api-server/src/routes/`)

| Method & path | Purpose |
|---|---|
| `GET /api/healthz` | health check |
| `GET /api/v1/dashboard/summary` | counts, token/call totals, recent runs |
| `GET/POST /api/v1/projects`, `GET/PATCH /api/v1/projects/:id` | project CRUD (archive via `status`, never delete) |
| `GET /api/v1/projects/:id/runs` | runs for a project |
| `GET/POST /api/v1/agents`, `GET/PATCH /api/v1/agents/:id` | agent profiles (content edits bump `version`) |
| `GET /api/v1/templates`, `GET /api/v1/templates/:id` | read-only seeded meeting templates |
| `GET/POST /api/v1/runs`, `GET /api/v1/runs/:id` | launch + inspect runs |
| `GET /api/v1/runs/:id/events` | append-only ordered event log |
| `POST /api/v1/runs/:id/control` | `pause` / `resume` / `cancel` / `intervene` |

## 4. Data model (Drizzle, `lib/db/src/schema/`)

- `projects` — research question, hypotheses, objectives, constraints, ethics/disclosure
  notes, human decision, tags, status.
- `agents` — upstream persona fields (`title`, `expertise`, `goal`, `role`), provider/model
  labels, accent color, `version`, `archived`, `isSystem`. The upstream system prompt is
  compiled client-side: "You are {title}. Your expertise is in {expertise}. …"
- `meeting_templates` — kind (`team` / `individual` / `ensemble_merge`), category,
  agenda template, required questions, rules, suggested agent slugs, default rounds.
- `runs` — agenda, rounds, participants (JSON snapshot frozen at launch), status,
  counters (`callCount`, `tokensUsed`), `plannedCallCount`, `summary` JSON,
  `isSimulation`, plus demo-engine bookkeeping (`script`, `scriptCursor`, `pausedAt`,
  `pausedMsTotal`).
- `run_events` — append-only, ordered by `seq` per run. Never updated or deleted.

## 5. The Demo Provider run engine (interim)

Implemented in `artifacts/api-server/src/lib/demoEngine.ts`. Key design: **no background
timers**. A launched run stores a fully precomputed, deterministic script of events, each
with a time offset. Whenever the run is read (detail, events, list, control), the engine
"materializes" any events whose offset ≤ effective elapsed time into `run_events` and
updates run counters/status. Pause freezes the clock (`pausedAt`/`pausedMsTotal`); resume
unfreezes it. This makes the simulation deterministic, restart-safe, and cheap.

- Speaking order matches upstream semantics:
  - team: per round — lead, then each member; then one final lead synthesis.
    Planned calls = `R × (M + 1) + 1`.
  - individual: per round — expert, then critic; then final expert revision.
    Planned calls = `2R + 1`.
- Event vocabulary: `run.queued`, `run.validating`, `run.started`, `round.started`,
  `turn.started`, `turn.completed`, `checkpoint.reached`, `run.paused`,
  `human.intervention_added`, `run.resumed`, `run.cancelled`, `summary.completed`,
  `run.completed`.
- On `summary.completed`, a structured summary object (executive summary, recommendation,
  contributions per role, answers to required questions, assumptions, preserved
  disagreements, risks, next steps with acceptance criteria, qualitative confidence) is
  written to `runs.summary`.
- Every demo run has `isSimulation: true`; the UI shows a persistent "Simulation" badge
  and the summary object carries `simulated: true`.

Run status state machine (current subset): `queued → running → completed`, with
`paused ⇄ running`, and `cancelled` reachable from any active or paused state.
`draft`, `validating`, `pause_pending`, `cancelling`, `failed`, `budget_exceeded` are in
the contract and reserved for the real engine.

## 6. Live updates

Interim transport is React Query polling: the live room polls `GET /runs/:id` and
`GET /runs/:id/events` every ~1.5 s while the run is in an active status and stops on
terminal statuses. SSE with database replay (the pack's target) arrives with task #1;
the append-only `seq`-ordered event log was designed so SSE replay can drop in without a
contract change.

## 7. Seeding

`artifacts/api-server/src/lib/seed.ts` runs at server boot, idempotently (by slug/name):

- 12 agent profiles from `specs/seed_agents.json` (marked `isSystem`)
- 10 meeting templates from `specs/seed_meeting_templates.json`
- 1 neutral demo project ("Biodegradable Packaging Film Optimization")

Spec files are located at runtime by walking up from `cwd` to find `specs/`.

## 8. Frontend map (`artifacts/studio/src/`)

| Route | Page |
|---|---|
| `/` | public landing (attribution + human-oversight disclosure in footer) |
| `/methodology` | meeting method, call formulas, role-conditioning explanation, limitations |
| `/app` | dashboard (KPIs, recent projects/runs) |
| `/app/projects`, `/new`, `/:projectId` | project list / create / detail |
| `/app/agents` | Agent Studio (search, create/edit, compiled prompt preview) |
| `/app/templates` | template library with category filters |
| `/app/runs` | run history/queue |
| `/app/meetings/new` | 6-step composer (mode → agenda → team → evidence [labeled coming soon] → controls → review & launch) |
| `/app/runs/:runId/live` | live meeting room (desktop node layout, mobile strip + timeline, controls) |
| `/app/runs/:runId` | run detail: Synthesis / Transcript / Usage tabs |

Design system: restrained glassmorphism per `specs/design_tokens.css`, dark primary +
light theme, tokens live in `artifacts/studio/src/index.css`. No emojis in UI.

## 9. Operating the project

- Workflows: `artifacts/api-server: API Server`, `artifacts/studio: web` (plus the
  canvas mockup sandbox). Restart after code/config changes.
- DB schema changes: edit `lib/db/src/schema/`, then `pnpm --filter @workspace/db run push`.
- API changes: edit the OpenAPI spec → codegen → implement route → restart API workflow.
- Server logging: `req.log` / `logger` (pino), never `console.log`.

## 10. Migration path to the target architecture (task #1)

The interim design keeps the seams clean:

1. The OpenAPI contract is transport-agnostic — the FastAPI runtime replaces route
   implementations without changing the frontend.
2. `run_events` is already append-only with per-run `seq`, exactly what SSE replay needs.
3. The demo engine is isolated behind launch/control/read functions; the real engine
   replaces `buildScript`/`materializeRun` with the upstream `run_meeting` orchestration,
   a Postgres-backed queue/worker, and real provider calls — the Demo Provider remains as
   a first-class, always-labeled provider option.
4. Participants are frozen JSON snapshots at launch, matching the immutability rules.
