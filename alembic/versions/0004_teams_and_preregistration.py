"""Shared workspaces with spend control, and project pre-registration.

Two changes that only matter once more than one person uses a workspace.

Teams. Membership, roles and role enforcement already existed but were
unreachable: sign-in provisioned a personal workspace and nothing could add a
second person to it. This adds email-bound invitations (stored as a hash, never
a redeemable link), a per-member ceiling on spend drawn from shared provider
keys, and an owner/personal split on provider keys so a member's own key is
their own money and is never metered against the workspace.

Pre-registration. A frozen, hashed statement of hypothesis, protocol and
expected outcome, optionally required per project before any run may launch. A
run records which pre-registration it ran under and that document's hash at
that moment, so a later amendment cannot change what a finished run says it
set out to test.

Idempotency note. specs/database_schema.sql is the reviewed DDL contract and is
applied verbatim by 0001_initial_schema, so a from-scratch upgrade creates
these objects in 0001 and arrives here with the work already done. Every
statement is therefore written to be safely re-runnable; on an existing
database it performs the real migration. Check and foreign-key constraints are
added under the same explicit names the spec uses, so a migrated database and a
freshly built one produce an identical catalog. The one remaining
difference is physical column order, since ALTER TABLE appends while the
spec groups each new column with its neighbours; that has no semantic
effect and both catalogs are otherwise verified line-for-line identical.

Revision ID: 0004_teams_and_preregistration
Revises: 0003_recursive_agents
"""
from __future__ import annotations

from alembic import op

revision = "0004_teams_and_preregistration"
down_revision = "0003_recursive_agents"
branch_labels = None
depends_on = None


NEW_ENUMS: dict[str, tuple[str, ...]] = {
    "provider_scope": ("workspace", "personal"),
    "invitation_status": ("pending", "accepted", "revoked", "expired"),
    "pre_registration_status": ("draft", "registered", "superseded", "withdrawn"),
}


def _create_enum_if_absent(name: str, values: tuple[str, ...]) -> None:
    labels = ", ".join(f"'{v}'" for v in values)
    op.execute(
        f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '{name}') THEN
            CREATE TYPE {name} AS ENUM ({labels});
          END IF;
        END
        $$;
        """
    )


def _create_trigger_if_absent(table: str) -> None:
    """Attach the shared updated_at trigger only if it is not already there.

    CREATE OR REPLACE TRIGGER would be shorter but needs PostgreSQL 14+; a
    catalog guard works on any version and keeps this revision a no-op on a
    fresh database, where 0001 already created the trigger from the spec.
    """
    op.execute(
        f"""
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = '{table}_set_updated_at'
              AND tgrelid = '{table}'::regclass
              AND NOT tgisinternal
          ) THEN
            CREATE TRIGGER {table}_set_updated_at
              BEFORE UPDATE ON {table}
              FOR EACH ROW EXECUTE FUNCTION set_updated_at();
          END IF;
        END
        $$;
        """
    )


def _add_constraint_if_absent(table: str, name: str, definition: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = '{name}' AND conrelid = '{table}'::regclass
          ) THEN
            ALTER TABLE {table} ADD CONSTRAINT {name} {definition};
          END IF;
        END
        $$;
        """
    )


