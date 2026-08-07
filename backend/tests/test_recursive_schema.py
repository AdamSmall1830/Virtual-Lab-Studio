"""Recursive Agent (Beta) schema foundation.

Two things must hold after adding an optional second execution runtime:

1. Nothing that existed before changes. A draft written when every participant
   was provider-backed must still validate, still mean the same thing, and
   still produce the same rows.
2. The new nullability is not a loophole. Provider columns became nullable so a
   recursive participant can exist at all, so the database itself must refuse a
   participant or turn that claims one runtime while carrying the other's
   fields -- not merely the Pydantic layer, which a background writer bypasses.
"""
from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError
from sqlalchemy import text

from app.config import Settings
from app.models import _ENUM_VALUES
from app.schemas import DraftAgentIn, RecursiveExecutionConfigIn

# pytest.ini sets asyncio_mode = auto, so async tests below need no marker.


# --- 1. Existing payloads are untouched ------------------------------------


def test_pre_existing_draft_agent_payload_still_validates():
    """The exact payload shape used before this feature, unchanged."""
    payload = {
        "position": 0,
        "role_type": "lead",
        "agent_version_id": str(uuid.uuid4()),
        "provider_config_id": str(uuid.uuid4()),
        "provider_model_id": str(uuid.uuid4()),
        "temperature_override": 0.7,
        "tool_definition_ids": [],
    }
    agent = DraftAgentIn.model_validate(payload)
    assert agent.execution_mode == "standard"
    assert agent.recursive_execution is None
    assert agent.provider_config_id is not None
    assert agent.provider_model_id is not None


def test_standard_participant_still_requires_both_provider_fields():
    """Nullability in the database must not relax the standard runtime."""
    base = {
        "position": 0,
        "role_type": "member",
        "agent_version_id": str(uuid.uuid4()),
        "provider_config_id": str(uuid.uuid4()),
        "provider_model_id": str(uuid.uuid4()),
    }
    for dropped in ("provider_config_id", "provider_model_id"):
        payload = {k: v for k, v in base.items() if k != dropped}
        with pytest.raises(ValidationError, match=dropped):
            DraftAgentIn.model_validate(payload)


# --- 2. The two runtimes are mutually exclusive ----------------------------


def _recursive_config(**overrides) -> dict:
    config = {
        "requested_worker_id": str(uuid.uuid4()),
        "coordinator_model_key": "ollama/qwen2.5-coder:32b",
    }
    config.update(overrides)
    return config


def test_recursive_participant_rejects_provider_fields():
    with pytest.raises(ValidationError, match="must not carry provider"):
        DraftAgentIn.model_validate(
            {
                "position": 1,
                "role_type": "expert",
                "agent_version_id": str(uuid.uuid4()),
                "execution_mode": "recursive_rlm",
                "provider_config_id": str(uuid.uuid4()),
                "recursive_execution": _recursive_config(),
            }
        )


def test_recursive_participant_requires_its_config():
    with pytest.raises(ValidationError, match="requires recursive_execution"):
        DraftAgentIn.model_validate(
            {
                "position": 1,
                "role_type": "expert",
                "agent_version_id": str(uuid.uuid4()),
                "execution_mode": "recursive_rlm",
            }
        )


def test_standard_participant_rejects_recursive_config():
    with pytest.raises(ValidationError, match="must not carry recursive_execution"):
        DraftAgentIn.model_validate(
            {
                "position": 1,
                "role_type": "expert",
                "agent_version_id": str(uuid.uuid4()),
                "provider_config_id": str(uuid.uuid4()),
                "provider_model_id": str(uuid.uuid4()),
                "recursive_execution": _recursive_config(),
            }
        )


def test_valid_recursive_participant_accepted():
    agent = DraftAgentIn.model_validate(
        {
            "position": 2,
            "role_type": "member",
            "agent_version_id": str(uuid.uuid4()),
            "execution_mode": "recursive_rlm",
            "recursive_execution": _recursive_config(),
        }
    )
    assert agent.provider_config_id is None
    assert agent.recursive_execution is not None
    assert agent.recursive_execution.capability_profile == "research_read_only"


# --- 3. Capability and limit ceilings cannot be widened by a client --------


@pytest.mark.parametrize(
    "override",
    [
        {"allow_web": True},
        {"allowed_skill_ids": ["vls_evidence", "shell"]},
        {"capability_profile": "unrestricted"},
        {"max_children": 9},
        {"max_depth": 3},
        {"max_agent_turns": 0},
        {"max_runtime_seconds": 30},
        {"max_runtime_seconds": 7200},
        {"max_cost_usd": -1},
    ],
)
def test_recursive_config_ceilings_are_enforced(override):
    with pytest.raises(ValidationError):
        RecursiveExecutionConfigIn.model_validate(_recursive_config(**override))


