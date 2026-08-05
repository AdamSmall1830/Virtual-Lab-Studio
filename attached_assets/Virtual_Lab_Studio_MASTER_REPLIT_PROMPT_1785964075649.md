# MASTER REPLIT AGENT PROMPT — VIRTUAL LAB STUDIO

You are working inside a Replit project imported from:

`https://github.com/zou-group/virtual-lab`

Build a complete, polished, production-minded web application around the existing Python Virtual Lab codebase. The working product name is **Virtual Lab Studio** and the product line is **“Human-guided multi-agent research.”**

Do not merely produce a plan or static mockup. Inspect the repository, preserve the upstream source/license/citation, implement the application, add and run database migrations, seed the database, run automated tests, launch the preview, inspect desktop and mobile UI, fix failures, and leave the project in a genuinely working state.

Before editing code, read in full:

- `replit.md`
- every file under `docs/`
- every file under `specs/`
- `.agents/skills/virtual-lab-studio-builder/SKILL.md`
- upstream `README.md`, `LICENSE`, `pyproject.toml`, and all files in `src/virtual_lab/`

Treat these supplied files as the product contract. When an implementation detail conflicts with an actual platform limitation, choose the safest functional alternative, document the decision, and continue building rather than stopping at a question.

---

## 1. Product mission

Transform the small notebook/command-line-oriented Virtual Lab library into an intuitive academic research ecosystem where a human researcher can:

1. Create a research project.
2. Define a research question, hypotheses, objectives, constraints, disclosures, and the human decision the work will support.
3. Assemble a multidisciplinary team of model-driven research roles.
4. Attach papers, notes, prior summaries, and selected evidence.
5. Configure team, expert–critic, or ensemble-and-merge meetings.
6. Watch a meeting progress live and intervene at controlled checkpoints.
7. Receive a structured evidence-linked synthesis rather than an unstructured wall of text.
8. Compare alternative runs with blinded human rubrics.
9. Export a reproducibility packet containing transcript, prompts, agents, evidence, models, parameters, usage, timestamps, hashes, reviews, and conclusions.
10. Continue the work through a project notebook and follow-up meetings.

The application is a **human-guided research workspace**, not an autonomous laboratory, not a clinical decision system, and not proof that several model roles equal several independent human experts.

---

## 2. Preserve and improve the upstream engine

Keep the upstream `src/virtual_lab` package importable and preserve its MIT license/citation.

The following concepts must remain recognizable:

- `Agent(title, expertise, goal, role, model)`.
- Team meeting: lead, ordered specialists, agenda, required questions, rules, summaries, contexts, discussion rounds, final lead synthesis.
- Individual meeting: expert alternates with a Scientific Critic and gives a final revision.
- Optional PubMed Central search.
- Markdown and JSON transcripts.

Create an integration layer and production async runtime. Correct or isolate these upstream limitations:

- Inject provider clients instead of constructing `OpenAI()` inside the meeting function.
- Make the critic explicit/configurable; never hard-code a cloud model into a local run.
- Default the UI to two rounds.
- Permit zero rounds only through a clearly labeled “one-shot compatibility mode,” explaining that specialists/critic will not speak.
- Add asynchronous lifecycle events, cancellation, pause checkpoints, and immutable human interventions.
- Add a generic tool registry rather than a hard-coded PMC boolean.
- Permit iterative tool calls up to a configured cap.
- Capture actual provider usage when available and clearly label estimates.
- Calculate usage/cost per call and model; support mixed models.
- Add context/source budgets, provider timeouts/retries, and explicit failure states.
- Validate a structured final output and its evidence IDs.
- Store authoritative artifacts in PostgreSQL/App Storage rather than local files.
- Add compatibility tests proving original speaking order and prompts remain intact.

The authoritative orchestration runtime remains Python. Do not reimplement the core algorithm solely in TypeScript.

---

## 3. Required architecture

Use this monorepo structure:

```text
src/virtual_lab/                 preserved upstream package
backend/app/                     FastAPI application and async meeting runtime
backend/app/api/                 /api/v1 routes
backend/app/models/              SQLAlchemy models
backend/app/schemas/             Pydantic schemas
backend/app/services/            projects, agents, evidence, runs, providers, tools, exports, audit
backend/app/workers/             PostgreSQL run worker and lease recovery
backend/tests/                   pytest tests
frontend/                        React + TypeScript + Vite
frontend/src/components/         shared accessible UI
frontend/src/features/           feature modules
frontend/src/pages/              route views
frontend/src/lib/                API/auth/validation/utilities
frontend/src/styles/             global styles/tokens
alembic/                         migrations
scripts/                         dev/build/seed/test scripts
```

