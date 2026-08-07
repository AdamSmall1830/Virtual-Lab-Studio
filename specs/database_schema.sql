-- Virtual Lab Studio — logical PostgreSQL schema
-- Reference contract for SQLAlchemy models and Alembic migrations.
-- Generate Alembic revisions from the application models; do not use this file
-- as a substitute for reviewed migrations in production.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'researcher', 'reviewer', 'viewer');
CREATE TYPE project_status AS ENUM ('active', 'paused', 'completed', 'archived');
CREATE TYPE agent_visibility AS ENUM ('workspace', 'private', 'system');
CREATE TYPE meeting_kind AS ENUM ('team', 'individual', 'ensemble_merge');
CREATE TYPE provider_kind AS ENUM ('demo', 'openai', 'openai_compatible');
CREATE TYPE evidence_source_kind AS ENUM (
  'upload_pdf', 'upload_markdown', 'upload_text', 'upload_json', 'upload_csv',
  'note', 'pmc_article', 'web_reference', 'prior_run'
);
CREATE TYPE evidence_processing_status AS ENUM ('pending', 'processing', 'ready', 'failed', 'quarantined');
CREATE TYPE run_status AS ENUM (
  'draft', 'queued', 'leased', 'running', 'pausing', 'paused',
  'cancelling', 'completed', 'failed', 'cancelled', 'budget_stopped',
  'waiting_external'
);
CREATE TYPE run_role_type AS ENUM ('lead', 'member', 'expert', 'critic', 'merger');
CREATE TYPE turn_status AS ENUM (
  'pending', 'streaming', 'completed', 'failed', 'cancelled', 'waiting_external'
);
CREATE TYPE tool_call_status AS ENUM ('requested', 'approved', 'running', 'completed', 'failed', 'denied', 'cancelled');
CREATE TYPE review_status AS ENUM ('unreviewed', 'in_review', 'approved', 'changes_requested', 'rejected');
CREATE TYPE export_status AS ENUM ('queued', 'running', 'completed', 'failed', 'expired');
CREATE TYPE evaluation_visibility AS ENUM ('identified', 'blinded');
CREATE TYPE notebook_entry_kind AS ENUM ('note', 'decision', 'hypothesis', 'protocol', 'result', 'follow_up');
CREATE TYPE intervention_kind AS ENUM ('pause', 'resume', 'cancel', 'instruction', 'evidence_addition', 'approval');
CREATE TYPE citation_support_type AS ENUM ('supports', 'contradicts', 'context', 'uncertain');

-- Optional Recursive Agent (Beta). A participant may be executed by an
-- external worker the user runs on their own machine instead of by a direct
-- provider completion.
CREATE TYPE agent_execution_mode AS ENUM ('standard', 'recursive_rlm');
CREATE TYPE recursive_worker_status AS ENUM ('offline', 'online', 'degraded', 'disabled', 'revoked');
CREATE TYPE recursive_job_status AS ENUM (
  'queued', 'leased', 'running', 'cancellation_requested',
  'completed', 'failed', 'cancelled'
);
CREATE TYPE recursive_node_status AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_provider text NOT NULL,
  auth_subject text NOT NULL,
  email text NOT NULL,
  display_name text,
  avatar_url text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auth_provider, auth_subject)
);
CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  governance_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER workspaces_set_updated_at
  BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role workspace_role NOT NULL,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  invited_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_memberships_user_idx ON workspace_memberships (user_id);
CREATE TRIGGER workspace_memberships_set_updated_at
  BEFORE UPDATE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  discipline text,
  status project_status NOT NULL DEFAULT 'active',
  research_question text,
  hypotheses jsonb NOT NULL DEFAULT '[]'::jsonb,
  objectives jsonb NOT NULL DEFAULT '[]'::jsonb,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  disclosures jsonb NOT NULL DEFAULT '[]'::jsonb,
  human_decision_supported text,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);
