"""Optional Recursive Agent (Beta): schema foundation.

Adds the tables, enums and participant fields needed to delegate a single
meeting turn to an external worker the user runs on their own machine. This
revision is behaviour-neutral: every existing and every new participant
defaults to execution_mode='standard', and nothing reads the new tables yet.

Idempotency note. specs/database_schema.sql is the reviewed DDL contract and
is applied verbatim by 0001_initial_schema, so a from-scratch upgrade creates
these objects in 0001 and reaches this revision with the work already done.
Every statement here is therefore written to be safely re-runnable; on an
existing database it performs the real migration.

Revision ID: 0003_recursive_agents
Revises: 0002_replit_ai_credentialless
"""
from __future__ import annotations

from alembic import op

revision = "0003_recursive_agents"
down_revision = "0002_replit_ai_credentialless"
branch_labels = None
depends_on = None

def _create_trigger_if_absent(table: str) -> None:
    """Attach the shared updated_at trigger, only if it is not already there.

    CREATE OR REPLACE TRIGGER would be shorter but needs PostgreSQL 14+; a
    catalog guard works on any version and keeps this revision a no-op on a
    fresh database, where 0001 has already created the trigger from the spec.
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


NEW_ENUMS: dict[str, tuple[str, ...]] = {
    "agent_execution_mode": ("standard", "recursive_rlm"),
    "recursive_worker_status": ("offline", "online", "degraded", "disabled", "revoked"),
    "recursive_job_status": (
        "queued", "leased", "running", "cancellation_requested",
        "completed", "failed", "cancelled",
    ),
    "recursive_node_status": ("queued", "running", "completed", "failed", "cancelled"),
}

# Mutually exclusive runtimes. A standard participant is executed by a provider
# completion and must name one; a recursive participant is executed by an
# external worker and must name one. Neither may carry the other's fields, so
# the row itself states truthfully which runtime produced the turn.
DEFINITION_AGENT_CHECK = """
    (
      execution_mode = 'standard'
      AND provider_config_id IS NOT NULL
      AND provider_model_id IS NOT NULL
      AND recursive_worker_id IS NULL
      AND recursive_model_key IS NULL
    )
    OR (
      execution_mode = 'recursive_rlm'
      AND provider_config_id IS NULL
      AND provider_model_id IS NULL
      AND recursive_worker_id IS NOT NULL
      AND recursive_model_key IS NOT NULL
    )
"""

RUN_TURN_CHECK = """
    (
      execution_mode = 'standard'
      AND provider_config_id IS NOT NULL
      AND provider_model_id IS NOT NULL
    )
    OR (
      execution_mode = 'recursive_rlm'
      AND provider_config_id IS NULL
      AND provider_model_id IS NULL
    )