### Backend

Use Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2.x async, Alembic, asyncpg, httpx with explicit timeouts, and the official OpenAI SDK for OpenAI/OpenAI-compatible adapters.

Use Replit PostgreSQL. Build a PostgreSQL-backed job queue with `FOR UPDATE SKIP LOCKED`, lease owner/expiry, heartbeat, and recovery. Do not rely only on FastAPI `BackgroundTasks` for long model runs.

Use Replit App Storage for original evidence files and generated export packets.

Use Server-Sent Events for live run events, with event replay from PostgreSQL and a polling fallback.

### Frontend

Use React, TypeScript, Vite, Tailwind, supplied design tokens, accessible shadcn/ui or Radix primitives, TanStack Query, React Hook Form, Zod, Framer Motion, Lucide icons, Recharts, and a sanitized Markdown renderer.

In development, run Vite and FastAPI with an API proxy. In production, build the React app and serve it through FastAPI on `$PORT`, bound to `0.0.0.0`.

### Authentication

Prefer Clerk Auth through Replit because the product needs a branded login independent of Replit accounts. Replit Auth is an acceptable development fallback.

Create/update a local user record and enforce workspace membership server-side. Roles:

- owner
- admin
- researcher
- reviewer
- viewer

Never use frontend visibility as authorization.

### Deployment

Document and recommend one Replit Reserved VM for v1 because the worker and SSE connections need a stable always-on process. Do not assume the published filesystem is persistent.

---

## 4. Provider architecture

Create a normalized provider interface so each agent can use an explicit provider/model.

Implement in v1:

1. **OpenAI Provider** using a server-side secret.
2. **OpenAI-Compatible Provider** with configurable base URL, optional bearer token, model catalog, capability flags, and connection test. This supports securely reachable Ollama gateways and other compatible providers.
3. **Deterministic Demo Provider** for complete UI testing with no API key or cost.

Provider requirements:

- Server-side secrets only.
- Workspace credentials encrypted using `APP_ENCRYPTION_KEY`.
- Never return plaintext credentials.
- Capability flags for tools, streaming, structured output, usage, reasoning summaries, model listing, and context length.
- Safe connection test with sanitized error.
- SSRF protection: block metadata, loopback, link-local, and unsafe/private ranges by default; require HTTPS in production except explicitly trusted self-hosted/private deployments.
- UI warning that a Replit deployment cannot reach a user's personal `localhost` Ollama service.
- Editable model-pricing metadata; unknown pricing displays as unknown rather than fabricated zero.
- No silent provider fallback.
- Run hard limits for calls, input/output tokens, tool calls, source tokens, duration, retries, and optional estimated cost.

Design the interface for future Anthropic, Gemini, and other provider adapters without changing the meeting runtime.

---

## 5. Required application areas

Every visible primary action must work. Do not leave dead buttons.

### Public landing `/`

Create a premium hero with a subtle animated research-network visualization, explanation of team and expert–critic meetings, evidence grounding, reproducibility, demo CTA, workspace CTA, upstream attribution, and human-review disclaimer.

### Dashboard `/app`

Show recent projects/runs, active queue, usage/budget, recent evidence, notebook follow-ups, suggested templates, and a prominent New Meeting action.

### Projects

Routes:

- `/app/projects`
- `/app/projects/new`
- `/app/projects/:projectId`
- project tabs: Overview, Meetings, Evidence, Notebook, Compare, Settings

Project fields:

- name, abstract, domain, tags, status, owner/collaborators
- research question
- hypotheses
- objectives
- constraints
- ethics/safety notes
- disclosure/funding/conflict notes
- classification
- phase/milestones
- settings and timeline

Archive by default instead of destructive deletion.

### Agent Studio `/app/agents`

Build searchable grid/list, create, clone, edit, archive, and immutable version history.

Agent fields:

- title and short label
- expertise
- goal
- role
- advanced instructions
- limitations
- disagreement/conflict stance
- provider/model or inherit
- temperature override
- allowed tools
- icon/accent
- compiled system-prompt preview

Seed from `specs/seed_agents.json`. Preserve versions used in completed runs.

### Template Library `/app/templates`

Seed from `specs/seed_meeting_templates.json`.

Filters: literature, ideation, methods, statistics, computational, peer review, ethics/governance, grants.

Preview team, questions, rules, tools, rounds, base call count, and intended output. “Use template” creates an editable meeting draft. Users can create/version custom templates.

### Evidence Library

Routes:

- `/app/evidence`
- `/app/projects/:projectId/evidence`

