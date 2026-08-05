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


class ProviderConfigOut(ORMModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    provider_type: str
    is_enabled: bool
    last_test_status: str | None
    last_test_safe_message: str | None
    models: list[ProviderModelOut] = []


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