CREATE INDEX projects_workspace_status_idx ON projects (workspace_id, status, updated_at DESC);
CREATE INDEX projects_search_idx ON projects USING gin (
  to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(research_question, ''))
);
CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE project_notebook_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind notebook_entry_kind NOT NULL DEFAULT 'note',
  title text NOT NULL,
  body_markdown text NOT NULL,
  source_run_id uuid,
  parent_entry_id uuid REFERENCES project_notebook_entries(id) ON DELETE SET NULL,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notebook_project_created_idx ON project_notebook_entries (project_id, created_at DESC);
CREATE INDEX notebook_workspace_idx ON project_notebook_entries (workspace_id);
CREATE TRIGGER notebook_entries_set_updated_at
  BEFORE UPDATE ON project_notebook_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE agent_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text,
  icon text,
  accent text,
  visibility agent_visibility NOT NULL DEFAULT 'workspace',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_profiles_workspace_slug_uniq
  ON agent_profiles (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
CREATE INDEX agent_profiles_workspace_idx ON agent_profiles (workspace_id, archived_at);
CREATE TRIGGER agent_profiles_set_updated_at
  BEFORE UPDATE ON agent_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  expertise text NOT NULL,
  goal text NOT NULL,
  role text NOT NULL,
  behavioral_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  system_prompt text NOT NULL,
  system_prompt_sha256 char(64) NOT NULL CHECK (system_prompt_sha256 ~ '^[a-f0-9]{64}$'),
  default_role_type run_role_type NOT NULL DEFAULT 'member',
  default_tool_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_temperature numeric(4,3) CHECK (recommended_temperature BETWEEN 0 AND 2),
  change_summary text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_profile_id, version_number)
);
CREATE INDEX agent_versions_profile_created_idx ON agent_versions (agent_profile_id, created_at DESC);

CREATE TABLE template_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text,
  visibility agent_visibility NOT NULL DEFAULT 'workspace',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX template_profiles_workspace_slug_uniq
  ON template_profiles (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
CREATE TRIGGER template_profiles_set_updated_at
  BEFORE UPDATE ON template_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_profile_id uuid NOT NULL REFERENCES template_profiles(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  meeting_type meeting_kind NOT NULL,
  definition_json jsonb NOT NULL,
  definition_sha256 char(64) NOT NULL CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
  change_summary text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_profile_id, version_number)
);

CREATE TABLE provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider_type provider_kind NOT NULL,
  base_url text,
  organization_id text,
  project_id text,
  secret_ciphertext bytea,
  secret_nonce bytea,
  secret_key_version integer,
  endpoint_fingerprint char(64),
  is_enabled boolean NOT NULL DEFAULT true,
  allow_fallback boolean NOT NULL DEFAULT false,
  routing_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_tested_at timestamptz,
  last_test_status text,
  last_test_safe_message text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name),
  CHECK (
    provider_type = 'demo'
    OR (secret_ciphertext IS NOT NULL AND secret_nonce IS NOT NULL AND base_url IS NOT NULL)
  )
);
CREATE INDEX provider_configs_workspace_idx ON provider_configs (workspace_id, is_enabled);
CREATE TRIGGER provider_configs_set_updated_at
  BEFORE UPDATE ON provider_configs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE provider_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_config_id uuid NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model_key text NOT NULL,
  display_name text NOT NULL,
  context_window integer CHECK (context_window > 0),
  max_output_tokens integer CHECK (max_output_tokens > 0),
  supports_tools boolean NOT NULL DEFAULT false,
  supports_structured_output boolean NOT NULL DEFAULT false,
  supports_streaming boolean NOT NULL DEFAULT true,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled boolean NOT NULL DEFAULT true,
  discovered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_config_id, model_key)
);
CREATE TRIGGER provider_models_set_updated_at
  BEFORE UPDATE ON provider_models FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE model_pricing_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_model_id uuid NOT NULL REFERENCES provider_models(id) ON DELETE CASCADE,
  currency char(3) NOT NULL DEFAULT 'USD',
  input_per_million numeric(16,6),
  cached_input_per_million numeric(16,6),
  output_per_million numeric(16,6),
  source_label text,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX pricing_model_effective_idx ON model_pricing_versions (provider_model_id, effective_from DESC);

