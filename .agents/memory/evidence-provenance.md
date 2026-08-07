---
name: Evidence, provenance & exports subsystem
description: Durable design decisions for the evidence library, citations, run manifests, exports, and blinded comparisons.
---

# Evidence, provenance & exports — durable decisions

- **Evidence is frozen at launch, read from the frozen snapshot forever after.**
  A run's citations and manifest read the evidence snapshot captured when the
  meeting launched, never the live library rows. The snapshot lives both in the
  definition JSON and in a relational freeze table (with content hash + chunk
  IDs at freeze time). **Why:** completed-run artifacts must be immutable and
  reproducible; archiving or editing a source later must not change what a
  finished run cited. **Apply:** when adding provenance features, source the
  frozen snapshot, and keep the JSON snapshot and the relational freeze table
  written together in the same launch transaction.

- **Every terminal transition gets a manifest, not just success.** Runs ending
  completed / failed / cancelled / budget_stopped all generate a schema-valid
  manifest via a robust, self-committing ensure path that swallows and reports
  errors instead of aborting the terminal handler. **Why:** reproducibility
  requires a manifest for terminal runs of any outcome, and the finalization
  path must never crash on manifest problems. **Apply:** manifest generation on
  terminal paths must be best-effort-but-logged; backfill must tolerate
  historical/partial rows (null-safe agent/model lookups).

- **An export packet must carry a valid manifest — never a null one.** Export
  creation regenerates/validates the manifest first and fails the export if a
  valid manifest can't be produced. **Why:** a packet with `manifest.json: null`
  violates the reproducibility/integrity contract.

- **The object-storage client needs an explicit bucket_id.**
  `replit.object_storage.Client()` with no args raises DefaultBucketError even
  when DEFAULT_OBJECT_STORAGE_BUCKET_ID is set (it only reads `.replit`). Pass
  the bucket id explicitly and probe at construction so the factory can fall
  back to local dev storage or fail loudly in production.

- **Blinded comparison identity stays server-side.** Blind labels are randomly
  assigned; a run's identity and peers' scores are hidden from a reviewer until
  that reviewer submits their own evaluation (identified sets are always shown).
  **Why:** blinding integrity — no peeking before committing your own scores.

- **Non-scripted fallback summaries cite no evidence**, so a non-scripted demo
  run legitimately produces 0 citations. Only the scripted demo scenario cites
  the seeded demo evidence. Don't treat 0 citations as a bug.

- **A figure this deployment did not measure must say so in its own label.**
  When a record mixes counts the app made with counts an outside machine
  reported, a nearby "we did not observe this" callout is not enough — a reader
  scanning a table sees only the row. Put the qualifier ("Reported model calls")
  in each label, and let the *unqualified* rows be exactly the ones the app can
  attest to. **Apply:** the same rule holds for any aggregate the app computes
  by summing untrusted inputs — the arithmetic is ours, the numbers are not.

- **The DDL contract in specs/database_schema.sql is the source of truth and is
  executed by the single initial migration.** Any *change* to the schema file
  after a database has been stamped needs its own new Alembic revision — the
  initial migration will not re-run. **Apply:** never edit the schema file to
  add tables without also adding a follow-on migration.
