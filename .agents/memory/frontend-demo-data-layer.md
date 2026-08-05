---
name: Frontend demo data layer
description: The web frontend runs on a single replaceable client-side demo data path until the backend exists
---

- The web frontend was built before the backend. All app state and simulated run streaming flow through one self-contained demo data layer, deliberately kept as the single data path.
- **Why:** the frontend task shipped ahead of the backend/meeting-engine task, and the pack requires a labeled deterministic Demo Provider experience without paid keys.
- **How to apply:** when the backend lands, replace that demo layer wholesale with the real API + SSE client — do not add a second parallel data path — and keep backend seed data consistent with the seed/scenario JSON under `specs/`.
