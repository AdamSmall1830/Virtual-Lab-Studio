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

The two app workflows are already configured and running:

- **API Server** — Express interim backend at `/api` (validates against generated Zod
  schemas, seeds demo data idempotently on boot).
- **web** — the React frontend (Vite), served at the workspace preview root.

Open the preview to use the app. Launch a meeting from **New Meeting**: the built-in
**Demo Provider** runs a complete, deterministic simulated deliberation — free, with no
API keys — and is always visibly labeled "Simulation".

Common commands:

```bash
pnpm --filter @workspace/api-spec run codegen   # regenerate API client + zod after editing lib/api-spec/openapi.yaml
pnpm --filter @workspace/db run push            # apply Drizzle schema changes to PostgreSQL
```

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