"""


def upgrade() -> None:
    # 1. Enum values. ALTER TYPE ... ADD VALUE may run inside a transaction on
    # PostgreSQL 12+, but the new label cannot be *used* in the same
    # transaction, so nothing below may reference 'waiting_external'.
    op.execute("ALTER TYPE run_status ADD VALUE IF NOT EXISTS 'waiting_external'")
    op.execute("ALTER TYPE turn_status ADD VALUE IF NOT EXISTS 'waiting_external'")

    for name, values in NEW_ENUMS.items():
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

    # 2. Workers. Workspace-scoped by requirement: this application has no
    # platform-administrator role, so a deployment-wide worker would have no
    # one able to own, audit or revoke it.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS recursive_workers (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          display_name text NOT NULL,
          status recursive_worker_status NOT NULL DEFAULT 'offline',
          enabled boolean NOT NULL DEFAULT true,
          token_prefix text NOT NULL UNIQUE,
          token_hash text NOT NULL,
          adapter_version text,
          prime_agent_version text,
          sandbox_mode text,
          capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
          model_catalog jsonb NOT NULL DEFAULT '[]'::jsonb,
          last_seen_at timestamptz,
          last_error_safe_message text,
          enrolled_by uuid REFERENCES users(id) ON DELETE SET NULL,
          enrolled_at timestamptz NOT NULL DEFAULT now(),
          disabled_by uuid REFERENCES users(id) ON DELETE SET NULL,
          disabled_at timestamptz,
          revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
          revoked_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS recursive_workers_workspace_idx "
        "ON recursive_workers (workspace_id, status, enabled)"
    )
    _create_trigger_if_absent("recursive_workers")

    # 3. One-time enrollment tokens. The raw token is shown once; only its
    # keyed hash is stored, and consumption is recorded so it cannot be reused.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS recursive_worker_enrollments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          token_prefix text NOT NULL UNIQUE,
          token_hash text NOT NULL,
          requested_display_name text NOT NULL,
          expires_at timestamptz NOT NULL,
          consumed_at timestamptz,
          consumed_worker_id uuid REFERENCES recursive_workers(id) ON DELETE SET NULL,
          created_by uuid REFERENCES users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS recursive_worker_enrollments_workspace_idx "
        "ON recursive_worker_enrollments (workspace_id, expires_at DESC)"
    )

    # 4. Participant execution fields on the immutable snapshot.
    op.execute(
        """
        ALTER TABLE meeting_definition_agents
          ADD COLUMN IF NOT EXISTS execution_mode agent_execution_mode NOT NULL DEFAULT 'standard',
          ADD COLUMN IF NOT EXISTS recursive_worker_id uuid,
          ADD COLUMN IF NOT EXISTS recursive_model_key text,
          ADD COLUMN IF NOT EXISTS recursive_execution_config jsonb NOT NULL DEFAULT '{}'::jsonb
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'meeting_definition_agents_recursive_worker_fk'
          ) THEN
            ALTER TABLE meeting_definition_agents
              ADD CONSTRAINT meeting_definition_agents_recursive_worker_fk
              FOREIGN KEY (recursive_worker_id) REFERENCES recursive_workers(id) ON DELETE RESTRICT;
          END IF;
        END
        $$;
        """
    )
    # Existing rows are all standard and already carry provider ids, so
    # dropping NOT NULL cannot orphan them; the CHECK below re-imposes the
    # requirement for the standard runtime.
    op.execute("ALTER TABLE meeting_definition_agents ALTER COLUMN provider_config_id DROP NOT NULL")
    op.execute("ALTER TABLE meeting_definition_agents ALTER COLUMN provider_model_id DROP NOT NULL")
    op.execute(
        "ALTER TABLE meeting_definition_agents "
        "DROP CONSTRAINT IF EXISTS meeting_definition_agents_runtime_check"
    )
    op.execute(
        "ALTER TABLE meeting_definition_agents "
        "ADD CONSTRAINT meeting_definition_agents_runtime_check "
        f"CHECK ({DEFINITION_AGENT_CHECK})"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS meeting_definition_agents_recursive_worker_idx "
        "ON meeting_definition_agents (recursive_worker_id) WHERE recursive_worker_id IS NOT NULL"
    )

    # 5. Turn execution mode. A recursive turn exists in the transcript from
    # dispatch onward, so it must be creatable without provider columns.
    op.execute(
        "ALTER TABLE run_turns "
        "ADD COLUMN IF NOT EXISTS execution_mode agent_execution_mode NOT NULL DEFAULT 'standard'"
    )
    op.execute("ALTER TABLE run_turns ALTER COLUMN provider_config_id DROP NOT NULL")
    op.execute("ALTER TABLE run_turns ALTER COLUMN provider_model_id DROP NOT NULL")
    op.execute("ALTER TABLE run_turns DROP CONSTRAINT IF EXISTS run_turns_runtime_check")
    op.execute(
        "ALTER TABLE run_turns ADD CONSTRAINT run_turns_runtime_check "
        f"CHECK ({RUN_TURN_CHECK})"
    )

    # 6. Jobs. One logical job per run turn (enforced by the UNIQUE on
    # run_turn_id): a retry reuses this row and increments attempt_count rather
    # than producing a second participant turn.
    #
    # The BETWEEN bounds below are the absolute schema ceiling, deliberately
    # duplicating the deployment policy in config.py one level lower down. The
    # configured hard maxima must stay within these.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS recursive_agent_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          run_turn_id uuid NOT NULL UNIQUE REFERENCES run_turns(id) ON DELETE CASCADE,
          meeting_definition_id uuid NOT NULL REFERENCES meeting_definitions(id) ON DELETE RESTRICT,
          agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
          requested_worker_id uuid REFERENCES recursive_workers(id) ON DELETE RESTRICT,
          leased_worker_id uuid REFERENCES recursive_workers(id) ON DELETE RESTRICT,
          status recursive_job_status NOT NULL DEFAULT 'queued',
          priority integer NOT NULL DEFAULT 100,
          queue_available_at timestamptz NOT NULL DEFAULT now(),
          lease_expires_at timestamptz,
          heartbeat_at timestamptz,
          attempt_count integer NOT NULL DEFAULT 0,
          max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
          cancellation_requested_at timestamptz,
          request_json jsonb NOT NULL,
          request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
          result_json jsonb,
          result_sha256 char(64) CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[a-f0-9]{64}$'),
          model_key text NOT NULL,
          child_model_key text,
          capability_profile text NOT NULL,
          max_children integer NOT NULL,
          max_depth integer NOT NULL,
          max_agent_turns integer NOT NULL,
          max_tokens bigint NOT NULL,
          max_runtime_seconds integer NOT NULL,
          max_cost_usd numeric(16,6),
          model_call_count integer NOT NULL DEFAULT 0,
          input_tokens bigint NOT NULL DEFAULT 0,
          cached_input_tokens bigint NOT NULL DEFAULT 0,
          output_tokens bigint NOT NULL DEFAULT 0,
          cost_usd numeric(16,6) NOT NULL DEFAULT 0,
          started_at timestamptz,
          completed_at timestamptz,
          failure_code text,
          failure_safe_message text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK (max_children BETWEEN 1 AND 8),
          CHECK (max_depth BETWEEN 1 AND 2),
          CHECK (max_agent_turns > 0),
          CHECK (max_tokens > 0),
          CHECK (max_runtime_seconds > 0),
          CHECK (max_cost_usd IS NULL OR max_cost_usd >= 0)
        )
        """
    )
    for name, columns in (
        ("recursive_agent_jobs_queue_idx", "(status, queue_available_at, priority, created_at)"),
        ("recursive_agent_jobs_requested_worker_idx", "(requested_worker_id, status)"),
        ("recursive_agent_jobs_leased_worker_idx", "(leased_worker_id, status)"),
        ("recursive_agent_jobs_lease_idx", "(status, lease_expires_at)"),
        ("recursive_agent_jobs_run_idx", "(run_id)"),
        ("recursive_agent_jobs_workspace_created_idx", "(workspace_id, created_at DESC)"),
    ):
        op.execute(f"CREATE INDEX IF NOT EXISTS {name} ON recursive_agent_jobs {columns}")
    _create_trigger_if_absent("recursive_agent_jobs")

    # 7. Nodes: a safe visualisation record, never a reasoning transcript.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS recursive_agent_nodes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          job_id uuid NOT NULL REFERENCES recursive_agent_jobs(id) ON DELETE CASCADE,
          external_node_id text NOT NULL,
          parent_external_node_id text,
          display_name text NOT NULL,
          status recursive_node_status NOT NULL,
          model_key text,
          task_summary text,
          result_summary text,
          cited_evidence_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
          tool_labels jsonb NOT NULL DEFAULT '[]'::jsonb,
          model_call_count integer NOT NULL DEFAULT 0,
          input_tokens bigint NOT NULL DEFAULT 0,
          cached_input_tokens bigint NOT NULL DEFAULT 0,
          output_tokens bigint NOT NULL DEFAULT 0,
          cost_usd numeric(16,6) NOT NULL DEFAULT 0,
          started_at timestamptz,
          completed_at timestamptz,
          failure_safe_message text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (job_id, external_node_id),
          CHECK (parent_external_node_id IS NULL OR parent_external_node_id <> external_node_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS recursive_agent_nodes_job_idx "
        "ON recursive_agent_nodes (job_id, created_at)"
    )
    _create_trigger_if_absent("recursive_agent_nodes")

    # 8. Worker event idempotency. run_events remains the user-facing stream;
    # this table only absorbs duplicates from a worker retrying a request whose
    # response it never saw.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS recursive_job_events (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          job_id uuid NOT NULL REFERENCES recursive_agent_jobs(id) ON DELETE CASCADE,
          worker_sequence bigint NOT NULL CHECK (worker_sequence >= 0),
          external_event_id text NOT NULL,
          event_type text NOT NULL,
          payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (job_id, worker_sequence),
          UNIQUE (job_id, external_event_id)
        )
        """
    )

    # 9. Run accounting. Additional detail only: provider_call_count remains
    # the total model-call figure so recursive work never reads as zero calls.
    op.execute(
        """
        ALTER TABLE runs
          ADD COLUMN IF NOT EXISTS recursive_job_count integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS recursive_agent_node_count integer NOT NULL DEFAULT 0
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE runs
          DROP COLUMN IF EXISTS recursive_job_count,
          DROP COLUMN IF EXISTS recursive_agent_node_count
        """
    )
    op.execute("ALTER TABLE run_turns DROP CONSTRAINT IF EXISTS run_turns_runtime_check")
    op.execute("DELETE FROM run_turns WHERE execution_mode = 'recursive_rlm'")
    op.execute("ALTER TABLE run_turns DROP COLUMN IF EXISTS execution_mode")
    op.execute("ALTER TABLE run_turns ALTER COLUMN provider_config_id SET NOT NULL")
    op.execute("ALTER TABLE run_turns ALTER COLUMN provider_model_id SET NOT NULL")

    op.execute(
        "ALTER TABLE meeting_definition_agents "
        "DROP CONSTRAINT IF EXISTS meeting_definition_agents_runtime_check"
    )
    op.execute(
        "ALTER TABLE meeting_definition_agents "
        "DROP CONSTRAINT IF EXISTS meeting_definition_agents_recursive_worker_fk"
    )
    op.execute("DROP INDEX IF EXISTS meeting_definition_agents_recursive_worker_idx")
    op.execute("DELETE FROM meeting_definition_agents WHERE execution_mode = 'recursive_rlm'")
    op.execute(
        """
        ALTER TABLE meeting_definition_agents
          DROP COLUMN IF EXISTS execution_mode,
          DROP COLUMN IF EXISTS recursive_worker_id,
          DROP COLUMN IF EXISTS recursive_model_key,
          DROP COLUMN IF EXISTS recursive_execution_config
        """
    )
    op.execute("ALTER TABLE meeting_definition_agents ALTER COLUMN provider_config_id SET NOT NULL")
    op.execute("ALTER TABLE meeting_definition_agents ALTER COLUMN provider_model_id SET NOT NULL")

    for table in (
        "recursive_job_events",
        "recursive_agent_nodes",
        "recursive_agent_jobs",
        "recursive_worker_enrollments",
        "recursive_workers",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    for name in NEW_ENUMS:
        op.execute(f"DROP TYPE IF EXISTS {name}")
    # PostgreSQL cannot remove a value from an enum type. run_status and
    # turn_status keep 'waiting_external' as an unused label; the rows above
    # that could have referenced it are deleted, so nothing is left dangling.