Requirements:

- Upload PDF, Markdown, and text.
- Import/search PMC and import DOI metadata where feasible.
- Store original in App Storage.
- Extract bounded text chunks with page/section metadata.
- Compute SHA-256 hashes.
- Stable project/run evidence IDs such as `S-0001`.
- Search/filter, inspect excerpts, attach sources or selected chunks.
- Distinguish uploaded evidence, retrieved evidence, human notes, and previous meeting summaries.
- Show processing/error/truncation states.
- Treat source text as untrusted instructions.
- Validate citations against evidence available to the run.

### Six-step Meeting Composer `/app/meetings/new`

1. **Mode & template** — Team, Individual Expert–Critic, Ensemble + Merge.
2. **Agenda** — title, objective, required questions, rules, desired deliverable, human decision.
3. **Team** — lead/member/critic/merge-chair selection and drag reorder.
4. **Evidence & context** — sources, excerpts, prior summaries, token budget.
5. **Models & controls** — provider/model per agent, rounds, temperature, tools, pause-after-round, timeouts, calls/tokens/tools/source/cost budgets.
6. **Review & launch** — frozen summary of speaking order, formulas, evidence, models, provider reachability, policy warnings, and explicit launch confirmation.

Requirements:

- autosave drafts
- plain-language validation
- two rounds by default
- base call-count formula
- one-shot compatibility only in advanced settings
- frozen immutable meeting definition at launch
- idempotency key to avoid duplicate launch
- explicit warnings, never hidden fallback

### Live Meeting Room `/app/runs/:runId/live`

This is the signature experience.

Desktop:

- central agenda/synthesis node
- agent nodes arranged by speaking order
- subtle active-speaker connection/pulse
- transcript remains primary content

Mobile:

- compact horizontal agent strip and vertical timeline

Show:

- status, current round/speaker, progress, elapsed time
- calls/tokens/tool calls/cost or unknown pricing
- transcript events
- agent role/model badges
- tool requests/results with sanitized arguments/output
- source drawer
- queued/validating/running/pause-pending/paused/cancelling/cancelled/completed/failed/budget-exceeded states
- pause-at-checkpoint, resume, cancel, add human instruction, flag issue
- SSE reconnect with Last-Event-ID and polling fallback

Human intervention must be immutable and apply only at a safe boundary. Demo runs carry a persistent Simulation badge.

### Run Detail `/app/runs/:runId`

Tabs:

- Summary
- Transcript
- Evidence & citations
- Decisions/disagreements/assumptions
- Usage & cost
- Reproducibility manifest
- Human reviews
- Exports

Structured final summary must follow `specs/meeting_summary.schema.json` and contain:

- agenda
- executive summary
- contribution by role
- recommendation/research plan
- answer to every required question
- evidence references
- assumptions
- disagreements and unresolved questions
- risks/limitations
- next steps and suggested verification
- confidence level with textual rationale, not an uncalibrated numeric certainty

### Compare Runs

Route: `/app/projects/:projectId/compare`

Compare two to four completed runs:

- teams, prompts, models, parameters, sources
- usage/cost
- recommendations and disagreements
- human rubric scores
- blinded labels A/B/C/D
- preferred-run selection with rationale
- create follow-up draft from unresolved differences

Do not claim a semantic comparison determines truth.

### Project Notebook

Route: `/app/projects/:projectId/notebook`

Human entries, AI drafts requiring acceptance, decisions, tasks, unresolved questions, and links to runs/turns/evidence. Keep edit history. Convert notes or unresolved questions into new meeting drafts.

### Workspace Settings

Provider settings, model catalog/pricing, members/roles, default limits, retention/disclosures, theme/accessibility, and owner/admin audit viewer.

---

## 6. Academic workflow improvements

Translate the existing PMC tool into a generic read-only tool registry. Improve it with:

- NCBI identification/contact settings
- result/article/token caps
- explicit timeouts/retries/rate-limit handling
- metadata preservation
- stable source IDs
- iterative tools up to a configured cap
- clear truncation and full-text availability state

Add:

- Ensemble + Merge: N independent child runs followed by a lower-temperature merge run that preserves disagreements.
- Blinded comparison and human rubrics.
- Agent/template/prompt/evidence versioning.
- Reproducibility manifest and ZIP research packet.
- Review status: Unreviewed, Reviewed, Accepted, Rejected.
- AI-contribution disclosure.
- Explicit separation of evidence, inference, proposal, and human decision.
- Project notebook and follow-up meeting flow.

Citations show which evidence was made available/used; they do not automatically prove the claim.

---

## 7. Data model, immutability, and API

