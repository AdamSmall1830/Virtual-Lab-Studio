"""Initial Virtual Lab Studio schema, applied from specs/database_schema.sql.

The reviewed DDL contract in specs/database_schema.sql is the source of truth
for the initial schema (enums, tables, triggers, indexes, and the
claim_next_run queue function). Subsequent revisions must be generated from
the SQLAlchemy models.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-08-05
"""
from pathlib import Path

from alembic import op

revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None

SPEC_SQL = Path(__file__).resolve().parents[2] / "specs" / "database_schema.sql"

ENUM_TYPES = [
    "workspace_role", "project_status", "agent_visibility", "meeting_kind",
    "provider_kind", "evidence_source_kind", "evidence_processing_status",
    "run_status", "run_role_type", "turn_status", "tool_call_status",
    "review_status", "export_status", "evaluation_visibility",
    "notebook_entry_kind", "intervention_kind", "citation_support_type",
]

TABLES = [
    "audit_events", "export_jobs", "comparison_evaluations", "comparison_items",
    "comparison_sets", "run_reviews", "run_manifests", "run_summaries",
    "run_citations", "run_interventions", "run_events", "tool_calls",
    "run_turns", "run_ensemble_members", "runs", "meeting_definition_evidence",
    "meeting_definition_agents", "meeting_definitions", "meeting_drafts",
    "evidence_chunks", "evidence_sources", "tool_definitions",
    "model_pricing_versions", "provider_models", "provider_configs",
    "template_versions", "template_profiles", "agent_versions",
    "agent_profiles", "project_notebook_entries", "projects",
    "workspace_memberships", "workspaces", "users",
]


def upgrade() -> None:
    sql = SPEC_SQL.read_text()
    # Alembic manages the transaction; strip the explicit wrapper.
    lines = [
        line for line in sql.splitlines()
        if line.strip() not in {"BEGIN;", "COMMIT;"}
    ]
    op.execute("\n".join(lines))


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS claim_next_run(text, integer)")
    op.execute(
        "ALTER TABLE IF EXISTS project_notebook_entries DROP CONSTRAINT IF EXISTS notebook_source_run_fk"
    )
    for table in TABLES:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    op.execute("DROP FUNCTION IF EXISTS set_updated_at() CASCADE")
    for enum in ENUM_TYPES:
        op.execute(f"DROP TYPE IF EXISTS {enum}")
