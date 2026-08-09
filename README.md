# Virtual Lab Studio

A human-guided, multi-agent academic research workspace built around the open-source
[Virtual Lab](https://github.com/zou-group/virtual-lab) meeting engine (Zou Group, MIT
license; Nature 2025, "The Virtual Lab of AI agents designs new SARS-CoV-2 nanobodies").

A researcher assembles a team of model-driven research roles (a lead, specialists, a
scientific critic), poses a research agenda, and watches a structured multi-round meeting
unfold live — ending in an evidence-linked structured synthesis that preserves
disagreements and states confidence honestly.

> Virtual Lab Studio supports human-guided research deliberation. Its agents are
> model-driven roles, not independent human experts. Outputs may contain errors and do
> not replace experimental validation, peer review, ethics review, clinical judgment, or
> other qualified professional oversight.

## Documentation map

| Read this | For |
|---|---|
| `docs/CURRENT_IMPLEMENTATION.md` | **How the platform works today** — architecture, API, data model, demo run engine, operations |
| `MASTER_REPLIT_AGENT_PROMPT.md` | The full product contract and target architecture |
| `docs/PRODUCT_AND_UX.md` | Product surfaces, UX rules, design direction |
| `docs/TECHNICAL_ARCHITECTURE.md` | Target (FastAPI) runtime architecture |
| `docs/CORE_INTEGRATION.md` | How upstream `src/virtual_lab` concepts map into the product |
| `docs/SECURITY_GOVERNANCE.md` | Security, authorization, and governance rules |
| `docs/WORKER_SECURITY_MODEL.md` | The trust boundary for recursive agents — what an external worker can and cannot do |
| `docs/WORKER_SETUP.md` | Running the bridge worker on your own Windows/GPU machine with local models |
| `docs/SOURCE_ATTRIBUTION.md` | Upstream attribution requirements |
| `specs/` | Database schema, design tokens, seed data, JSON schemas, env example |
| `replit.md` | Project context and implementation status for agents working here |

## Quick start (in this Replit workspace)

The app workflows are already configured and running:

- **API Server** — FastAPI (Python) backend at `/api` (`backend/`). On startup it
  provisions its own virtualenv, applies Alembic migrations, and seeds baseline
  agents/templates idempotently, so a fresh database comes up fully working.
- **web** — the React frontend (Vite), served at the workspace preview root.

Open the preview to use the app. Launch a meeting from **New Meeting**: the built-in
**Demo Provider** runs a complete, deterministic simulated deliberation — free, with no
API keys — and is always visibly labeled "Simulation".

### Real AI providers

Real model providers work end-to-end. In **Settings → Providers & Models**, anyone can
add an **OpenAI** or **OpenAI-compatible** provider with their own API key (keys are
write-only: encrypted server-side, never returned to the browser). Register models with
per-million-token pricing, then pick the provider and model in the meeting composer's
**Advanced Controls** — validation shows the call count and a real cost estimate, and
per-run call/cost budget caps are enforced at every checkpoint.

Only demo runs are labeled "Simulation"; real runs carry a human-review disclosure
instead.

Optional environment variables (`backend/app/config.py` is the source of truth):