Implement the logical entities and relationships from `specs/database_schema.sql` with SQLAlchemy and Alembic.

Core invariants:

- Every record belongs to a workspace.
- Every project-scoped query verifies active membership.
- Agent/template versions used by runs cannot change retroactively.
- Launch freezes meeting definition, prompts, agents, evidence snapshots, models, controls, and budgets.
- Completed turns, tool calls, events, interventions, and manifests are append-only.
- Retry creates a linked run.
- Ensemble children and merge run preserve lineage.
- Files are App Storage object keys, not persistent local paths.
- Secrets are encrypted and excluded from API payloads, logs, exports, and errors.
- Use archive/soft delete for research records.

Create `/api/v1` REST routes for users/workspaces, projects, agents, templates, evidence, meeting drafts/validation/launch, runs/events/controls/artifacts, evaluations/comparisons, notebook, providers/models/pricing, exports, and audit.

Use UUIDs, UTC timestamps, typed safe errors, cursor pagination where appropriate, optimistic revision/ETag for editable drafts, and idempotency keys for run launch/export generation.

---

## 8. Async run state machine and events

Statuses:

```text
draft -> queued -> validating -> running
running -> pause_pending -> paused -> running
running -> cancelling -> cancelled
running -> completed
active -> failed
active -> budget_exceeded
```

Events:

```text
run.queued
run.validating
run.started
round.started
turn.started
turn.delta
turn.completed
tool.requested
tool.completed
tool.failed
source.attached
checkpoint.reached
run.pause_requested
run.paused
human.intervention_added
run.resumed
usage.updated
budget.warning
run.cancellation_requested
run.cancelled
summary.validation_failed
summary.completed
run.failed
run.completed
```

Store events before SSE broadcast. Assign monotonic per-run sequences. Support replay after sequence/Last-Event-ID. Coalesce excessive token deltas while storing final turn content.

Worker requirements:

- transactional queue claim
- renewable lease and heartbeat
- recover expired leases after restart
- save each turn/tool immediately
- bounded retry for safe transient provider failures
- pause/cancel checks between calls and before tools
- partial artifacts preserved on failure
- no repeating completed writes
- no model call if authoritative persistence is unavailable

---

## 9. Structured output and provenance

Use `specs/meeting_summary.schema.json`.

1. Prefer provider-native structured output when supported.
2. Otherwise request JSON and validate with Pydantic.
3. Permit one bounded repair call containing schema/validation errors.
4. If repair fails, keep raw synthesis and mark summary partial/invalid.
5. Validate all evidence IDs and required-question coverage separately.

Use `specs/run_manifest.schema.json`.

Manifest includes:

- app/runtime/upstream version and source commit
- run IDs/status/timestamps/review state
- mode, rounds, parameters, budgets, controls
- agent versions and system-prompt hashes
- provider/model/capability/pricing version
- tool versions/calls
- evidence source/chunk IDs, page/section, hashes, truncation state
- prior summaries/context
- human interventions
- per-call usage and latency
- parent/retry/ensemble/merge lineage
- summary validation state
- transcript/summary/manifest hashes

Exports:

- summary Markdown
- transcript Markdown and JSON
- evidence index CSV
- manifest JSON
- review JSON
- print-ready HTML
- combined ZIP packet

---

## 10. Design direction

Use `specs/design_tokens.css`.

Build a premium, restrained glassmorphic interface:

- deep ink/navy base with one quiet aurora mesh background
- translucent layered panels with subtle borders
- cyan/blue active state
- violet synthesis/merge
- mint success
- amber warnings/budget
- rose destructive/error
- generous whitespace, strong hierarchy, readable typography
- 16–24 px surface radii
- glass selectively; reading/transcript panels more opaque
- intentional light theme
- 180–240 ms restrained motion and reduced-motion support
- WCAG 2.2 AA, keyboard navigation, visible focus, semantic headings and ARIA status

Build reusable components:

- AppShell
- GlassPanel
- PageHeader
- MetricCard
- AgentAvatar / AgentCard
- ModelBadge
- EvidenceChip / CitationLink
- RunStatusBadge
- BudgetMeter
- MeetingTimeline
- TurnCard
- ToolCallCard
- SourceDrawer
- StructuredSummary
- EmptyState / ErrorState
- CommandPalette
- ConfirmDialog
- FormSection
- StepWizard

Inspect at 1440, 1024, 768, and 390 px. Avoid giant dashboard clutter, excessive gradients, unreadable blur, or decorative animation as the only state indicator.

---

## 11. Security, privacy, and research governance

