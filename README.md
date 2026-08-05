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

Common commands:

```bash
pnpm --filter @workspace/api-spec run codegen   # regenerate API client + zod after editing lib/api-spec/openapi.yaml
cd backend && .venv/bin/python -m pytest        # run backend test suite
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
the box. Health check: `GET /api/health/ready` returns database + migration status.

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

## Upstream attribution

`src/virtual_lab/`, `LICENSE`, `pyproject.toml`, and `UPSTREAM_README.md` are preserved
from [zou-group/virtual-lab](https://github.com/zou-group/virtual-lab) (MIT, © Kyle
Swanson) at commit `8a3a4fd` and must remain intact.