| Variable | Purpose |
|---|---|
| `AI_INTEGRATIONS_OPENAI_BASE_URL` / `AI_INTEGRATIONS_OPENAI_API_KEY` | Replit AI Integrations proxy — powers the zero-key "Replit AI" provider option. Empty = option unavailable. |
| `REPLIT_AI_ALLOWED_EMAILS` | Comma-separated emails allowed to use the zero-key Replit AI option (it bills the workspace owner's Replit credits). Empty = nobody. |

### Recursive agents (optional, off by default)

A meeting seat can be executed by a **bridge worker** on your own machine — your GPU, your
local models, your electricity — instead of by a hosted provider. The studio never runs
agent-generated code: it queues the turn, and the worker on your hardware picks it up over
an outbound connection. Nothing listens on your machine and nothing dials into it.

Turning it on requires `RECURSIVE_AGENTS_ENABLED=true` and a random
`RECURSIVE_WORKER_TOKEN_PEPPER` of at least 32 characters (the backend refuses to start
with a short one rather than quietly disabling the feature). With the flag off, the
recursive routes are not registered at all — they 404 like any unknown URL and do not
appear in the OpenAPI document.

- `docs/WORKER_SETUP.md` — the Windows + local-GPU walkthrough
- `docs/WORKER_SECURITY_MODEL.md` — what the studio does and does not trust a worker to do
- `worker/README.md` — the worker's own reference and configuration schema

Because the work happens on a machine this deployment cannot observe, the record says so:
every run manifest carries a `recursive_execution` block (`job_count: 0` on an ordinary
meeting), the export packet always ships the recursive files bound by manifest digests,
and the PDF's optional **Recursive execution** appendix states in print what the
deployment can and cannot attest to.

Common commands:

```bash
pnpm --filter @workspace/api-spec run codegen   # regenerate API client + zod after editing lib/api-spec/openapi.yaml
cd backend && .venv/bin/python -m pytest        # run backend test suite
backend/.venv/bin/python backend/scripts/export_openapi.py   # regenerate openapi.yaml from FastAPI
```

## Running locally (outside Replit)

You can fork/clone this repository and run it on any machine. Requirements:

- **Node.js 20+** and **pnpm 9+** (frontend monorepo)
- **Python 3.13** with [`uv`](https://docs.astral.sh/uv/) (or plain `venv` + pip)
- **PostgreSQL 15+** with a database you can connect to

Steps:

```bash
# 1. Install JS dependencies
pnpm install

# 2. Provision the Python backend environment
bash backend/ensure_venv.sh

# 3. Configure environment variables
export DATABASE_URL="postgresql://user:pass@localhost:5432/virtual_lab"
export SESSION_SECRET="$(openssl rand -hex 32)"
export APP_ENV=development          # enables dev login and non-secure cookies

# 4. Start the backend (applies migrations + seed automatically on boot)
backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000

# 5. Start the frontend (separate terminal)
pnpm --filter @workspace/web run dev
```

Then open the Vite dev URL it prints. The **Demo Provider** requires no API keys —
you can launch, pause, intervene in, and resume complete simulated meetings out of
the box. To run real meetings, add an OpenAI or OpenAI-compatible provider with your
own API key in **Settings → Providers & Models** (no environment variables required).
Health check: `GET /api/health/ready` returns database + migration status.

Notes:

- `APP_ENV` defaults to `production`, which enforces secure cookies and refuses
  weak session secrets — set `APP_ENV=development` for local work.
- The backend expects to own the database schema (Alembic migrations run at
  startup); point it at an empty database the first time.

## Meeting mechanics (upstream-faithful)

- **Team meeting** — R rounds of (lead, then each of M members), plus one final lead
  synthesis: `R × (M + 1) + 1` model calls.
- **Individual expert–critic meeting** — R rounds of (expert, then critic), plus a final
  expert revision: `2R + 1` calls.
- Roles are role-conditioned model calls sharing one transcript — agreement between roles
  is not independent validation, and the UI/methodology page says so explicitly.

## Relationship to the upstream project

This repository is **not** a fork of
[zou-group/virtual-lab](https://github.com/zou-group/virtual-lab). It is a separate
application that vendors the upstream package **unmodified** under `src/virtual_lab/`
and builds around it. Nothing here is contributed back upstream, and nothing needs to
be: not a line of the upstream tree is changed.
`backend/tests/test_upstream_compat.py` enforces that — it fails if any file under
`src/virtual_lab/` is added, removed, or altered.

Product-side adaptations always live outside that directory. If a change to the
upstream package itself ever becomes worthwhile, it does not belong in this repo:
fork upstream separately, rebase a minimal focused branch on upstream `main`, and open
the PR from that fork. Patching the vendored copy in place would silently break the
compatibility guarantee this repo depends on.

**What we use, precisely.** The engine imports upstream's `Agent` class and its prompt
templates and uses them as-is; the meeting structure and system-prompt behavior are
upstream's, and `test_upstream_compat.py` pins the exact call order and content.
Orchestration is ours — the Studio runs its own loop so a meeting can be paused
mid-deliberation, redirected, resumed, checkpointed per turn, and survive a worker
restart, none of which a single call-through to upstream's `run_meeting` supports.

## Attribution and licensing

`src/virtual_lab/`, `LICENSE`, `pyproject.toml`, and `UPSTREAM_README.md` are preserved
from [zou-group/virtual-lab](https://github.com/zou-group/virtual-lab) (MIT, © Kyle
Swanson) at commit `8a3a4fd` and must remain intact.

The two bodies of work carry two separate MIT license files, so neither party's
copyright notice can be mistaken for covering the other's code:

| File | Covers | Copyright |
| --- | --- | --- |
| `LICENSE` | `src/virtual_lab/` (vendored upstream) | © 2026 Kyle Swanson and the Virtual Lab contributors |
| `LICENSE-STUDIO` | everything else in this repository | © 2026 Adam Small |

See `NOTICE` for the full boundary between them.