Implement `docs/SECURITY_GOVERNANCE.md`.

At minimum:

- server-side workspace authorization
- secure auth session/cookies
- CSRF protection where required
- strict CORS
- CSP and secure headers
- rate limits on launch, upload, provider-test, search, and sensitive auth routes
- file extension/MIME/size/signature checks and extraction timeout
- sanitized Markdown with raw HTML disabled
- SSRF-safe provider/source URLs and redirects
- secret redaction
- evidence wrapped as untrusted content
- no automatic consequential/clinical/financial/legal action
- review state and disclosure on exports
- data classification: public/internal/restricted
- provider policy blocks prohibited classification routing
- append-only audit events for sensitive actions

Do not expose hidden model reasoning. Only display normal model output and a provider-supplied safe reasoning summary when explicitly supported.

---

## 12. Seed content and demo mode

Load `specs/seed_agents.json` and `specs/seed_meeting_templates.json` idempotently.

Create a seeded neutral demonstration project about biodegradable packaging-film optimization, with locally generated sample notes rather than copied copyrighted papers.

Demo Provider requirements:

- deterministic outputs based on run ID/agent role
- small delays so live UI can be observed
- clearly labeled simulated tool events
- valid structured summary
- zero cost
- Simulation label in live view, run detail, comparison, and exports

The entire primary workflow must be testable without a paid API key.

---

## 13. Testing

Backend unit tests:

- agent prompt compilation
- team speaking order and call formula
- individual expert–critic sequence and call formula
- zero-round compatibility behavior
- configurable critic model
- tool iteration/cap
- budgets
- structured summary validation/repair
- citation validation
- secret redaction
- workspace authorization
- state transitions
- lease expiry/recovery

Required formulas:

- Team with M members and R rounds: `R * (M + 1) + 1`
- Individual with R rounds: `2 * R + 1`
- Example team lead + 2 members, R=2: `L, A, B, L, A, B, L(final)` = 7 calls
- Example individual R=2: `Expert, Critic, Expert, Critic, Expert(final)` = 5 calls

Integration tests:

- project -> draft -> queued demo run -> completed run
- pause/intervention/resume
- cancel
- provider failure
- evidence upload/extraction
- export packet
- SSE event replay

Frontend tests:

- meeting composer validation
- agent reorder
- live reconnect
- citations/source drawer
- provider secret masking
- permission states
- keyboard navigation

Playwright end-to-end:

1. sign in or dev-auth bypass
2. open seeded project
3. launch Demo Provider meeting from template
4. watch completion
5. inspect summary/transcript/evidence
6. submit review
7. export packet
8. run a second meeting and compare

Run linting, type checks, tests, migrations, and seed twice before declaring completion.

---

## 14. Definition of done

The first release is complete only when:

- Replit preview launches without breaking console/network errors.
- User can authenticate and create/access a workspace.
- Migrations succeed from an empty database.
- Seed runs twice without duplicates.
- Projects, agents, templates, and evidence work.
- Composer freezes a valid meeting definition.
- Demo Provider run executes asynchronously and streams/replays events.
- Pause/intervention/resume and cancel work.
- OpenAI and OpenAI-compatible settings save safely and test connectivity.
- Completed run has structured summary, transcript, evidence, usage, manifest, reviews, and exports.
- Run comparison and blinded rubric work.
- Dark/light themes and responsive widths are polished.
- No primary action is a placeholder.
- No secret appears in browser payload, logs, repository, errors, or exports.
- Automated tests pass.
- Upstream license and attribution remain intact.
- README documents setup, integrations, secrets, migrations, providers, localhost limitation, testing, Reserved VM deployment, security, and limitations.

---

## 15. Implementation order

1. Baseline upstream package and add compatibility tests.
2. Create backend/frontend foundation, auth, PostgreSQL, migrations, workspace guard, and design system.
3. Implement provider interface and deterministic Demo Provider.
4. Implement frozen meeting definitions, async runtime, queue/leases, events, pause/cancel/intervention, budgets, and summaries.
5. Implement projects, versioned agents/templates, and seed content.
6. Implement App Storage evidence, extraction/search, PMC tool, citations.
7. Build Dashboard, Projects, Agent Studio, Templates, Composer, Live Room, and Run Detail.
8. Build Notebook, Compare, reviews, manifests, exports, and audit.
9. Add security hardening, error paths, responsive/accessibility polish, and full tests.
10. Run E2E, inspect preview, repair, and document Reserved VM publishing.

Do not stop after scaffolding. Build a working vertical slice early, then finish the complete product contract. Begin by inspecting the repository and supplied specifications, then implement the application.
