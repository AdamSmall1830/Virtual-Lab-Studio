# Specifications Index

These files are implementation contracts for Replit Agent. They are intentionally technology-aware but should be translated into application models, migrations, validation, seeds, and tests rather than copied blindly into runtime code.

| File | Purpose |
|---|---|
| `.env.example` | Required configuration, limits, and safe defaults. Real secrets belong in Replit Secrets. |
| `design_tokens.css` | Dark/light glassmorphic design tokens and accessibility fallbacks. |
| `database_schema.sql` | Logical PostgreSQL contract for SQLAlchemy and Alembic implementation. |
| `meeting_summary.schema.json` | Machine-validated final research synthesis. |
| `run_manifest.schema.json` | Reproducibility/provenance export manifest. |
| `seed_agents.json` | Twelve versioned academic agent profiles. |
| `seed_meeting_templates.json` | Ten versioned academic meeting workflows. |
| `sample_project_import.json` | Neutral seeded materials-science project and draft run. |
| `demo_provider_scenario.json` | Deterministic zero-cost meeting script and valid summary for UI/E2E tests. |

## Implementation notes

- Import seed data idempotently by stable slug.
- Create a new immutable version when seed content changes rather than modifying a version referenced by a completed run.
- Store provider secrets encrypted and never serialize them into API responses or manifests.
- Treat SQL as a logical reference. Implement reviewed Alembic migrations and test upgrade from an empty database.
- Validate final summaries and manifests with Draft 2020-12 JSON Schema.
- The scripted demo scenario is explicitly simulated and must remain labeled in every UI and export.
- Preserve stable evidence IDs such as `DEMO-EVIDENCE-001` so citations can be tested end to end.
