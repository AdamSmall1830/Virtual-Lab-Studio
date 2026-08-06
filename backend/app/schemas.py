"""Pydantic API schemas."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class UserOut(ORMModel):
    id: uuid.UUID
    email: str
    display_name: str | None
    avatar_url: str | None


class MembershipOut(ORMModel):
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    role: str


class WorkspaceOut(ORMModel):
    id: uuid.UUID
    name: str
    slug: str
    created_at: datetime


class MeOut(BaseModel):
    user: UserOut
    memberships: list[MembershipOut]
    workspaces: list[WorkspaceOut]


class DevLoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    display_name: str | None = Field(default=None, max_length=200)


class ProjectCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=10000)
    discipline: str | None = Field(default=None, max_length=200)
    research_question: str | None = Field(default=None, max_length=2000)
    human_decision_supported: str | None = Field(default=None, max_length=2000)
    hypotheses: list[str] = Field(default_factory=list, max_length=25)
    objectives: list[str] = Field(default_factory=list, max_length=25)
    constraints: list[str] = Field(default_factory=list, max_length=25)
    tags: list[str] = Field(default_factory=list, max_length=25)


class ProjectOut(ORMModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    slug: str
    name: str
    description: str
    discipline: str | None
    status: str
    research_question: str | None
    human_decision_supported: str | None
    tags: list
    created_at: datetime
    updated_at: datetime


class AgentVersionOut(ORMModel):
    id: uuid.UUID
    agent_profile_id: uuid.UUID
    version_number: int
    expertise: str
    goal: str
    role: str
    behavioral_rules: list
    system_prompt: str
    system_prompt_sha256: str
    default_role_type: str
    default_tool_ids: list
    recommended_temperature: float | None
    created_at: datetime


class AgentProfileOut(ORMModel):
    id: uuid.UUID
    workspace_id: uuid.UUID | None
    slug: str
    title: str
    description: str
    category: str | None
    icon: str | None
    accent: str | None
    visibility: str
    latest_version: AgentVersionOut | None = None


class TemplateVersionOut(ORMModel):
    id: uuid.UUID
    template_profile_id: uuid.UUID
    version_number: int
    meeting_type: str
    definition_json: dict[str, Any]
    definition_sha256: str
    created_at: datetime


class TemplateProfileOut(ORMModel):
    id: uuid.UUID
    workspace_id: uuid.UUID | None
    slug: str
    name: str
    description: str
    category: str | None
    visibility: str
    latest_version: TemplateVersionOut | None = None


class ProviderModelOut(ORMModel):
    id: uuid.UUID
    provider_config_id: uuid.UUID
    model_key: str
    display_name: str
    supports_tools: bool
    supports_structured_output: bool
    supports_streaming: bool
    is_enabled: bool
    input_per_million: float | None = None
    cached_input_per_million: float | None = None
    output_per_million: float | None = None


class ProviderConfigOut(ORMModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    provider_type: str
    base_url: str | None = None
    is_enabled: bool
    credential_source: str = "api_key"
    has_credentials: bool = False
    last_tested_at: datetime | None = None
    last_test_status: str | None
    last_test_safe_message: str | None
    models: list[ProviderModelOut] = []


class ProviderModelIn(BaseModel):
    model_key: str = Field(min_length=1, max_length=200)
    display_name: str | None = Field(default=None, max_length=200)
    input_per_million: float | None = Field(default=None, ge=0)
    cached_input_per_million: float | None = Field(default=None, ge=0)
    output_per_million: float | None = Field(default=None, ge=0)
    is_enabled: bool = True


class ProviderCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    provider_type: Literal["openai", "openai_compatible"]
    base_url: str | None = Field(default=None, max_length=2000)
    api_key: str | None = Field(default=None, min_length=1, max_length=4000)
    credential_source: Literal["api_key", "replit_ai"] = "api_key"
    organization_id: str | None = Field(default=None, max_length=200)
    models: list[ProviderModelIn] = Field(default_factory=list, max_length=25)


class ProviderUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    base_url: str | None = Field(default=None, max_length=2000)
    api_key: str | None = Field(default=None, min_length=1, max_length=4000)
    is_enabled: bool | None = None
    models: list[ProviderModelIn] | None = Field(default=None, max_length=25)


class ProviderTestOut(BaseModel):
    status: str
    message: str
    tested_model: str | None = None
    latency_ms: int | None = None


class ProviderEnvironmentOut(BaseModel):
    replit_ai_available: bool


class DraftAgentIn(BaseModel):
    position: int = Field(ge=0)
    role_type: Literal["lead", "member", "expert", "critic", "merger"]
    agent_version_id: uuid.UUID
    provider_config_id: uuid.UUID
    provider_model_id: uuid.UUID
    temperature_override: float | None = Field(default=None, ge=0, le=2)
    tool_definition_ids: list[uuid.UUID] = []


class MeetingDraftIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    meeting_type: Literal["team", "individual"]
    agenda: str = Field(min_length=1)
    questions: list[str] = []
    rules: list[str] = []
    contexts: list[str] = []
    rounds: int = Field(default=2, ge=1, le=12)
    default_temperature: float = Field(default=0.2, ge=0, le=2)
    budget: dict[str, Any] = Field(default_factory=lambda: {"max_provider_calls": 40, "max_cost_usd": 5.0})
    agents: list[DraftAgentIn] = []
    template_version_id: uuid.UUID | None = None
    evidence_source_ids: list[uuid.UUID] = []


class MeetingDraftOut(ORMModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    title: str
    meeting_type: str
    draft_json: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class ValidationEstimateOut(BaseModel):
    valid: bool
    errors: list[dict[str, str]]
    warnings: list[dict[str, str]]
    base_calls: int | None
    max_calls: int | None
    estimated_input_tokens: int | None
    estimated_output_tokens: int | None
    estimated_cost_usd: float | None
    pricing_complete: bool
    budget: dict[str, Any]


class LaunchOut(BaseModel):
    run_id: uuid.UUID
    meeting_definition_id: uuid.UUID
    status: str


class RunOut(ORMModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    meeting_definition_id: uuid.UUID
    status: str
    review_status: str
    demo_mode: bool
    current_round: int
    provider_call_count: int
    tool_call_count: int
    input_tokens: int
    output_tokens: int
    actual_cost_usd: float
    wall_seconds: float
    failure_code: str | None
    failure_safe_message: str | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class RunTurnOut(ORMModel):
    id: uuid.UUID
    run_id: uuid.UUID
    sequence: int
    round_number: int
    position_in_round: int
    agent_version_id: uuid.UUID
    role_type: str
    status: str
    response_text: str | None
    finish_reason: str | None
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: int | None
    started_at: datetime | None
    completed_at: datetime | None


class RunEventOut(ORMModel):
    id: int
    run_id: uuid.UUID
    run_sequence: int
    event_type: str
    payload: dict[str, Any]
    created_at: datetime


class RunSummaryOut(ORMModel):
    run_id: uuid.UUID
    summary_markdown: str
    summary_json: dict[str, Any]
    schema_version: str
    summary_sha256: str
    validation_status: str
    validation_errors: list
    created_at: datetime


class EvidenceSourceOut(ORMModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID | None
    evidence_key: str
    source_type: str
    title: str
    citation: str | None
    source_url: str | None
    external_identifier: str | None
    author_text: str | None
    content_type: str | None
    byte_size: int | None
    original_filename: str | None
    content_sha256: str | None
    processing_status: str
    processing_error_code: str | None
    processing_error_safe_message: str | None
    created_at: datetime


class EvidenceChunkOut(ORMModel):
    id: uuid.UUID
    evidence_source_id: uuid.UUID
    chunk_index: int
    locator: str | None
    content_text: str
    content_sha256: str
    token_count: int | None


class EvidenceNoteIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=100_000)
    citation: str | None = None
    source_url: str | None = None


class EvidenceSearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=10, ge=1, le=25)


class EvidenceSearchHit(BaseModel):
    evidence_source_id: uuid.UUID
    evidence_key: str
    title: str
    chunk_id: uuid.UUID
    chunk_index: int
    locator: str | None
    snippet: str


class PmcSearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=10, ge=1, le=25)


class PmcImportIn(BaseModel):
    pmcid: str = Field(min_length=3, max_length=20)


class RunCitationOut(ORMModel):
    id: uuid.UUID
    run_id: uuid.UUID
    evidence_source_id: uuid.UUID
    citation_key: str
    claim_text: str
    support_type: str
    source_locator: str | None
    validation_status: str
    validation_notes: str | None


class RunManifestOut(ORMModel):
    run_id: uuid.UUID
    manifest_version: str
    manifest_json: dict[str, Any]
    manifest_payload_sha256: str
    transcript_sha256: str
    summary_sha256: str
    created_at: datetime


class RunReviewIn(BaseModel):
    status: Literal["in_review", "approved", "changes_requested", "rejected"]
    rubric_version: str | None = None
    ratings: dict[str, int] = {}
    comments_markdown: str = Field(default="", max_length=20_000)


class RunReviewOut(ORMModel):
    id: uuid.UUID
    run_id: uuid.UUID
    reviewer_id: uuid.UUID
    status: str
    rubric_version: str | None
    ratings: dict[str, Any]
    comments_markdown: str
    created_at: datetime
    updated_at: datetime


class ExportJobOut(ORMModel):
    id: uuid.UUID
    run_id: uuid.UUID | None
    format: str
    status: str
    byte_size: int | None
    sha256: str | None
    error_code: str | None
    error_safe_message: str | None
    created_at: datetime
    completed_at: datetime | None


class ComparisonCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    run_ids: list[uuid.UUID] = Field(min_length=2, max_length=4)
    rubric_criteria: list[str] = Field(
        default_factory=lambda: [
            "Scientific plausibility",
            "Use of evidence",
            "Clarity of recommendation",
            "Identification of risks",
        ],
        min_length=1,
        max_length=10,
    )


class ComparisonItemOut(BaseModel):
    blind_label: str
    display_order: int
    # run identity is only revealed when the comparison is not blinded for the caller
    run_id: uuid.UUID | None = None
    run_title: str | None = None
    summary_json: dict[str, Any] | None = None
    summary_markdown: str | None = None
    # Always sent, blinded or not. Neither field identifies the run, and a
    # reviewer must never rank simulated output, or a summary that failed schema
    # validation, as though it were a real finding.
    demo_mode: bool = False
    validation_status: str | None = None


class ComparisonSetOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    description: str
    visibility: str
    rubric: dict[str, Any]
    created_at: datetime
    items: list[ComparisonItemOut] = []
    evaluation_count: int = 0
    my_evaluation_submitted: bool = False
    revealed: bool = False


class ComparisonEvaluationIn(BaseModel):
    # {"A": {"criterion": score 1-5, ...}, "B": {...}}
    item_scores: dict[str, dict[str, int]]
    ranking: list[str] = []
    comments_markdown: str = Field(default="", max_length=20_000)


class ComparisonEvaluationOut(ORMModel):
    id: uuid.UUID
    comparison_set_id: uuid.UUID
    evaluator_id: uuid.UUID
    item_scores: dict[str, Any]
    ranking: list
    comments_markdown: str
    submitted_at: datetime


class InterventionIn(BaseModel):
    kind: Literal["instruction", "evidence_addition"]
    content: str = Field(min_length=1, max_length=8000)
    evidence_source_ids: list[uuid.UUID] = []


class InterventionOut(ORMModel):
    id: uuid.UUID
    run_id: uuid.UUID
    kind: str
    content: str | None
    applied_at_checkpoint: str | None
    created_at: datetime
