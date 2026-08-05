---
name: Orval zod codegen quirks
description: Constraints when regenerating the API client/zod from openapi.yaml in this monorepo
---

- Orval v8 emits zod v4 API (`zod.int()`), but the workspace catalog pins zod v3. **How to apply:** `lib/api-zod` deliberately depends on `zod@^4` directly (not `catalog:`) — keep it that way or codegen typecheck fails.
- Avoid query parameters on operations in `lib/api-spec/openapi.yaml`: the generated `<Op>Params` zod schema and TS interface collide (TS2308 from the barrel export). The run-events endpoint returns all events; the client filters.
- **Why:** both issues surfaced on the first Virtual Lab Studio codegen (Aug 2026) and cost a debug cycle.