CREATE TABLE tool_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  description text NOT NULL,
  input_schema jsonb NOT NULL,
  output_schema jsonb,
  handler_key text NOT NULL,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tool_definitions_workspace_slug_version_uniq
  ON tool_definitions (
    coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    slug,
    version
  );
CREATE TRIGGER tool_definitions_set_updated_at
  BEFORE UPDATE ON tool_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE evidence_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  evidence_key text NOT NULL,
  source_type evidence_source_kind NOT NULL,
  title text NOT NULL,
  citation text,
  source_url text,
  external_identifier text,
  author_text text,
  publication_date date,
  retrieval_date timestamptz,
  content_type text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  storage_object_key text,
  original_filename text,
  content_sha256 char(64) CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),
  processing_status evidence_processing_status NOT NULL DEFAULT 'pending',
  processing_error_code text,
  processing_error_safe_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, evidence_key)
);
CREATE INDEX evidence_workspace_project_idx ON evidence_sources (workspace_id, project_id, created_at DESC);
CREATE INDEX evidence_status_idx ON evidence_sources (workspace_id, processing_status);
CREATE INDEX evidence_source_search_idx ON evidence_sources USING gin (
  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(citation, '') || ' ' || coalesce(author_text, ''))
);
CREATE TRIGGER evidence_sources_set_updated_at
  BEFORE UPDATE ON evidence_sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE evidence_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  evidence_source_id uuid NOT NULL REFERENCES evidence_sources(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  locator text,
  heading_path jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_text text NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  token_count integer CHECK (token_count IS NULL OR token_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evidence_source_id, chunk_index)
);
CREATE INDEX evidence_chunks_workspace_idx ON evidence_chunks (workspace_id, evidence_source_id);
CREATE INDEX evidence_chunks_search_idx ON evidence_chunks USING gin (to_tsvector('english', content_text));

-- An external machine enrolled to execute recursive participant turns.
-- Workspace-scoped by requirement: the authorization model has no platform
-- administrator, so a deployment-wide worker would have no one able to own,
-- audit or revoke it. Only the keyed hash of a credential is ever stored.
CREATE TABLE recursive_workers (
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
  -- Self-reported, non-secret model metadata only. Never API keys, provider
  -- headers, filesystem paths or private network addresses.
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
);
CREATE INDEX recursive_workers_workspace_idx ON recursive_workers (workspace_id, status, enabled);
CREATE TRIGGER recursive_workers_set_updated_at
  BEFORE UPDATE ON recursive_workers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One-time enrollment tokens. The raw token is shown to the operator once;
-- after enrollment the worker holds a separate long-lived credential.
CREATE TABLE recursive_worker_enrollments (
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
);
CREATE INDEX recursive_worker_enrollments_workspace_idx
  ON recursive_worker_enrollments (workspace_id, expires_at DESC);

CREATE TABLE meeting_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  meeting_type meeting_kind NOT NULL,
  draft_json jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_edited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_drafts_project_idx ON meeting_drafts (project_id, updated_at DESC);
CREATE TRIGGER meeting_drafts_set_updated_at
  BEFORE UPDATE ON meeting_drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A definition is a frozen, immutable snapshot used for a run.
