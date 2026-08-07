"""Pydantic API schemas."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


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


class RecursiveExecutionConfigIn(BaseModel):
    """Per-participant settings for the optional Recursive Agent runtime.

    Bounds here are the schema ceiling. Deployment and workspace policy is
    applied separately at draft validation, which may only narrow these.
    Capabilities the product does not support are pinned to a literal rather
    than defaulted, so a client cannot request web access or extra skills.
    """

    schema_version: Literal["1.0"] = "1.0"
    capability_profile: Literal["research_read_only"] = "research_read_only"
    requested_worker_id: uuid.UUID
    coordinator_model_key: str = Field(min_length=1, max_length=300)
    child_model_key: str | None = Field(default=None, max_length=300)
    max_children: int = Field(default=3, ge=1, le=8)
    max_depth: int = Field(default=1, ge=1, le=2)
    max_agent_turns: int = Field(default=8, ge=1, le=20)
    max_tokens: int = Field(default=32_000, ge=1)
    max_runtime_seconds: int = Field(default=900, ge=60, le=3600)
    max_cost_usd: float | None = Field(default=2.0, ge=0)
    allow_python: Literal[True] = True
    allow_evidence_search: Literal[True] = True
    allow_web: Literal[False] = False
    allowed_skill_ids: list[Literal["vls_evidence"]] = Field(
        default_factory=lambda: ["vls_evidence"]
    )


class DraftAgentIn(BaseModel):
    position: int = Field(ge=0)
    role_type: Literal["lead", "member", "expert", "critic", "merger"]
    agent_version_id: uuid.UUID
    # Defaults to the standard runtime so a draft written before the recursive
    # feature existed keeps validating and behaving identically.
    execution_mode: Literal["standard", "recursive_rlm"] = "standard"
    provider_config_id: uuid.UUID | None = None
    provider_model_id: uuid.UUID | None = None
    recursive_execution: RecursiveExecutionConfigIn | None = None
    temperature_override: float | None = Field(default=None, ge=0, le=2)
    tool_definition_ids: list[uuid.UUID] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_runtime(self) -> "DraftAgentIn":
        """Require exactly one runtime's fields.

        The provider columns became nullable so a recursive participant can
        exist; this keeps the standard path as strict as it was before, and
        mirrors the database CHECK constraint so a mixed payload is refused
        here with a readable message rather than at insert time.
        """
        if self.execution_mode == "standard":
            missing = [
                name
                for name, value in (
                    ("provider_config_id", self.provider_config_id),
                    ("provider_model_id", self.provider_model_id),
                )
                if value is None
            ]
            if missing:
                raise ValueError(
                    f"standard participant requires {' and '.join(missing)}"
                )
            if self.recursive_execution is not None:
                raise ValueError(
                    "standard participant must not carry recursive_execution"
                )
        else:
            if self.recursive_execution is None:
                raise ValueError(
                    "recursive participant requires recursive_execution"
                )
            if self.provider_config_id is not None or self.provider_model_id is not None:
                raise ValueError(
                    "recursive participant must not carry provider_config_id "
                    "or provider_model_id"
                )
        return self


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
    # Total model calls, including calls reported by recursive jobs. Recursive
    # work is never shown as zero calls merely because it ran elsewhere.
    provider_call_count: int
    tool_call_count: int
    recursive_job_count: int = 0
    recursive_agent_node_count: int = 0
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
    execution_mode: str = "standard"
    response_text: str | None
    finish_reason: str | None
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: int | None
    started_at: datetime | None
    completed_at: datetime | None


# --- Optional Recursive Agent (Beta) ---------------------------------------
# Output shapes for workers, enrollment, jobs and the safe agent tree. None of
# these carry a credential, host path, private address or model reasoning.


# Worker-reported metadata is stored as JSONB, so it is whatever the operator's
# machine chose to send. These models are the allow-list that data passes
# through on the way back out: extra="ignore" means a stray key holding an API
# key, a filesystem path or a private address is dropped rather than echoed to
# every workspace member. The ingest path must validate against these same
# models before storing, so a read can never fail on malformed catalogue data.
StrictJsonModel = ConfigDict(extra="ignore")


class RecursiveModelPricingOut(BaseModel):
    model_config = StrictJsonModel

    input_usd_per_1m: float | None = None
    cached_input_usd_per_1m: float | None = None
    output_usd_per_1m: float | None = None


class RecursiveWorkerModelOut(BaseModel):
    """One entry of a worker's self-reported, non-secret model catalogue."""

    model_config = StrictJsonModel

    model_key: str
    display_name: str
    provider_kind: str
    context_window: int | None = None
    supports_recursive_agents: bool = False
    supports_tools: bool = False
    pricing: RecursiveModelPricingOut = Field(default_factory=RecursiveModelPricingOut)


