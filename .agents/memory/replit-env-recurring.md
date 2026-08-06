---
name: Recurring Replit environment failures
description: Operational quirks that recur in this repl after task merges; check these before debugging app code.
---

- After a task merge, the API workflow often fails with `[Errno 98] address already in use` — a stale uvicorn from the pre-merge process still holds the port. Fix: `fuser -k <port>/tcp`, then restart the workflow. **How to apply:** whenever a workflow fails immediately on startup with a bind error, kill the port before touching code; nothing is wrong with the app.
- A dead backend surfaces in the UI as generic data-loading failures (e.g. "Could not load providers") *and* as silently disabled features whose availability comes from a backend probe endpoint. **Why:** a failed availability query is indistinguishable from "unavailable" in the client. Check workflow health before believing a feature-gating bug.
- Generated API client declarations go stale when backend endpoints change; `npx tsc -b lib/api-client-react` fixes the resulting phantom "has no exported member" type errors in the web artifact.
