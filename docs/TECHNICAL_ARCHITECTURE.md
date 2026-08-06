# Technical Architecture and API

## Context

```text
Browser
  | HTTPS/auth
  v
FastAPI on Replit Reserved VM
  |-- /api/v1 REST
  |-- SSE stream and event replay
  |-- built React assets
  |-- PostgreSQL-backed worker
  |
  +--> Replit PostgreSQL
  +--> Replit App Storage
  +--> OpenAI
  +--> OpenAI-compatible secure endpoint
  +--> NCBI PMC
```

## Why one deployable service in v1

The first release should be easy to operate in Replit. The platform's shared reverse proxy routes by path — the static web build is served at `/` and FastAPI owns `/api` (routes are matched most-specific-first, so `/api` always reaches FastAPI); FastAPI runs a single database-backed worker. Queue and event contracts must be designed so the worker can split into a separate service later.

Use one process/instance initially unless a database singleton election prevents duplicate worker loops.

## Backend layers

### API

- resolve auth
- validate request
- enforce workspace role
- call service
- map typed domain errors to safe responses
- never perform provider calls or complex SQL directly

### Services

- WorkspaceService
- ProjectService
- AgentVersionService
- TemplateVersionService
- EvidenceService
- MeetingDefinitionService
- RunService
- ProviderConfigService
- ToolRegistry
- EvaluationService
- ExportService
- AuditService

### Worker

1. Poll queued run.
2. Claim with `SELECT ... FOR UPDATE SKIP LOCKED`.
3. Set validating + lease owner/expiry.
4. Validate frozen definition/provider/data policy.
5. Execute while renewing heartbeat.
6. Persist every event/turn/tool.
7. reach terminal state and release lease.

Expired leases are recoverable. Resume only at a safe boundary; otherwise fail transparently and offer linked retry.

## Provider protocol

Illustrative contract:

```python
class ModelProvider(Protocol):
    async def list_models(self) -> list[ModelInfo]: ...
    async def test_connection(self) -> ConnectionTestResult: ...
    async def complete(self, request: CompletionRequest) -> CompletionResult: ...
    async def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]: ...
    def capabilities(self, model_id: str) -> ModelCapabilities: ...
```

Normalized request:

- system prompt
- ordered messages
- exact model
- temperature/max output
- tools
- response schema
- correlation metadata

Normalized result:

- content
- tool calls
- finish reason
- provider request ID
- exact provider/model IDs
- input/output/cached/reasoning usage when reported
- latency
- safe metadata only

## Tool protocol

```python
class ResearchTool(Protocol):
    name: str
    description: str
    input_schema: dict
    read_only: bool

    async def authorize(self, context, args) -> None: ...
    async def execute(self, context, args) -> ToolResult: ...
```

V1 tools:

- search_pmc
- search_project_evidence
- get_evidence_excerpt

Every call stores validated arguments, status, output reference/preview, timing, source IDs, error code, and version.

## Evidence

- Original files in App Storage.
- Metadata/chunks in PostgreSQL.
- Full-text search in PostgreSQL.
- Manual source/excerpt selection always available.
- Embedding interface may exist, but v1 must not require an uncertain database extension.
- Source bundle includes stable IDs, page/section, hashes, token counts, and untrusted-content wrapper.

## Immutability

Editable draft -> launch -> frozen meeting definition.

Freeze:

- agenda/questions/rules
- mode/rounds/control settings
- agent versions and rendered prompt hashes
- provider/model per agent
- evidence source/chunk snapshot
- previous summaries/context
- budgets/tool allowlist
- template/prompt versions

Retry or changed settings produce a new linked run.

## Structured output

1. Prefer native JSON schema.
2. Otherwise request JSON.
3. Validate with Pydantic.
4. One bounded repair attempt.
5. Keep raw synthesis if invalid.
6. Validate evidence IDs and question coverage separately.

## Event model

Persist before broadcasting.

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

`run_events` has monotonically increasing sequence per run.

SSE endpoint accepts Last-Event-ID. Heartbeat comments every ~15–25 seconds. Poll endpoint fetches events after sequence. Coalesce excessive deltas.

## API conventions

- `/api/v1`
- UUIDs
- UTC ISO timestamps
- typed problem errors: code, message, field_errors, request_id
- cursor pagination
- ETag/revision for drafts
- Idempotency-Key for run launch and export generation

### Endpoint groups

- `/me`
- `/workspaces`, members, defaults
- `/projects`, timeline
- `/agents`, versions, clone/archive
- `/templates`, versions, instantiate
- `/projects/{id}/evidence`, upload, PMC/DOI import
- `/evidence/{id}`, chunks
- `/meeting-drafts`, validate, launch
- `/runs`, detail, events, stream, turns, summary, evidence, usage, manifest
- `/runs/{id}/pause|resume|cancel|retry|interventions`
- `/runs/{id}/evaluations`
- `/projects/{id}/comparisons`
- `/projects/{id}/notes`
- `/providers`, test, models, pricing
- `/runs/{id}/exports`, `/exports/{id}`
- `/audit-events`
- health/live, health/ready, health/worker

## Validation estimate

Return base calls, max calls, evidence tokens, estimated input/output tokens, cost or null, pricing completeness, provider checks, errors, warnings, and budget.

## Frontend structure

```text
frontend/src/
  app/
  components/
  features/
    projects/
    agents/
    templates/
    evidence/
    composer/
    live-run/
    run-detail/
    compare/
    notebook/
    providers/
    audit/
  lib/
  pages/
  styles/
```

TanStack Query owns remote state. URL/search params own shareable filters/tabs. Zustand only for transient composer/live layout state.

## Configuration

Pydantic Settings validates environment.

Development auth bypass only when `APP_ENV=development`, never published. Production refuses weak/default encryption key. Demo Provider remains usable without OpenAI key.

## Observability

Structured logs:

- timestamp/level
- request ID
- workspace/project/run IDs
- event/provider/model
- sanitized error code

Do not log research prompts/source content by default. Use IDs/hashes.

Admin operations page:

- worker heartbeat
- queue depth/oldest age
- active runs
- recent failure codes
- provider latency/health
- storage job failures
- migration version

## Scalability path

- separate worker deployment
- multiple workers with leases
- distributed event fanout
- dedicated retrieval/pgvector
- signed storage downloads
- provider/workspace concurrency policies
