---
name: Clerk auth bridge
description: How Clerk identity is bridged into the FastAPI session model; pitfalls for future auth work.
---

The app keeps its own signed session cookie (itsdangerous); Clerk is only the identity source. The browser signs in with `@clerk/react`, then posts the short-lived Clerk session JWT to `POST /api/v1/auth/clerk-login`, which verifies it server-side (JWKS fetched from `api.clerk.com/v1/jwks` using CLERK_SECRET_KEY — works for dev and prod instances) and sets the app cookie.

**Why:** swapping the identity source without rewriting workspace scoping/session code; Clerk skill templates target Express, so the FAPI proxy (`/api/__clerk/*`, production-only) and JWT verification were ported into FastAPI by hand.

**How to apply:**
- Every user (dev-login included) gets a private workspace via `seed.ensure_personal_workspace` — deterministic slug `lab-{user.id.hex[:12]}` makes it idempotent; baseline content comes from `seed.ensure_workspace_baseline`.
- Verifying end-to-end without a browser: Clerk Backend API `POST /users` → `POST /sessions {user_id}` → `POST /sessions/{id}/tokens` yields a real session JWT to exchange.
- Local python httpx to `$REPLIT_DEV_DOMAIN` fails TLS verification (missing CA bundle in venv); use curl or localhost:80 proxy instead.
- Frontend bridge lives in `session.tsx` (Clerk signed-in + /me 401 → one-shot token exchange). Sign-out must clear BOTH the backend cookie and the Clerk session.