def test_recursive_config_defaults_are_conservative():
    config = RecursiveExecutionConfigIn.model_validate(_recursive_config())
    assert config.allow_web is False
    assert config.allowed_skill_ids == ["vls_evidence"]
    assert config.max_depth == 1
    assert config.max_children <= 8
    assert config.max_cost_usd is not None


# --- 4. Feature flags default off ------------------------------------------


def _settings(**overrides) -> Settings:
    return Settings(
        database_url="postgresql://u:p@localhost/db",
        session_secret="x" * 32,
        **overrides,
    )


def test_recursive_feature_defaults_off():
    settings = _settings()
    assert settings.recursive_agents_enabled is False
    assert settings.recursive_agents_allow_fake_worker is False
    assert settings.recursive_fake_worker_enabled is False
    settings.require_recursive_ready()  # off means nothing to validate


def test_fake_worker_never_available_in_deployment(monkeypatch):
    """The simulator must be unreachable where output could pass for research."""
    settings = _settings(
        recursive_agents_enabled=True,
        recursive_agents_allow_fake_worker=True,
        recursive_worker_token_pepper="p" * 32,
    )
    monkeypatch.delenv("REPLIT_DEPLOYMENT", raising=False)
    assert settings.recursive_fake_worker_enabled is True

    monkeypatch.setenv("REPLIT_DEPLOYMENT", "1")
    assert settings.is_deployment is True
    assert settings.recursive_fake_worker_enabled is False


def test_enabling_recursive_requires_a_real_pepper():
    """Fail loudly at startup rather than silently disabling the feature."""
    for pepper in ("", "too-short"):
        with pytest.raises(ValueError, match="pepper"):
            _settings(
                recursive_agents_enabled=True,
                recursive_worker_token_pepper=pepper,
            ).require_recursive_ready()


# --- 5. The live database agrees with the models ---------------------------


async def test_database_enums_match_model_declarations(sessionmaker):
    """pg_enum() lists members explicitly, so drift here is silent otherwise."""
    async with sessionmaker() as session:
        for name, expected in _ENUM_VALUES.items():
            rows = (
                await session.execute(
                    text(
                        "SELECT e.enumlabel FROM pg_enum e "
                        "JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = :n"
                    ),
                    {"n": name},
                )
            ).scalars().all()
            assert sorted(rows) == sorted(expected), f"{name} drifted from the database"


async def test_existing_rows_were_backfilled_as_standard(sessionmaker):
    """Every row that predates this migration keeps provider-backed behaviour."""
    async with sessionmaker() as session:
        for table in ("meeting_definition_agents", "run_turns"):
            stray = (
                await session.execute(
                    text(
                        f"SELECT count(*) FROM {table} "
                        "WHERE execution_mode <> 'standard' "
                        "  OR provider_config_id IS NULL "
                        "  OR provider_model_id IS NULL"
                    )
                )
            ).scalar()
            assert stray == 0, f"{table} has rows that are no longer provider-backed"


async def test_new_tables_carry_their_integrity_constraints(sessionmaker):
    """Guard against silent drift between the DDL spec and the migration.

    models.py is a thin ORM mapping over an externally owned schema -- it
    declares no UniqueConstraint, CheckConstraint or ON DELETE action for any
    table, and Base.metadata never creates anything. specs/database_schema.sql
    and the migration are the real contract, so the only way to notice one of
    them losing a constraint is to ask the live database.
    """
    expected_unique = {
        ("recursive_workers", ("token_prefix",)),
        ("recursive_worker_enrollments", ("token_prefix",)),
        ("recursive_agent_jobs", ("run_turn_id",)),
        ("recursive_agent_nodes", ("job_id", "external_node_id")),
        ("recursive_job_events", ("job_id", "worker_sequence")),
        ("recursive_job_events", ("job_id", "external_event_id")),
    }
    # A worker or run must not be deletable out from under a job's provenance,
    # while a workspace teardown must take its own rows with it.
    expected_fk_actions = {
        ("recursive_agent_jobs", "workspace_id"): "c",  # CASCADE
        ("recursive_agent_jobs", "run_id"): "c",
        ("recursive_agent_jobs", "run_turn_id"): "c",
        ("recursive_agent_jobs", "leased_worker_id"): "r",  # RESTRICT
        ("recursive_agent_jobs", "requested_worker_id"): "r",
        ("recursive_agent_jobs", "meeting_definition_id"): "r",
        ("recursive_agent_jobs", "agent_version_id"): "r",
        ("recursive_agent_nodes", "job_id"): "c",
        ("recursive_job_events", "job_id"): "c",
        ("recursive_workers", "workspace_id"): "c",
        ("recursive_workers", "enrolled_by"): "n",  # SET NULL
        ("meeting_definition_agents", "recursive_worker_id"): "r",
    }

    async with sessionmaker() as session:
        rows = (
            await session.execute(
                text(
                    "SELECT c.conrelid::regclass::text, c.contype::text, c.confdeltype::text, "
                    "       array_agg(a.attname ORDER BY a.attnum)::text[] "
                    "FROM pg_constraint c "
                    "JOIN unnest(c.conkey) AS k(attnum) ON true "
                    "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum "
                    "WHERE c.conrelid::regclass::text IN ("
                    "  'recursive_workers','recursive_worker_enrollments','recursive_agent_jobs',"
                    "  'recursive_agent_nodes','recursive_job_events','meeting_definition_agents') "
                    "GROUP BY c.oid, c.conrelid, c.contype, c.confdeltype"
                )
            )
        ).all()

        unique = {
            (table, tuple(cols)) for table, kind, _, cols in rows if kind in ("u", "p")
        }
        missing = expected_unique - unique
        assert not missing, f"uniqueness lost in the schema: {sorted(missing)}"

        fk_actions = {
            (table, cols[0]): action
            for table, kind, action, cols in rows
            if kind == "f" and len(cols) == 1
        }
        for key, action in expected_fk_actions.items():
            assert fk_actions.get(key) == action, (
                f"{key[0]}.{key[1]} delete action is {fk_actions.get(key)!r}, expected {action!r}"
            )