def upgrade() -> None:
    for name, values in NEW_ENUMS.items():
        _create_enum_if_absent(name, values)

    # ---------------------------------------------------------- memberships
    # A per-member ceiling on spend drawn from shared keys. NULL means no
    # ceiling, which is what every existing membership gets: this revision must
    # not silently start refusing launches that worked yesterday.
    op.execute(
        "ALTER TABLE workspace_memberships "
        "ADD COLUMN IF NOT EXISTS spend_limit_usd numeric(12,4)"
    )
    _add_constraint_if_absent(
        "workspace_memberships",
        "workspace_memberships_spend_limit_usd_check",
        "CHECK (spend_limit_usd IS NULL OR spend_limit_usd >= 0)",
    )

    # ---------------------------------------------------------- invitations
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS workspace_invitations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          email text NOT NULL,
          role workspace_role NOT NULL,
          token_hash char(64) NOT NULL UNIQUE,
          status invitation_status NOT NULL DEFAULT 'pending',
          spend_limit_usd numeric(12,4) CHECK (spend_limit_usd IS NULL OR spend_limit_usd >= 0),
          invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
          accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
          expires_at timestamptz NOT NULL,
          accepted_at timestamptz,
          revoked_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT workspace_invitations_role_not_owner CHECK (role <> 'owner'),
          CONSTRAINT workspace_invitations_accepted_fields
            CHECK (status <> 'accepted' OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS workspace_invitations_workspace_idx "
        "ON workspace_invitations (workspace_id, status, created_at DESC)"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_pending_uniq "
        "ON workspace_invitations (workspace_id, lower(email)) WHERE status = 'pending'"
    )
    _create_trigger_if_absent("workspace_invitations")

    # ------------------------------------------------------------- projects
    op.execute(
        "ALTER TABLE projects "
        "ADD COLUMN IF NOT EXISTS pre_registration_required boolean NOT NULL DEFAULT false"
    )

    # ------------------------------------------------------ pre-registration
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS pre_registrations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version integer NOT NULL
            CONSTRAINT pre_registrations_version_positive CHECK (version > 0),
          supersedes_id uuid REFERENCES pre_registrations(id) ON DELETE SET NULL,
          status pre_registration_status NOT NULL DEFAULT 'draft',
          title text NOT NULL,
          hypothesis text NOT NULL,
          protocol text NOT NULL,
          expected_outcomes text NOT NULL,
          success_criteria text NOT NULL DEFAULT '',
          analysis_plan text NOT NULL DEFAULT '',
          amendment_reason text,
          content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
          content_hash char(64),
          registered_at timestamptz,
          registered_by uuid REFERENCES users(id) ON DELETE SET NULL,
          withdrawn_at timestamptz,
          withdrawn_reason text,
          created_by uuid REFERENCES users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (project_id, version),
          CONSTRAINT pre_registrations_freeze_fields CHECK (
            (status = 'draft' AND content_hash IS NULL AND registered_at IS NULL)
            OR (status <> 'draft' AND content_hash IS NOT NULL AND registered_at IS NOT NULL)
          ),
          CONSTRAINT pre_registrations_amendment_reason
            CHECK (supersedes_id IS NULL OR amendment_reason IS NOT NULL),
          CONSTRAINT pre_registrations_withdrawn_fields
            CHECK (status <> 'withdrawn' OR withdrawn_at IS NOT NULL)
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS pre_registrations_active_uniq "
        "ON pre_registrations (project_id) WHERE status = 'registered'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS pre_registrations_project_idx "
        "ON pre_registrations (project_id, version DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS pre_registrations_workspace_idx "
        "ON pre_registrations (workspace_id)"
    )
    _create_trigger_if_absent("pre_registrations")

    # ------------------------------------------------------ provider scoping
    # Existing keys are shared workspace keys, which is what they have always
    # been; the default makes that explicit without touching any row.
    op.execute(
        "ALTER TABLE provider_configs "
        "ADD COLUMN IF NOT EXISTS scope provider_scope NOT NULL DEFAULT 'workspace'"
    )
    op.execute(
        "ALTER TABLE provider_configs "
        "ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE"
    )
    _add_constraint_if_absent(
        "provider_configs",
        "provider_configs_scope_owner_check",
        """CHECK (
             (scope = 'workspace' AND owner_user_id IS NULL)
             OR (scope = 'personal' AND owner_user_id IS NOT NULL)
           )""",
    )
    # The old table-level UNIQUE (workspace_id, name) cannot survive personal
    # keys: two researchers may each want to call theirs "My OpenAI". It is
    # replaced by two partial unique indexes covering the shared and personal
    # namespaces separately, so shared-key names stay as unique as before.
    op.execute(
        "ALTER TABLE provider_configs "
        "DROP CONSTRAINT IF EXISTS provider_configs_workspace_id_name_key"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS provider_configs_workspace_name_uniq "
        "ON provider_configs (workspace_id, name) WHERE owner_user_id IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS provider_configs_personal_name_uniq "
        "ON provider_configs (workspace_id, owner_user_id, name) WHERE owner_user_id IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS provider_configs_owner_idx "
        "ON provider_configs (owner_user_id) WHERE owner_user_id IS NOT NULL"
    )

    # ----------------------------------------------------------------- runs
    op.execute(
        "ALTER TABLE runs ADD COLUMN IF NOT EXISTS "
        "workspace_funded_estimate_usd numeric(16,6) NOT NULL DEFAULT 0"
    )
    op.execute("ALTER TABLE runs ADD COLUMN IF NOT EXISTS pre_registration_id uuid")
    op.execute("ALTER TABLE runs ADD COLUMN IF NOT EXISTS pre_registration_hash char(64)")
    # Named to match what a fresh CREATE TABLE from the spec would generate.
    _add_constraint_if_absent(
        "runs",
        "runs_pre_registration_id_fkey",
        "FOREIGN KEY (pre_registration_id) REFERENCES pre_registrations(id) ON DELETE RESTRICT",
    )


def downgrade() -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_pre_registration_id_fkey")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS pre_registration_hash")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS pre_registration_id")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS workspace_funded_estimate_usd")

    op.execute("DROP INDEX IF EXISTS provider_configs_owner_idx")
    op.execute("DROP INDEX IF EXISTS provider_configs_personal_name_uniq")
    op.execute("DROP INDEX IF EXISTS provider_configs_workspace_name_uniq")
    op.execute(
        "ALTER TABLE provider_configs "
        "DROP CONSTRAINT IF EXISTS provider_configs_scope_owner_check"
    )
    op.execute("ALTER TABLE provider_configs DROP COLUMN IF EXISTS owner_user_id")
    op.execute("ALTER TABLE provider_configs DROP COLUMN IF EXISTS scope")
    _add_constraint_if_absent(
        "provider_configs",
        "provider_configs_workspace_id_name_key",
        "UNIQUE (workspace_id, name)",
    )

    op.execute("DROP TABLE IF EXISTS pre_registrations")
    op.execute("ALTER TABLE projects DROP COLUMN IF EXISTS pre_registration_required")
    op.execute("DROP TABLE IF EXISTS workspace_invitations")
    op.execute(
        "ALTER TABLE workspace_memberships "
        "DROP CONSTRAINT IF EXISTS workspace_memberships_spend_limit_usd_check"
    )
    op.execute("ALTER TABLE workspace_memberships DROP COLUMN IF EXISTS spend_limit_usd")

    for name in NEW_ENUMS:
        op.execute(f"DROP TYPE IF EXISTS {name}")
