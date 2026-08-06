---
name: Frontend data layer
description: The root web app must stay single-data-path against the FastAPI backend
---

- Decision: `artifacts/web` has exactly one data path — the FastAPI API via the generated OpenAPI client. The old localStorage demo layer and the duplicate `artifacts/studio` frontend were removed; never reintroduce client-side persistence for server entities or a second frontend.
- **Why:** the project contract requires permanent, auditable server-side state; parallel data paths previously drifted (camelCase spec vs snake_case backend) and caused a duplicate-frontend preview-path conflict.
- **How to apply:** for API changes, treat the FastAPI app as the source of truth for the OpenAPI spec (regenerate, don't hand-edit), then re-run client codegen before touching frontend code.
