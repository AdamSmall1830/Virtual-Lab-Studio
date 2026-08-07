---
name: Schema contract and migration rules
description: Why the SQL spec (not the ORM) is the authoritative schema here, and why every migration must be idempotent.
---

# The DDL spec is the schema, not the ORM

The SQL spec under `specs/` is authoritative, and the initial Alembic revision
applies that file **at runtime**. The SQLAlchemy models are a thin mapping over
it: no table args, no unique/check constraints, no delete actions, and metadata
is never used to create tables. Autogenerate is not used.

**Why:** the schema is reviewed as one readable SQL document rather than
reconstructed from decorators.

**How to apply:** do not "fix" the models by declaring constraints on new
tables — that would be inconsistent with every existing table and would enforce
nothing. Constraint drift is therefore invisible to the ORM, so when you add
integrity constraints, add a test that queries the live catalog and asserts
them. The same applies to enum members, which the models declare explicitly.

# Every migration must be idempotent

Because the initial revision applies the spec file verbatim, a from-scratch
upgrade creates your new objects in that first revision and then reaches your
revision with the work already done. Your revision must be a complete no-op on
a fresh database while performing the real migration on an existing one.

**Why:** editing the initial revision rewrites applied history, and a
non-idempotent later revision makes a fresh database unbuildable.

**How to apply:** prove it rather than assume it — run the full upgrade against
a scratch database and diff its catalog against the migrated development
database; they must be identical.

# PostgreSQL enum caveat

Adding an enum label is allowed inside a transaction, but the new label cannot
be *used* in that same transaction. Adding a label and then referencing it in a
backfill or column default in one migration will fail; adding it for later use
is fine.