CREATE TABLE meeting_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  meeting_draft_id uuid REFERENCES meeting_drafts(id) ON DELETE SET NULL,
  template_version_id uuid REFERENCES template_versions(id) ON DELETE SET NULL,
  title text NOT NULL,
  meeting_type meeting_kind NOT NULL,
  agenda text NOT NULL,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  contexts jsonb NOT NULL DEFAULT '[]'::jsonb,
  previous_summary_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  rounds integer NOT NULL CHECK (rounds BETWEEN 1 AND 12),
  default_temperature numeric(4,3) NOT NULL CHECK (default_temperature BETWEEN 0 AND 2),
  seed bigint,
  budget jsonb NOT NULL,
  definition_json jsonb NOT NULL,
  definition_sha256 char(64) NOT NULL CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_definitions_project_idx ON meeting_definitions (project_id, created_at DESC);
CREATE UNIQUE INDEX meeting_definitions_hash_project_uniq ON meeting_definitions (project_id, definition_sha256);

CREATE TABLE meeting_definition_agents (
  meeting_definition_id uuid NOT NULL REFERENCES meeting_definitions(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  role_type run_role_type NOT NULL,
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  -- Provider columns are nullable because a recursive participant is executed
  -- by an external worker and has no provider config or model. The runtime
  -- CHECK below re-imposes the requirement for the standard runtime.
  provider_config_id uuid REFERENCES provider_configs(id) ON DELETE RESTRICT,
  provider_model_id uuid REFERENCES provider_models(id) ON DELETE RESTRICT,
  temperature_override numeric(4,3) CHECK (temperature_override BETWEEN 0 AND 2),
  tool_definition_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  execution_mode agent_execution_mode NOT NULL DEFAULT 'standard',
  recursive_worker_id uuid REFERENCES recursive_workers(id) ON DELETE RESTRICT,
  recursive_model_key text,
  -- Frozen into definition_json and definition_sha256 at launch. Non-secret
  -- settings only: model keys, limits and capability snapshots.
  recursive_execution_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (meeting_definition_id, position),
  -- Mutually exclusive runtimes, so the row states truthfully which one
  -- executes the turn and neither can carry the other's fields.
  CONSTRAINT meeting_definition_agents_runtime_check CHECK (
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
  )
);
CREATE INDEX meeting_definition_agents_recursive_worker_idx
  ON meeting_definition_agents (recursive_worker_id) WHERE recursive_worker_id IS NOT NULL;
CREATE UNIQUE INDEX meeting_definition_single_lead_idx
  ON meeting_definition_agents (meeting_definition_id)
  WHERE role_type = 'lead';
CREATE UNIQUE INDEX meeting_definition_single_expert_idx
  ON meeting_definition_agents (meeting_definition_id)
  WHERE role_type = 'expert';
CREATE UNIQUE INDEX meeting_definition_single_merger_idx
  ON meeting_definition_agents (meeting_definition_id)
  WHERE role_type = 'merger';

CREATE TABLE meeting_definition_evidence (
  meeting_definition_id uuid NOT NULL REFERENCES meeting_definitions(id) ON DELETE CASCADE,
  evidence_source_id uuid NOT NULL REFERENCES evidence_sources(id) ON DELETE RESTRICT,
  included_chunk_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_sha256_at_freeze char(64) NOT NULL CHECK (content_sha256_at_freeze ~ '^[a-f0-9]{64}$'),
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (meeting_definition_id, evidence_source_id)
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  meeting_definition_id uuid NOT NULL REFERENCES meeting_definitions(id) ON DELETE RESTRICT,
  parent_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  status run_status NOT NULL DEFAULT 'queued',
  review_status review_status NOT NULL DEFAULT 'unreviewed',
  demo_mode boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 100,
  queue_available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  current_round integer NOT NULL DEFAULT 0,
  current_position integer,
  current_agent_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL,
  control_requested text,
  control_requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  control_requested_at timestamptz,
  provider_call_count integer NOT NULL DEFAULT 0,
  tool_call_count integer NOT NULL DEFAULT 0,
  -- Recursive work counted alongside native work, never instead of it:
  -- provider_call_count stays the total model-call figure so a recursive turn
  -- never reads as zero calls merely because it ran on another machine.
  recursive_job_count integer NOT NULL DEFAULT 0,
  recursive_agent_node_count integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(16,6) NOT NULL DEFAULT 0,
  actual_cost_usd numeric(16,6) NOT NULL DEFAULT 0,
  wall_seconds numeric(16,3) NOT NULL DEFAULT 0,
  failure_code text,
  failure_safe_message text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);
ALTER TABLE project_notebook_entries
  ADD CONSTRAINT notebook_source_run_fk
  FOREIGN KEY (source_run_id) REFERENCES runs(id) ON DELETE SET NULL;
CREATE INDEX runs_queue_idx ON runs (status, queue_available_at, priority, created_at);
CREATE INDEX runs_workspace_project_idx ON runs (workspace_id, project_id, created_at DESC);
CREATE INDEX runs_lease_idx ON runs (status, lease_expires_at);
CREATE INDEX runs_parent_idx ON runs (parent_run_id);
CREATE TRIGGER runs_set_updated_at
  BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE run_ensemble_members (
  parent_run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  child_run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  member_index integer NOT NULL CHECK (member_index >= 0),
  PRIMARY KEY (parent_run_id, child_run_id),
  UNIQUE (parent_run_id, member_index),
  CHECK (parent_run_id <> child_run_id)
);

CREATE TABLE run_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  round_number integer NOT NULL CHECK (round_number >= 0),
  position_in_round integer NOT NULL CHECK (position_in_round >= 0),
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  role_type run_role_type NOT NULL,
  status turn_status NOT NULL DEFAULT 'pending',
  execution_mode agent_execution_mode NOT NULL DEFAULT 'standard',
  -- Nullable for the same reason as on meeting_definition_agents: a recursive
  -- turn is produced by an external worker, not a provider completion, and it
  -- exists in the transcript from dispatch onward.
  provider_config_id uuid REFERENCES provider_configs(id) ON DELETE RESTRICT,
  provider_model_id uuid REFERENCES provider_models(id) ON DELETE RESTRICT,
  provider_request_id text,
  system_prompt_sha256 char(64) NOT NULL CHECK (system_prompt_sha256 ~ '^[a-f0-9]{64}$'),
  request_payload_sha256 char(64) CHECK (request_payload_sha256 IS NULL OR request_payload_sha256 ~ '^[a-f0-9]{64}$'),
  response_text text,
  response_sha256 char(64) CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[a-f0-9]{64}$'),
  finish_reason text,
  input_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(16,6) NOT NULL DEFAULT 0,
  latency_ms integer,
  error_code text,
  error_safe_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence),
  CONSTRAINT run_turns_runtime_check CHECK (
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
  )
);
CREATE INDEX run_turns_run_sequence_idx ON run_turns (run_id, sequence);
CREATE INDEX run_turns_workspace_idx ON run_turns (workspace_id, created_at DESC);

