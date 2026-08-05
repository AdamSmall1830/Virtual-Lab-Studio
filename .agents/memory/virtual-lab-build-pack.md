---
name: Virtual Lab Studio build pack
description: Where the product contract lives and how upstream source was obtained
---

- The product contract for Virtual Lab Studio is in root files: `MASTER_REPLIT_AGENT_PROMPT.md`, `replit.md`, `docs/`, `specs/`, and `.agents/skills/virtual-lab-studio-builder/SKILL.md`. Read those before major work; they override generic defaults (FastAPI + Python runtime is authoritative, not TypeScript).
- The workspace was NOT imported from GitHub, so upstream `zou-group/virtual-lab` was cloned manually (2026-08-05, commit 8a3a4fd9ccc0cd297bd523751e03bc9527c91832) into `src/virtual_lab/`, with `LICENSE`, `pyproject.toml`, and `UPSTREAM_README.md` at root. **Why:** the pack requires the upstream MIT source, license, and citation preserved intact; never delete or rewrite `src/virtual_lab/`.
- Root `pyproject.toml` is the upstream package's own file — keep it aligned with the upstream package, not repurposed for the app backend.