class RecursiveWorkerCapabilitiesOut(BaseModel):
    """A worker's self-reported capability snapshot."""

    model_config = StrictJsonModel

    sandbox_mode: str | None = None
    supports_recursive_agents: bool = False
    supports_python: bool = False
    supports_evidence_search: bool = False
    allow_web: bool = False
    max_children: int | None = None
    max_depth: int | None = None


class RecursiveWorkerOut(ORMModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    display_name: str
    status: str
    enabled: bool
    # Non-secret lookup handle only; the credential itself is never returned.
    token_prefix: str
    adapter_version: str | None
    prime_agent_version: str | None
    sandbox_mode: str | None
    capabilities: RecursiveWorkerCapabilitiesOut
    model_catalog: list[RecursiveWorkerModelOut]
    last_seen_at: datetime | None
    last_error_safe_message: str | None
    enrolled_at: datetime
    disabled_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime
    updated_at: datetime


class RecursiveWorkerEnrollmentOut(ORMModel):
    """An enrollment record as it can be listed or audited.

    Deliberately carries no token. Only RecursiveWorkerEnrollmentCreatedOut
    does, and only as the immediate response to minting one.
    """

    id: uuid.UUID
    workspace_id: uuid.UUID
    requested_display_name: str
    token_prefix: str
    expires_at: datetime
    consumed_at: datetime | None
    consumed_worker_id: uuid.UUID | None
    created_at: datetime


class RecursiveWorkerEnrollmentCreatedOut(RecursiveWorkerEnrollmentOut):
    """The one-time response to minting an enrollment token.

    enrollment_token is the only moment the raw value exists outside the
    operator's machine: the server stores nothing but its keyed hash, so it
    cannot be shown again. This type must never be used for a list or detail
    response -- use RecursiveWorkerEnrollmentOut for those.
    """

    consumed_at: datetime | None = None
    consumed_worker_id: uuid.UUID | None = None
    enrollment_token: str


class RecursiveAgentNodeOut(ORMModel):
    """Safe visualisation record for one agent in a job's tree."""

    id: uuid.UUID
    job_id: uuid.UUID
    external_node_id: str
    parent_external_node_id: str | None
    display_name: str
    status: str
    model_key: str | None
    task_summary: str | None
    result_summary: str | None
    cited_evidence_keys: list[str]
    tool_labels: list[str]
    model_call_count: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    started_at: datetime | None
    completed_at: datetime | None
    failure_safe_message: str | None


class RecursiveAgentJobOut(ORMModel):
    id: uuid.UUID
    run_id: uuid.UUID
    run_turn_id: uuid.UUID
    agent_version_id: uuid.UUID
    requested_worker_id: uuid.UUID | None
    leased_worker_id: uuid.UUID | None
    status: str
    attempt_count: int
    max_attempts: int
    request_sha256: str
    result_sha256: str | None
    model_key: str
    child_model_key: str | None
    capability_profile: str
    max_children: int
    max_depth: int
    max_agent_turns: int
    max_tokens: int
    max_runtime_seconds: int
    max_cost_usd: float | None
    model_call_count: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    lease_expires_at: datetime | None
    heartbeat_at: datetime | None
    cancellation_requested_at: datetime | None
    started_at: datetime | None
    completed_at: datetime | None
    failure_code: str | None
    failure_safe_message: str | None
    created_at: datetime
    updated_at: datetime


class RecursiveAgentJobDetailOut(BaseModel):
    job: RecursiveAgentJobOut
    nodes: list[RecursiveAgentNodeOut] = Field(default_factory=list)


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


# Optional appendices a PDF report can carry, in the order they are rendered
# and offered. The conclusions record is always included and is not listed here.
# app/pdf_report.py asserts its titles cover exactly these ids.
PDF_REPORT_SECTIONS: tuple[str, ...] = (
    "meeting_brief",
    "question_answers_detail",
    "transcript",
    "final_synthesis",
    "evidence",
    "citations",
    "agents",
    "usage",
    "interventions",
    "reviews",
    "provenance",
)

PdfReportSection = Literal[
    "meeting_brief",
    "question_answers_detail",
    "transcript",
    "final_synthesis",
    "evidence",
    "citations",
    "agents",
    "usage",
    "interventions",
    "reviews",
    "provenance",
]

ExportFormat = Literal["repro_zip", "report_pdf"]


class ExportCreateIn(BaseModel):
    format: ExportFormat = "repro_zip"
    # Only meaningful for report_pdf; the reproducibility packet is defined by
    # its schema and always contains everything.
    sections: list[PdfReportSection] = Field(default_factory=list)


class ExportJobOut(ORMModel):
    id: uuid.UUID
    run_id: uuid.UUID | None
    format: str
    options: dict[str, Any]
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