-- One recursive participant turn delegated to an external worker. Exactly one
-- logical job per run turn: a retry reuses this row and increments
-- attempt_count rather than producing a second participant turn.
-- The BETWEEN bounds are the absolute schema ceiling; the deployment policy
-- limits in backend/app/config.py must stay within them.
CREATE TABLE recursive_agent_jobs (
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
  -- Canonical request the worker executes, plus its hash. A completion is
  -- rejected unless the worker echoes this hash back, so a result can never be
  -- attached to a request it did not run.
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
);
CREATE INDEX recursive_agent_jobs_queue_idx
  ON recursive_agent_jobs (status, queue_available_at, priority, created_at);
CREATE INDEX recursive_agent_jobs_requested_worker_idx
  ON recursive_agent_jobs (requested_worker_id, status);
CREATE INDEX recursive_agent_jobs_leased_worker_idx
  ON recursive_agent_jobs (leased_worker_id, status);
CREATE INDEX recursive_agent_jobs_lease_idx ON recursive_agent_jobs (status, lease_expires_at);
CREATE INDEX recursive_agent_jobs_run_idx ON recursive_agent_jobs (run_id);
CREATE INDEX recursive_agent_jobs_workspace_created_idx
  ON recursive_agent_jobs (workspace_id, created_at DESC);
