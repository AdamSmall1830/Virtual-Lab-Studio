---
name: Real model providers
description: Durable decisions for OpenAI-compatible providers, secret crypto, pricing, and truthful labeling.
---

- Providers are constructed per ProviderConfig (never a hardcoded client in orchestration); the demo provider stays a shared singleton. **Why:** skill invariant — provider protocol + per-config adapters, engine stays provider-agnostic.
- API keys: AES-256-GCM, key HKDF-derived from SESSION_SECRET with a versioned info label (rotate by bumping the version). Keys are write-only through the API; responses expose only a boolean. **Why:** credentials must never reach the browser.
- Zero-key managed source: `routing_policy.credential_source = "replit_ai"` resolves base URL + key from server env at runtime; such rows legitimately have NULL secret/base_url — the provider_configs CHECK constraint explicitly permits this case. **How to apply:** any new credential source needs both a runtime resolver and a constraint carve-out.
- Postgres CHECK constraints pass when the expression is NULL — wrap JSON `->>` lookups in COALESCE or invalid rows slip through silently.
- Model pricing lives in `ProviderModel.capabilities["pricing"]` (per-million input/cached/output); cost estimates mark `pricing_complete=false` rather than pretending unpriced models are free. Provider model rows are never deleted (turns reference them); removal = disable.
- User-supplied base URLs must pass SSRF validation (https, DNS-resolved, private/reserved ranges blocked; private allowed only in development). gpt-5*/o* models reject the `temperature` param.
- Truthful labeling: `run.demo_mode` selects the summary path — simulation summary for demo, a model-generated summary with human-review disclosure (never "[Simulation]") for real runs. Provider failures surface their safe error code/message on the run.