async def test_database_rejects_mixed_runtime_participant(sessionmaker):
    """The CHECK constraint, not just Pydantic, refuses a contradictory row."""
    async with sessionmaker() as session:
        seed = (
            await session.execute(
                text(
                    "SELECT d.id, a.id, p.id, m.id FROM meeting_definitions d "
                    "CROSS JOIN LATERAL (SELECT id FROM agent_versions LIMIT 1) a "
                    "CROSS JOIN LATERAL (SELECT id FROM provider_configs LIMIT 1) p "
                    "CROSS JOIN LATERAL (SELECT id FROM provider_models LIMIT 1) m "
                    "LIMIT 1"
                )
            )
        ).first()
        if seed is None:
            pytest.skip("no seeded meeting definition to attach a participant to")
        definition_id, agent_version_id, provider_config_id, provider_model_id = seed

        insert = text(
            "INSERT INTO meeting_definition_agents "
            "(meeting_definition_id, position, role_type, agent_version_id, "
            " execution_mode, provider_config_id, provider_model_id, "
            " recursive_worker_id, recursive_model_key) "
            "VALUES (:d, 9999, 'member', :a, CAST(:mode AS agent_execution_mode), "
            "        :pc, :pm, :wid, :mk)"
        )
        params = {
            "d": definition_id,
            "a": agent_version_id,
            "pc": provider_config_id,
            "pm": provider_model_id,
            "wid": None,
            "mk": None,
        }

        # A recursive participant that still names a provider is a lie about
        # which runtime produced the turn.
        with pytest.raises(Exception, match="runtime_check"):
            async with session.begin_nested():
                await session.execute(insert, {**params, "mode": "recursive_rlm"})

        # A standard participant pointing at a worker is the same lie inverted.
        with pytest.raises(Exception, match="runtime_check"):
            async with session.begin_nested():
                await session.execute(
                    insert,
                    {**params, "mode": "standard", "mk": "ollama/qwen2.5:32b"},
                )

        # A recursive participant with neither runtime fully specified.
        with pytest.raises(Exception, match="runtime_check"):
            async with session.begin_nested():
                await session.execute(
                    insert,
                    {**params, "mode": "recursive_rlm", "pc": None, "pm": None},
                )

        await session.rollback()


async def test_database_accepts_recursive_turn_without_a_provider(sessionmaker):
    """A recursive turn must be insertable before any provider is known."""
    async with sessionmaker() as session:
        seed = (
            await session.execute(
                text(
                    "SELECT r.id, r.workspace_id, a.id FROM runs r "
                    "CROSS JOIN LATERAL (SELECT id FROM agent_versions LIMIT 1) a "
                    "LIMIT 1"
                )
            )
        ).first()
        if seed is None:
            pytest.skip("no seeded run to attach a turn to")
        run_id, workspace_id, agent_version_id = seed

        insert = text(
            "INSERT INTO run_turns "
            "(workspace_id, run_id, sequence, round_number, position_in_round, "
            " agent_version_id, role_type, status, execution_mode, "
            " provider_config_id, provider_model_id, system_prompt_sha256) "
            "VALUES (:w, :r, 999999, 99, 0, :a, 'member', "
            "        CAST(:status AS turn_status), "
            "        CAST(:mode AS agent_execution_mode), NULL, NULL, :sha)"
        )
        params = {
            "w": workspace_id,
            "r": run_id,
            "a": agent_version_id,
            "sha": "0" * 64,
        }

        async with session.begin_nested() as savepoint:
            await session.execute(
                insert, {**params, "mode": "recursive_rlm", "status": "waiting_external"}
            )
            await savepoint.rollback()

        # The same row claiming the standard runtime is rejected: a
        # provider-backed turn without a provider is not a real record.
        with pytest.raises(Exception, match="runtime_check"):
            async with session.begin_nested():
                await session.execute(
                    insert, {**params, "mode": "standard", "status": "pending"}
                )

        await session.rollback()