CREATE TRIGGER recursive_agent_jobs_set_updated_at
  BEFORE UPDATE ON recursive_agent_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Safe visualisation record for one agent in a job's coordinator tree.
-- Deliberately not a reasoning transcript: summaries, labels, timings and
-- usage only, so the live tree and the exported record stay free of hidden
-- chain-of-thought.
CREATE TABLE recursive_agent_nodes (
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
);
CREATE INDEX recursive_agent_nodes_job_idx ON recursive_agent_nodes (job_id, created_at);
CREATE TRIGGER recursive_agent_nodes_set_updated_at
  BEFORE UPDATE ON recursive_agent_nodes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Idempotency record for worker-submitted events. run_events remains the
-- user-facing stream; this table only absorbs the duplicates a worker produces
-- when it retries a request whose response it never saw.
CREATE TABLE recursive_job_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES recursive_agent_jobs(id) ON DELETE CASCADE,
  worker_sequence bigint NOT NULL CHECK (worker_sequence >= 0),
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, worker_sequence),
  UNIQUE (job_id, external_event_id)
);

CREATE TABLE tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_turn_id uuid NOT NULL REFERENCES run_turns(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  tool_definition_id uuid NOT NULL REFERENCES tool_definitions(id) ON DELETE RESTRICT,
  provider_tool_call_id text,
  status tool_call_status NOT NULL DEFAULT 'requested',
  arguments_json jsonb NOT NULL,
  arguments_sha256 char(64) NOT NULL CHECK (arguments_sha256 ~ '^[a-f0-9]{64}$'),
  result_json jsonb,
  result_text text,
  result_sha256 char(64) CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[a-f0-9]{64}$'),
  result_truncated boolean NOT NULL DEFAULT false,
  approval_required boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  error_code text,
  error_safe_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_turn_id, sequence)
);
CREATE INDEX tool_calls_run_idx ON tool_calls (run_id, created_at);
CREATE INDEX tool_calls_workspace_idx ON tool_calls (workspace_id, created_at DESC);

-- Durable event log used for SSE replay. Payloads must be secret-free and workspace-safe.
CREATE TABLE run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_sequence bigint NOT NULL CHECK (run_sequence > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, run_sequence)
);
CREATE INDEX run_events_replay_idx ON run_events (run_id, run_sequence);
CREATE INDEX run_events_workspace_created_idx ON run_events (workspace_id, created_at DESC);

CREATE TABLE run_interventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind intervention_kind NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  content text,
  content_sha256 char(64) CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_source_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  applied_at_checkpoint text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_interventions_run_idx ON run_interventions (run_id, created_at);

CREATE TABLE run_citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_turn_id uuid REFERENCES run_turns(id) ON DELETE CASCADE,
  evidence_source_id uuid NOT NULL REFERENCES evidence_sources(id) ON DELETE RESTRICT,
  evidence_chunk_id uuid REFERENCES evidence_chunks(id) ON DELETE RESTRICT,
  citation_key text NOT NULL,
  claim_text text NOT NULL,
  support_type citation_support_type NOT NULL,
  source_locator text,
  validation_status text NOT NULL DEFAULT 'unvalidated',
  validation_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_citations_run_idx ON run_citations (run_id, citation_key);
CREATE INDEX run_citations_source_idx ON run_citations (evidence_source_id);

