---
name: External-worker job broker
description: Durable rules for handing a meeting turn to a worker on the researcher's own machine and taking the result back safely.
---

# External-worker job broker

A participant can be executed by a worker the researcher runs on their own
hardware. The run is *parked* (`waiting_external`) while that happens, and the
native engine loop must not touch it. Three rules were learned the hard way.

## A parked run holds no lease, so the parking fence must be idempotent

Parking releases the native lease in the same owner-conditional UPDATE that
records the parked status. That fence is correct the first time and
*structurally cannot pass* a second time: after parking there is no lease to
release, so the UPDATE matches zero rows.

**Rule:** treat a zero-row fence as "check whether we already reached the
target state" (re-read under the row lock the caller already holds; accept only
parked-and-unowned), not automatically as "another worker stole the run".

**Why:** the engine re-enters dispatch for the same turn on every restart,
duplicate dispatch or resume. Reading zero rows as a lost lease makes every
one of those raise, which looks like lease thrashing and is really the happy
path.

**How to apply:** any owner-conditional fence whose success *destroys the
condition it tests* needs this second read. Rolling back before formatting an
error message expires the ORM object — capture ids into locals first.

## A terminal job must remember which worker produced it

**Rule:** do not clear the leased-worker identity when a job reaches a terminal
state. Clear only the lease *timing* (expiry, heartbeat).

**Why:** a worker whose acknowledgement was lost on the wire will retry the
upload. If the job no longer remembers it, the retry is answered "not found"
instead of "duplicate" — the worker cannot tell a lost ack from a rejected
result, and there is no safe action left for it to take. Retaining the identity
cannot re-hand out the job, because leasing only considers *queued* jobs.

## Never let a worker's self-report become the record verbatim

**Rule:** rebuild capability and model-catalogue JSON field by field from the
worker's report before storing it, and refuse a configuration that exceeds what
the worker advertises rather than clamping it.

**Why:** the worker is an untrusted machine outside the deployment. Its report
carries base URLs and host paths that must never surface in a researcher-facing
record, and a silently narrowed experiment (fewer child agents than requested)
is a research-integrity problem, not a convenience.

## A request size cap cannot live in a dependency

FastAPI reads and JSON-decodes the whole request body **before** it resolves
dependencies, so a body-size check written as a `Depends(...)` runs only after
the memory has already been spent — and after nothing can stop it. Enforce the
cap in an `APIRoute` subclass (`get_route_handler`) or middleware: reject a
declared oversized `Content-Length` outright, and for a chunked upload that
declares nothing, consume `request.stream()` with a running total and abort the
moment it goes over, then assign the buffered bytes to `request._body` so the
normal handler reuses them.

**Why:** any endpoint reachable with a long-lived machine credential is a place
where one compromised token becomes a memory-exhaustion lever. Pydantic field
limits bound what a *valid* payload may contain; they say nothing about what an
attacker can make the server buffer first.

**How to apply:** whenever an endpoint is authenticated by a bearer token
belonging to a machine rather than a person, give it an explicit transport-level
body ceiling, and prove it with a test that sends a chunked body — a
Content-Length-only test passes while the real hole stays open.

## An optional route surface must be unregistered, not just refused

Gating an optional feature's HTTP surface with a dependency that raises 404 is
not the same as the surface being absent. Routing, body decoding and
transport-level size checks all happen before dependencies run, so a probe can
still distinguish a gated path from an unrouted one by the replies that arrive
earlier: 422 for malformed JSON, 413 for an oversized body, and an entry in the
OpenAPI document. Build the app in a `create_app(settings)` factory and include
the router only when the flag is on.

**Why:** the whole promise of an off-by-default feature that accepts machine
credentials is that a deployment which never enabled it reveals nothing.

**How to apply:** keep the module-level `app = create_app()` so `uvicorn
module:app` still works, have tests that need the feature build their own app
from an enabled settings object, and generate the OpenAPI spec with every
optional feature forced on -- the spec is the whole contract, while a deployment
serves a subset, and the frontend must ask the server at runtime what is
available rather than inferring it from the spec.
