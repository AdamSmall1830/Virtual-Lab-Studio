"""SQLAlchemy models mirroring specs/database_schema.sql (subset used by the app).

The authoritative DDL (all tables, enums, triggers, and the claim_next_run
function) is applied by the Alembic migration from specs/database_schema.sql.
These models map the tables the application reads and writes.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CHAR,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    Numeric,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import ENUM, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


_ENUM_VALUES: dict[str, tuple[str, ...]] = {
    "workspace_role": ("owner", "admin", "researcher", "reviewer", "viewer"),
    "project_status": ("active", "paused", "completed", "archived"),
    "agent_visibility": ("workspace", "private", "system"),
    "meeting_kind": ("team", "individual", "ensemble_merge"),
    "provider_kind": ("demo", "openai", "openai_compatible"),
    "evidence_source_kind": (
        "upload_pdf", "upload_markdown", "upload_text", "upload_json", "upload_csv",
        "note", "pmc_article", "web_reference", "prior_run",
    ),
    "evidence_processing_status": ("pending", "processing", "ready", "failed", "quarantined"),
    # NOTE: pg_enum() below declares members explicitly (create_type=False)
    # rather than reflecting them, so every value added to a PostgreSQL enum
    # must be added here in the same change or inserts fail at runtime.
    "run_status": (
        "draft", "queued", "leased", "running", "pausing", "paused",
        "cancelling", "completed", "failed", "cancelled", "budget_stopped",
        "waiting_external",
    ),
    "run_role_type": ("lead", "member", "expert", "critic", "merger"),
    "turn_status": (
        "pending", "streaming", "completed", "failed", "cancelled",
        "waiting_external",
    ),
    "agent_execution_mode": ("standard", "recursive_rlm"),
    "recursive_worker_status": ("offline", "online", "degraded", "disabled", "revoked"),
    "recursive_job_status": (
        "queued", "leased", "running", "cancellation_requested",
        "completed", "failed", "cancelled",
    ),
    "recursive_node_status": ("queued", "running", "completed", "failed", "cancelled"),
    "tool_call_status": ("requested", "approved", "running", "completed", "failed", "denied", "cancelled"),
    "review_status": ("unreviewed", "in_review", "approved", "changes_requested", "rejected"),
    "export_status": ("queued", "running", "completed", "failed", "expired"),
    "evaluation_visibility": ("identified", "blinded"),
    "notebook_entry_kind": ("note", "decision", "hypothesis", "protocol", "result", "follow_up"),
    "intervention_kind": ("pause", "resume", "cancel", "instruction", "evidence_addition", "approval"),
    "citation_support_type": ("supports", "contradicts", "context", "uncertain"),
    "provider_scope": ("workspace", "personal"),
    "invitation_status": ("pending", "accepted", "revoked", "expired"),
    "pre_registration_status": ("draft", "registered", "superseded", "withdrawn"),
}


def pg_enum(name: str) -> ENUM:
    return ENUM(*_ENUM_VALUES[name], name=name, create_type=False)


class Base(DeclarativeBase):
    pass


def uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))


def ts_default() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = uuid_pk()
    auth_provider: Mapped[str] = mapped_column(Text, nullable=False)
    auth_subject: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str | None] = mapped_column(Text)
    avatar_url: Mapped[str | None] = mapped_column(Text)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class Workspace(Base):
    __tablename__ = "workspaces"
    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    settings: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    governance_policy: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class WorkspaceMembership(Base):
    __tablename__ = "workspace_memberships"
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(pg_enum("workspace_role"), nullable=False)
    invited_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    invited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # NULL means no per-member ceiling on workspace-funded spend.
    spend_limit_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class WorkspaceInvitation(Base):
    __tablename__ = "workspace_invitations"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(pg_enum("workspace_role"), nullable=False)
    # Only the hash is stored, so the database never holds a redeemable link.
    token_hash: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    status: Mapped[str] = mapped_column(pg_enum("invitation_status"), server_default=text("'pending'"), nullable=False)
    spend_limit_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    invited_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    accepted_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, server_default=text("''"), nullable=False)
    discipline: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(pg_enum("project_status"), server_default=text("'active'"), nullable=False)
    research_question: Mapped[str | None] = mapped_column(Text)
    hypotheses: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    objectives: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    constraints: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    disclosures: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    human_decision_supported: Mapped[str | None] = mapped_column(Text)
    pre_registration_required: Mapped[bool] = mapped_column(Boolean, server_default=text("false"), nullable=False)
    tags: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class PreRegistration(Base):
    """Frozen statement of what a project set out to test, hashed before any run.

    Editable while ``draft``; once ``registered`` the row is immutable and
    ``content_hash`` covers the canonical JSON. A later change is a new version
    that supersedes this one with a stated reason, so the chain shows whether
    the question moved and when.
    """

    __tablename__ = "pre_registrations"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(pg_enum("pre_registration_status"), server_default=text("'draft'"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    hypothesis: Mapped[str] = mapped_column(Text, nullable=False)
    protocol: Mapped[str] = mapped_column(Text, nullable=False)
    expected_outcomes: Mapped[str] = mapped_column(Text, nullable=False)
    success_criteria: Mapped[str] = mapped_column(Text, server_default=text("''"), nullable=False)
    analysis_plan: Mapped[str] = mapped_column(Text, server_default=text("''"), nullable=False)
    amendment_reason: Mapped[str | None] = mapped_column(Text)
    content_json: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    content_hash: Mapped[str | None] = mapped_column(CHAR(64))
    registered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    registered_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    withdrawn_reason: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class AgentProfile(Base):
    __tablename__ = "agent_profiles"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"))
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, server_default=text("''"), nullable=False)
    category: Mapped[str | None] = mapped_column(Text)
    icon: Mapped[str | None] = mapped_column(Text)
    accent: Mapped[str | None] = mapped_column(Text)
    visibility: Mapped[str] = mapped_column(pg_enum("agent_visibility"), server_default=text("'workspace'"), nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class AgentVersion(Base):
    __tablename__ = "agent_versions"
    id: Mapped[uuid.UUID] = uuid_pk()
    agent_profile_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("agent_profiles.id"), nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    expertise: Mapped[str] = mapped_column(Text, nullable=False)
    goal: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    behavioral_rules: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    system_prompt_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    default_role_type: Mapped[str] = mapped_column(pg_enum("run_role_type"), server_default=text("'member'"), nullable=False)
    default_tool_ids: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    recommended_temperature: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    change_summary: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_default()


class TemplateProfile(Base):
    __tablename__ = "template_profiles"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"))
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, server_default=text("''"), nullable=False)
    category: Mapped[str | None] = mapped_column(Text)
    visibility: Mapped[str] = mapped_column(pg_enum("agent_visibility"), server_default=text("'workspace'"), nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class TemplateVersion(Base):
    __tablename__ = "template_versions"
    id: Mapped[uuid.UUID] = uuid_pk()
    template_profile_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("template_profiles.id"), nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    meeting_type: Mapped[str] = mapped_column(pg_enum("meeting_kind"), nullable=False)
    definition_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    definition_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    change_summary: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_default()


class ProviderConfig(Base):
    __tablename__ = "provider_configs"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    provider_type: Mapped[str] = mapped_column(pg_enum("provider_kind"), nullable=False)
    base_url: Mapped[str | None] = mapped_column(Text)
    organization_id: Mapped[str | None] = mapped_column(Text)
    project_id: Mapped[str | None] = mapped_column(Text)
    secret_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    secret_nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    secret_key_version: Mapped[int | None] = mapped_column(Integer)
    endpoint_fingerprint: Mapped[str | None] = mapped_column(CHAR(64))
    is_enabled: Mapped[bool] = mapped_column(Boolean, server_default=text("true"), nullable=False)
    allow_fallback: Mapped[bool] = mapped_column(Boolean, server_default=text("false"), nullable=False)
    routing_policy: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_test_status: Mapped[str | None] = mapped_column(Text)
    last_test_safe_message: Mapped[str | None] = mapped_column(Text)
    # 'workspace' keys are shared and metered against the launching member's
    # ceiling; 'personal' keys belong to owner_user_id and are never metered.
    scope: Mapped[str] = mapped_column(pg_enum("provider_scope"), server_default=text("'workspace'"), nullable=False)
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class ProviderModel(Base):
    __tablename__ = "provider_models"
    id: Mapped[uuid.UUID] = uuid_pk()
    provider_config_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("provider_configs.id"), nullable=False)
    model_key: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    context_window: Mapped[int | None] = mapped_column(Integer)
    max_output_tokens: Mapped[int | None] = mapped_column(Integer)
    supports_tools: Mapped[bool] = mapped_column(Boolean, server_default=text("false"), nullable=False)
    supports_structured_output: Mapped[bool] = mapped_column(Boolean, server_default=text("false"), nullable=False)
    supports_streaming: Mapped[bool] = mapped_column(Boolean, server_default=text("true"), nullable=False)
    capabilities: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, server_default=text("true"), nullable=False)
    discovered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class ToolDefinition(Base):
    __tablename__ = "tool_definitions"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"))
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    input_schema: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    output_schema: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    handler_key: Mapped[str] = mapped_column(Text, nullable=False)
    policy: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, server_default=text("true"), nullable=False)
    is_system: Mapped[bool] = mapped_column(Boolean, server_default=text("false"), nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class EvidenceSource(Base):
    __tablename__ = "evidence_sources"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"))
    evidence_key: Mapped[str] = mapped_column(Text, nullable=False)
    source_type: Mapped[str] = mapped_column(pg_enum("evidence_source_kind"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    citation: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    external_identifier: Mapped[str | None] = mapped_column(Text)
    author_text: Mapped[str | None] = mapped_column(Text)
    content_type: Mapped[str | None] = mapped_column(Text)
    byte_size: Mapped[int | None] = mapped_column(BigInteger)
    storage_object_key: Mapped[str | None] = mapped_column(Text)
    original_filename: Mapped[str | None] = mapped_column(Text)
    content_sha256: Mapped[str | None] = mapped_column(CHAR(64))
    processing_status: Mapped[str] = mapped_column(pg_enum("evidence_processing_status"), server_default=text("'pending'"), nullable=False)
    processing_error_code: Mapped[str | None] = mapped_column(Text)
    processing_error_safe_message: Mapped[str | None] = mapped_column(Text)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class EvidenceChunk(Base):
    __tablename__ = "evidence_chunks"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    evidence_source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("evidence_sources.id"), nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    locator: Mapped[str | None] = mapped_column(Text)
    heading_path: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    content_text: Mapped[str] = mapped_column(Text, nullable=False)
    content_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    token_count: Mapped[int | None] = mapped_column(Integer)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    created_at: Mapped[datetime] = ts_default()


class MeetingDraft(Base):
    __tablename__ = "meeting_drafts"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    meeting_type: Mapped[str] = mapped_column(pg_enum("meeting_kind"), nullable=False)
    draft_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    last_edited_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class MeetingDefinition(Base):
    __tablename__ = "meeting_definitions"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    meeting_draft_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    template_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    title: Mapped[str] = mapped_column(Text, nullable=False)
    meeting_type: Mapped[str] = mapped_column(pg_enum("meeting_kind"), nullable=False)
    agenda: Mapped[str] = mapped_column(Text, nullable=False)
    questions: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    rules: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    contexts: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    previous_summary_refs: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    rounds: Mapped[int] = mapped_column(Integer, nullable=False)
    default_temperature: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    seed: Mapped[int | None] = mapped_column(BigInteger)
    budget: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    definition_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    definition_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_default()


class MeetingDefinitionAgent(Base):
    __tablename__ = "meeting_definition_agents"
    meeting_definition_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("meeting_definitions.id"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    role_type: Mapped[str] = mapped_column(pg_enum("run_role_type"), nullable=False)
    agent_version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("agent_versions.id"), nullable=False)
    # Provider columns are nullable because a recursive participant is executed
    # by an external worker and has no provider config or model. The database
    # CHECK constraint (see the migration) requires them for standard
    # participants, so nullability here does not weaken the standard path.
    provider_config_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("provider_configs.id"))
    provider_model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("provider_models.id"))
    temperature_override: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    tool_definition_ids: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    execution_mode: Mapped[str] = mapped_column(
        pg_enum("agent_execution_mode"), server_default=text("'standard'"), nullable=False
    )
    recursive_worker_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("recursive_workers.id")
    )
    recursive_model_key: Mapped[str | None] = mapped_column(Text)
    # Frozen at launch into the immutable definition and its hash. Carries only
    # non-secret settings: model keys, limits and capability snapshots — never a
    # worker credential, host path or private address.
    recursive_execution_config: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"), nullable=False
    )


class MeetingDefinitionEvidence(Base):
    __tablename__ = "meeting_definition_evidence"
    meeting_definition_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("meeting_definitions.id"), primary_key=True
    )
    evidence_source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("evidence_sources.id"), primary_key=True
    )
    included_chunk_ids: Mapped[list] = mapped_column(JSONB, nullable=False)
    content_sha256_at_freeze: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    meeting_definition_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("meeting_definitions.id"), nullable=False)
    parent_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(pg_enum("run_status"), server_default=text("'queued'"), nullable=False)
    review_status: Mapped[str] = mapped_column(pg_enum("review_status"), server_default=text("'unreviewed'"), nullable=False)
    demo_mode: Mapped[bool] = mapped_column(Boolean, server_default=text("false"), nullable=False)
    priority: Mapped[int] = mapped_column(Integer, server_default=text("100"), nullable=False)
    queue_available_at: Mapped[datetime] = ts_default()
    lease_owner: Mapped[str | None] = mapped_column(Text)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempt_count: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, server_default=text("3"), nullable=False)
    current_round: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    current_position: Mapped[int | None] = mapped_column(Integer)
    current_agent_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    control_requested: Mapped[str | None] = mapped_column(Text)
    control_requested_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    control_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    provider_call_count: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    tool_call_count: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    # Recursive work counted alongside native work, never instead of it: these
    # are additional detail, while provider_call_count above stays the total
    # model-call figure so a recursive turn never reads as zero calls.
    recursive_job_count: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    recursive_agent_node_count: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    input_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"), nullable=False)
    cached_input_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"), nullable=False)
    output_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"), nullable=False)
    estimated_cost_usd: Mapped[Decimal] = mapped_column(Numeric(16, 6), server_default=text("0"), nullable=False)
    actual_cost_usd: Mapped[Decimal] = mapped_column(Numeric(16, 6), server_default=text("0"), nullable=False)
    # Reservation held against the launching member's monthly ceiling while
    # this run is non-terminal; measured per-turn cost supersedes it.
    workspace_funded_estimate_usd: Mapped[Decimal] = mapped_column(Numeric(16, 6), server_default=text("0"), nullable=False)
    wall_seconds: Mapped[Decimal] = mapped_column(Numeric(16, 3), server_default=text("0"), nullable=False)
    failure_code: Mapped[str | None] = mapped_column(Text)
    failure_safe_message: Mapped[str | None] = mapped_column(Text)
    pre_registration_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    pre_registration_hash: Mapped[str | None] = mapped_column(CHAR(64))
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_default()
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = ts_default()


class RunTurn(Base):
    __tablename__ = "run_turns"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.id"), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    round_number: Mapped[int] = mapped_column(Integer, nullable=False)
    position_in_round: Mapped[int] = mapped_column(Integer, nullable=False)
    agent_version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("agent_versions.id"), nullable=False)
    role_type: Mapped[str] = mapped_column(pg_enum("run_role_type"), nullable=False)
    status: Mapped[str] = mapped_column(pg_enum("turn_status"), server_default=text("'pending'"), nullable=False)
    execution_mode: Mapped[str] = mapped_column(
        pg_enum("agent_execution_mode"), server_default=text("'standard'"), nullable=False
    )
    # Nullable for the same reason as on the participant snapshot: a recursive
    # turn is produced by an external worker, not a provider completion. The
    # CHECK constraint still requires both for a standard turn.
    provider_config_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("provider_configs.id"))
    provider_model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("provider_models.id"))
    provider_request_id: Mapped[str | None] = mapped_column(Text)
    system_prompt_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    request_payload_sha256: Mapped[str | None] = mapped_column(CHAR(64))
    response_text: Mapped[str | None] = mapped_column(Text)
    response_sha256: Mapped[str | None] = mapped_column(CHAR(64))
    finish_reason: Mapped[str | None] = mapped_column(Text)
    input_tokens: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    cached_input_tokens: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(16, 6), server_default=text("0"), nullable=False)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(Text)
    error_safe_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()


class ToolCall(Base):
    __tablename__ = "tool_calls"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.id"), nullable=False)
    run_turn_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("run_turns.id"), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    tool_definition_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tool_definitions.id"), nullable=False)
    provider_tool_call_id: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(pg_enum("tool_call_status"), server_default=text("'requested'"), nullable=False)
    arguments_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    arguments_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    result_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    result_text: Mapped[str | None] = mapped_column(Text)
    result_sha256: Mapped[str | None] = mapped_column(CHAR(64))
    result_truncated: Mapped[bool] = mapped_column(Boolean, server_default=text("false"), nullable=False)
    approval_required: Mapped[bool] = mapped_column(Boolean, server_default=text("false"), nullable=False)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(Text)
    error_safe_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()


class RunEvent(Base):
    __tablename__ = "run_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.id"), nullable=False)
    run_sequence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_default()


class RunIntervention(Base):
    __tablename__ = "run_interventions"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.id"), nullable=False)
    kind: Mapped[str] = mapped_column(pg_enum("intervention_kind"), nullable=False)
    actor_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    content: Mapped[str | None] = mapped_column(Text)
    content_sha256: Mapped[str | None] = mapped_column(CHAR(64))
    evidence_source_ids: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    applied_at_checkpoint: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = ts_default()


class RunSummary(Base):
    __tablename__ = "run_summaries"
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.id"), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    summary_markdown: Mapped[str] = mapped_column(Text, nullable=False)
    summary_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    schema_version: Mapped[str] = mapped_column(Text, nullable=False)
    summary_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    validation_status: Mapped[str] = mapped_column(Text, nullable=False)
    validation_errors: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    created_at: Mapped[datetime] = ts_default()


class RunCitation(Base):
    __tablename__ = "run_citations"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.id"), nullable=False)
    run_turn_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("run_turns.id"))
    evidence_source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("evidence_sources.id"), nullable=False)
    evidence_chunk_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("evidence_chunks.id"))
    citation_key: Mapped[str] = mapped_column(Text, nullable=False)
    claim_text: Mapped[str] = mapped_column(Text, nullable=False)
    support_type: Mapped[str] = mapped_column(pg_enum("citation_support_type"), nullable=False)
    source_locator: Mapped[str | None] = mapped_column(Text)
    validation_status: Mapped[str] = mapped_column(Text, server_default=text("'unvalidated'"), nullable=False)
    validation_notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = ts_default()


class RunManifest(Base):
    __tablename__ = "run_manifests"
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.id"), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    manifest_version: Mapped[str] = mapped_column(Text, nullable=False)
    manifest_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    manifest_payload_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    transcript_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    summary_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    signature: Mapped[str | None] = mapped_column(Text)
    signature_algorithm: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = ts_default()


class RunReview(Base):
    __tablename__ = "run_reviews"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.id"), nullable=False)
    reviewer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    status: Mapped[str] = mapped_column(pg_enum("review_status"), nullable=False)
    rubric_version: Mapped[str | None] = mapped_column(Text)
    ratings: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    comments_markdown: Mapped[str] = mapped_column(Text, server_default=text("''"), nullable=False)
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class ComparisonSet(Base):
    __tablename__ = "comparison_sets"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, server_default=text("''"), nullable=False)
    visibility: Mapped[str] = mapped_column(pg_enum("evaluation_visibility"), server_default=text("'identified'"), nullable=False)
    rubric: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class ComparisonItem(Base):
    __tablename__ = "comparison_items"
    comparison_set_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("comparison_sets.id"), primary_key=True)
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.id"), primary_key=True)
    blind_label: Mapped[str | None] = mapped_column(Text)
    display_order: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)


class ComparisonEvaluation(Base):
    __tablename__ = "comparison_evaluations"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    comparison_set_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("comparison_sets.id"), nullable=False)
    evaluator_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    item_scores: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    ranking: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"), nullable=False)
    comments_markdown: Mapped[str] = mapped_column(Text, server_default=text("''"), nullable=False)
    submitted_at: Mapped[datetime] = ts_default()


class ExportJob(Base):
    __tablename__ = "export_jobs"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"))
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.id"))
    requested_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    format: Mapped[str] = mapped_column(Text, nullable=False)
    options: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    status: Mapped[str] = mapped_column(pg_enum("export_status"), server_default=text("'queued'"), nullable=False)
    storage_object_key: Mapped[str | None] = mapped_column(Text)
    byte_size: Mapped[int | None] = mapped_column(BigInteger)
    sha256: Mapped[str | None] = mapped_column(CHAR(64))
    error_code: Mapped[str | None] = mapped_column(Text)
    error_safe_message: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    action: Mapped[str] = mapped_column(Text, nullable=False)
    object_type: Mapped[str] = mapped_column(Text, nullable=False)
    object_id: Mapped[str | None] = mapped_column(Text)
    request_id: Mapped[str | None] = mapped_column(Text)
    ip_hash: Mapped[str | None] = mapped_column(Text)
    user_agent_hash: Mapped[str | None] = mapped_column(Text)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    created_at: Mapped[datetime] = ts_default()


# ---------------------------------------------------------------------------
# Optional Recursive Agent (Beta)
#
# A participant may optionally be executed by an external worker the user runs
# on their own machine. The worker never receives database credentials and
# never imports this application; it authenticates with its own bearer
# credential over outbound HTTPS. Nothing below stores a raw credential, and
# nothing below stores a node's private reasoning transcript.
# ---------------------------------------------------------------------------


class RecursiveWorker(Base):
    """An external machine enrolled to execute recursive participant turns.

    Workspace-scoped by requirement: the application's authorization model has
    no platform-administrator role, so a deployment-wide worker would have no
    one able to own, audit or revoke it.
    """

    __tablename__ = "recursive_workers"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False
    )
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        pg_enum("recursive_worker_status"), server_default=text("'offline'"), nullable=False
    )
    enabled: Mapped[bool] = mapped_column(Boolean, server_default=text("true"), nullable=False)
    # Non-secret lookup handle plus the keyed hash of the credential. The raw
    # credential is shown to the operator once at enrollment and never stored.
    token_prefix: Mapped[str] = mapped_column(Text, nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    adapter_version: Mapped[str | None] = mapped_column(Text)
    prime_agent_version: Mapped[str | None] = mapped_column(Text)
    sandbox_mode: Mapped[str | None] = mapped_column(Text)
    capabilities: Mapped[dict[str, Any]] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"), nullable=False
    )
    # Self-reported, non-secret model metadata only. Must never carry API keys,
    # provider headers, filesystem paths or private network addresses.
    model_catalog: Mapped[list] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb"), nullable=False
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error_safe_message: Mapped[str | None] = mapped_column(Text)
    enrolled_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    enrolled_at: Mapped[datetime] = ts_default()
    disabled_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class RecursiveWorkerEnrollment(Base):
    """A one-time token exchanged for a worker's long-lived credential."""

    __tablename__ = "recursive_worker_enrollments"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False
    )
    token_prefix: Mapped[str] = mapped_column(Text, nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    requested_display_name: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consumed_worker_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("recursive_workers.id")
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at: Mapped[datetime] = ts_default()


class RecursiveAgentJob(Base):
    """One recursive participant turn delegated to a worker.

    Exactly one logical job per run turn: retries reuse this row and increment
    attempt_count rather than creating a second participant turn.
    """

    __tablename__ = "recursive_agent_jobs"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False
    )
    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("runs.id"), nullable=False)
    run_turn_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("run_turns.id"), nullable=False, unique=True
    )
    meeting_definition_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("meeting_definitions.id"), nullable=False
    )
    agent_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_versions.id"), nullable=False
    )
    requested_worker_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("recursive_workers.id")
    )
    leased_worker_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("recursive_workers.id")
    )
    status: Mapped[str] = mapped_column(
        pg_enum("recursive_job_status"), server_default=text("'queued'"), nullable=False
    )
    priority: Mapped[int] = mapped_column(Integer, server_default=text("100"), nullable=False)
    queue_available_at: Mapped[datetime] = ts_default()
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempt_count: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, server_default=text("3"), nullable=False)
    cancellation_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Canonical request the worker executes, plus its hash. Completion is
    # rejected unless the worker echoes this hash back, so a result can never
    # be attached to a request it did not run.
    request_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    request_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    result_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    result_sha256: Mapped[str | None] = mapped_column(CHAR(64))
    model_key: Mapped[str] = mapped_column(Text, nullable=False)
    child_model_key: Mapped[str | None] = mapped_column(Text)
    capability_profile: Mapped[str] = mapped_column(Text, nullable=False)
    max_children: Mapped[int] = mapped_column(Integer, nullable=False)
    max_depth: Mapped[int] = mapped_column(Integer, nullable=False)
    max_agent_turns: Mapped[int] = mapped_column(Integer, nullable=False)
    max_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False)
    max_runtime_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    max_cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(16, 6))
    model_call_count: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    input_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"), nullable=False)
    cached_input_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"), nullable=False)
    output_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"), nullable=False)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(16, 6), server_default=text("0"), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_code: Mapped[str | None] = mapped_column(Text)
    failure_safe_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class RecursiveAgentNode(Base):
    """Safe visualisation record for one agent in a job's coordinator tree.

    Deliberately not a reasoning transcript: summaries, labels, timings and
    usage only, so the live tree and the exported record stay free of hidden
    chain-of-thought.
    """

    __tablename__ = "recursive_agent_nodes"
    id: Mapped[uuid.UUID] = uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=False
    )
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("recursive_agent_jobs.id"), nullable=False
    )
    external_node_id: Mapped[str] = mapped_column(Text, nullable=False)
    parent_external_node_id: Mapped[str | None] = mapped_column(Text)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(pg_enum("recursive_node_status"), nullable=False)
    model_key: Mapped[str | None] = mapped_column(Text)
    task_summary: Mapped[str | None] = mapped_column(Text)
    result_summary: Mapped[str | None] = mapped_column(Text)
    cited_evidence_keys: Mapped[list] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb"), nullable=False
    )
    tool_labels: Mapped[list] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb"), nullable=False
    )
    model_call_count: Mapped[int] = mapped_column(Integer, server_default=text("0"), nullable=False)
    input_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"), nullable=False)
    cached_input_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"), nullable=False)
    output_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"), nullable=False)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(16, 6), server_default=text("0"), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_safe_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = ts_default()
    updated_at: Mapped[datetime] = ts_default()


class RecursiveJobEvent(Base):
    """Idempotency record for worker-submitted events.

    run_events remains the user-facing stream; this table only absorbs the
    duplicates a worker produces when it retries an HTTP request it never saw
    the response to.
    """

    __tablename__ = "recursive_job_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("recursive_agent_jobs.id"), nullable=False
    )
    worker_sequence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    external_event_id: Mapped[str] = mapped_column(Text, nullable=False)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    created_at: Mapped[datetime] = ts_default()