CREATE TABLE run_summaries (
  run_id uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  summary_markdown text NOT NULL,
  summary_json jsonb NOT NULL,
  schema_version text NOT NULL,
  summary_sha256 char(64) NOT NULL CHECK (summary_sha256 ~ '^[a-f0-9]{64}$'),
  validation_status text NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_summaries_workspace_idx ON run_summaries (workspace_id, created_at DESC);

CREATE TABLE run_manifests (
  run_id uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  manifest_version text NOT NULL,
  manifest_json jsonb NOT NULL,
  manifest_payload_sha256 char(64) NOT NULL CHECK (manifest_payload_sha256 ~ '^[a-f0-9]{64}$'),
  transcript_sha256 char(64) NOT NULL CHECK (transcript_sha256 ~ '^[a-f0-9]{64}$'),
  summary_sha256 char(64) NOT NULL CHECK (summary_sha256 ~ '^[a-f0-9]{64}$'),
  signature text,
  signature_algorithm text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_manifests_workspace_idx ON run_manifests (workspace_id, created_at DESC);

CREATE TABLE run_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status review_status NOT NULL,
  rubric_version text,
  ratings jsonb NOT NULL DEFAULT '{}'::jsonb,
  comments_markdown text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, reviewer_id)
);
CREATE INDEX run_reviews_workspace_idx ON run_reviews (workspace_id, created_at DESC);
CREATE TRIGGER run_reviews_set_updated_at
  BEFORE UPDATE ON run_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE comparison_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  visibility evaluation_visibility NOT NULL DEFAULT 'identified',
  rubric jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER comparison_sets_set_updated_at
  BEFORE UPDATE ON comparison_sets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE comparison_items (
  comparison_set_id uuid NOT NULL REFERENCES comparison_sets(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  blind_label text,
  display_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (comparison_set_id, run_id),
  UNIQUE (comparison_set_id, blind_label)
);

CREATE TABLE comparison_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  comparison_set_id uuid NOT NULL REFERENCES comparison_sets(id) ON DELETE CASCADE,
  evaluator_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  item_scores jsonb NOT NULL,
  ranking jsonb NOT NULL DEFAULT '[]'::jsonb,
  comments_markdown text NOT NULL DEFAULT '',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comparison_set_id, evaluator_id)
);
CREATE INDEX comparison_evaluations_workspace_idx ON comparison_evaluations (workspace_id, submitted_at DESC);

CREATE TABLE export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  format text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  status export_status NOT NULL DEFAULT 'queued',
  storage_object_key text,
  byte_size bigint,
  sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  error_code text,
  error_safe_message text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX export_jobs_workspace_idx ON export_jobs (workspace_id, created_at DESC);
CREATE INDEX export_jobs_queue_idx ON export_jobs (status, created_at);

-- Audit records are append-only by application policy and contain metadata, not source content or secrets.
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text,
  request_id text,
  ip_hash text,
  user_agent_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_workspace_created_idx ON audit_events (workspace_id, created_at DESC);
CREATE INDEX audit_events_object_idx ON audit_events (workspace_id, object_type, object_id);

-- Queue leasing helper. Workers call this in a transaction.
CREATE OR REPLACE FUNCTION claim_next_run(
  p_worker_id text,
  p_lease_seconds integer DEFAULT 90
)
RETURNS SETOF runs
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT r.id
    FROM runs r
    WHERE r.status = 'queued'
      AND r.queue_available_at <= now()
      AND r.attempt_count < r.max_attempts
    ORDER BY r.priority ASC, r.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE runs r
  SET status = 'leased',
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      attempt_count = r.attempt_count + 1,
      updated_at = now()
  FROM candidate c
  WHERE r.id = c.id
  RETURNING r.*;
END;
$$;

-- Application services must also:
-- 1. validate workspace membership for every query and mutation;
-- 2. redact secrets and unsafe payloads before logging;
-- 3. freeze meeting definitions before queueing a run;
-- 4. prevent edits to completed run turns, events, interventions, summaries, and manifests;
-- 5. enforce monotonic run_event.run_sequence under a per-run transaction/advisory lock;
-- 6. verify App Storage object ownership and hashes;
-- 7. use server-side signed/authorized download routes rather than exposing unrestricted object keys.

COMMIT;
