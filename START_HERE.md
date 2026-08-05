# Virtual Lab Studio — Replit Build Pack

This package is meant to be placed at the root of a Replit project imported from:

`https://github.com/zou-group/virtual-lab`

It gives Replit Agent a complete product, UX, architecture, data, security, testing, and implementation contract for building a polished academic web application around the existing Python Virtual Lab meeting engine.

## Recommended sequence

1. Import the upstream GitHub repository into Replit.
2. Upload `Virtual_Lab_Studio_Replit_Build_Pack.zip`.
3. Ask Replit Agent to unzip it into the repository root.
4. Confirm these items are at the root:
   - `MASTER_REPLIT_AGENT_PROMPT.md`
   - `replit.md`
   - `docs/`
   - `specs/`
   - `.agents/skills/virtual-lab-studio-builder/SKILL.md`
5. Paste the entire `MASTER_REPLIT_AGENT_PROMPT.md` into Replit Agent.
6. Approve the integrations Agent requests:
   - Replit PostgreSQL Database.
   - Replit App Storage.
   - Clerk Auth for a fully branded login, or Replit Auth as a development fallback.
   - Replit Secrets for provider keys and the application encryption key.
7. Start with the deterministic Demo Provider so the entire UI can be tested without paid API calls.
8. Add OpenAI or a securely reachable OpenAI-compatible endpoint after the product flow works.
9. Run the automated test suite, inspect the seeded demonstration project, and publish initially as a Reserved VM deployment.

## Important local-model limitation

A Replit-hosted app cannot call `http://localhost:11434` on your personal computer. In that context, `localhost` refers to the Replit server. A local Ollama service must be reachable through a secure authenticated HTTPS gateway/private network arrangement, or the whole application must be self-hosted on the same network. Never expose an unauthenticated Ollama port directly to the public internet.

## What this build pack specifies

- Premium glassmorphic landing page and research workspace.
- Projects, research questions, hypotheses, objectives, constraints, disclosures, and notebook entries.
- Reusable, versioned academic agents and meeting templates.
- Team meetings, individual expert–critic meetings, and ensemble-and-merge runs.
- Six-step meeting composer with team, evidence, providers, budgets, and review.
- Live meeting room with speakers, rounds, tools, source activity, pause/resume, cancel, and human intervention.
- Evidence library for PDF, Markdown, text, PMC search, excerpts, hashes, and stable source IDs.
- Structured final summaries, citations, disagreements, assumptions, risks, next steps, limitations, and review status.
- Run history, comparison, blinded evaluation, usage/cost, provenance manifests, and export packets.
- Workspace roles, tenant isolation, provider secret protection, prompt-injection controls, and audit records.
- A database-backed run worker and event stream suitable for long-running work.
- Seed agents, seed templates, schemas, design tokens, and acceptance tests.

## Source preservation

Keep the upstream `src/virtual_lab` package, MIT license, README citation, and authorship intact. Add the application around the package and refactor through adapters plus compatibility tests. Do not erase or misrepresent the original work.
