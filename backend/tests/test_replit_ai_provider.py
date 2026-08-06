"""Integration tests for the credentialless Replit AI provider source.

Covers: persistence of a credentialless config (amended CHECK constraint),
runtime credential resolution from server env, provider CRUD persistence,
and a full engine run executing against a mocked Replit AI proxy endpoint.
"""
from __future__ import annotations

import json as _json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.engine as engine_module  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.engine import execute_run  # noqa: E402
from app.models import (  # noqa: E402
    MeetingDefinition, MeetingDefinitionAgent, ProviderConfig, ProviderModel,
    Run, RunCitation, RunEvent, RunSummary, RunTurn, Workspace,
)
from app.providers import (  # noqa: E402
    OpenAICompatibleProvider, build_provider, resolve_credentials,
)
from app.secretbox import decrypt_secret, encrypt_secret  # noqa: E402
from app.engine import canonical_json, sha256_text  # noqa: E402
from app.seed import seed  # noqa: E402
from tests.test_seed_and_run import _make_demo_run  # noqa: E402


@pytest.fixture()
def replit_env(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "ai_integrations_openai_base_url", "https://proxy.replit.example/v1")
    monkeypatch.setattr(settings, "ai_integrations_openai_api_key", "proxy-managed-key")
    return settings


class _FakeChatClient:
    """Mocks the OpenAI-compatible chat/completions endpoint."""

    calls: list[dict] = []

    def __init__(self, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None, headers=None):
        _FakeChatClient.calls.append({"url": url, "json": json, "headers": headers})
        body = {
            "id": f"req-{len(_FakeChatClient.calls)}",
            "model": json["model"],
            "choices": [{"message": {"content": f"Real answer {len(_FakeChatClient.calls)}"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 500},
        }
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))


async def _make_replit_ai_run(db, rounds: int = 1) -> Run:
    """Like _make_demo_run but agents run on a credentialless Replit AI config."""
    demo_run = await _make_demo_run(db, rounds=rounds)
    workspace = (await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))).scalar_one()
    pc = ProviderConfig(
        workspace_id=workspace.id, name=f"Replit AI {uuid.uuid4().hex[:8]}",
        provider_type="openai", base_url=None,
        secret_ciphertext=None, secret_nonce=None, secret_key_version=None,
        endpoint_fingerprint=sha256_text("replit_ai"),
        is_enabled=True, routing_policy={"credential_source": "replit_ai"},
    )
    db.add(pc)
    await db.flush()
    pm = ProviderModel(
        provider_config_id=pc.id, model_key="gpt-5.6-terra", display_name="GPT-5.6 Terra",
        supports_streaming=True,
        capabilities={"pricing": {"input_per_million": 1.0, "output_per_million": 4.0}},
        is_enabled=True,
    )
    db.add(pm)
    await db.flush()
    agents = list((await db.execute(
        select(MeetingDefinitionAgent).where(
            MeetingDefinitionAgent.meeting_definition_id == demo_run.meeting_definition_id
        )
    )).scalars())
    for a in agents:
        a.provider_config_id = pc.id
        a.provider_model_id = pm.id
    demo_run.demo_mode = False
    await db.commit()
    return demo_run


async def test_credentialless_replit_ai_config_persists(sessionmaker):
    """The CHECK constraint must accept replit_ai configs with no secret/base_url."""
    async with sessionmaker() as db:
        await seed(db)
        workspace = (await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))).scalar_one()
        pc = ProviderConfig(
            workspace_id=workspace.id, name=f"Replit AI persist {uuid.uuid4().hex[:8]}",
            provider_type="openai", base_url=None,
            routing_policy={"credential_source": "replit_ai"},
            endpoint_fingerprint=sha256_text("replit_ai"), is_enabled=True,
        )
        db.add(pc)
        await db.commit()  # would raise IntegrityError before the amended constraint
        stored = await db.get(ProviderConfig, pc.id)
        assert stored.secret_ciphertext is None and stored.base_url is None
        assert stored.routing_policy["credential_source"] == "replit_ai"


async def test_byok_config_still_requires_credentials(sessionmaker):
    from sqlalchemy.exc import IntegrityError
    async with sessionmaker() as db:
        await seed(db)
        workspace = (await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))).scalar_one()
        db.add(ProviderConfig(
            workspace_id=workspace.id, name=f"BYOK invalid {uuid.uuid4().hex[:8]}",
            provider_type="openai", base_url=None, routing_policy={},
        ))
        with pytest.raises(IntegrityError):
            await db.commit()


async def test_byok_secret_roundtrip_persistence(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        workspace = (await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))).scalar_one()
        ct, nonce, ver = encrypt_secret("sk-live-abc123")
        pc = ProviderConfig(
            workspace_id=workspace.id, name=f"BYOK persist {uuid.uuid4().hex[:8]}",
            provider_type="openai", base_url="https://api.openai.com/v1",
            secret_ciphertext=ct, secret_nonce=nonce, secret_key_version=ver,
            endpoint_fingerprint=sha256_text("https://api.openai.com/v1"),
        )
        db.add(pc)
        await db.commit()
        stored = await db.get(ProviderConfig, pc.id)
        assert decrypt_secret(stored.secret_ciphertext, stored.secret_nonce, stored.secret_key_version) == "sk-live-abc123"


def test_resolve_credentials_replit_ai(replit_env):
    class Cfg:
        provider_type = "openai"
        name = "Replit AI"
        base_url = None
        organization_id = None
        routing_policy = {"credential_source": "replit_ai"}

    base, key = resolve_credentials(Cfg(), None)
    assert base == "https://proxy.replit.example/v1"
    assert key == "proxy-managed-key"
    provider = build_provider(Cfg(), None)
    assert isinstance(provider, OpenAICompatibleProvider)
    assert provider.base_url == "https://proxy.replit.example/v1"


async def test_engine_runs_on_replit_ai_source(sessionmaker, monkeypatch, replit_env):
    _FakeChatClient.calls = []
    monkeypatch.setattr(httpx, "AsyncClient", _FakeChatClient)
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_replit_ai_run(db, rounds=1)
        run_id = run.id

    await execute_run(sessionmaker, run_id, "test-worker")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        assert run.demo_mode is False
        # 3 meeting turns (team, 1 round, 1 member) + 1 structured synthesis call.
        assert run.provider_call_count == 4
        # usage priced from capabilities: (1000*1.0 + 500*4.0)/1e6 per call
        assert float(run.actual_cost_usd) == pytest.approx(4 * 0.003)
        turns = list((await db.execute(
            select(RunTurn).where(RunTurn.run_id == run_id).order_by(RunTurn.sequence)
        )).scalars())
        # The synthesis call is not a meeting turn — no agent spoke it — so it
        # must not appear in the transcript.
        assert len(turns) == 3
        assert all(t.input_tokens == 1000 and t.output_tokens == 500 for t in turns)
        assert all(t.provider_request_id for t in turns)
        # ...but its usage and provenance are still recorded.
        synth = (await db.execute(
            select(RunEvent).where(
                RunEvent.run_id == run_id,
                RunEvent.event_type == "summary.synthesis_completed",
            )
        )).scalar_one()
        assert synth.payload["provider_request_id"]
        assert synth.payload["response_sha256"]

        summary = (await db.execute(
            select(RunSummary).where(RunSummary.run_id == run_id)
        )).scalar_one()
        assert "[Simulation]" not in summary.summary_markdown
        assert "Simulation" not in summary.summary_json["executive_summary"]
        assert summary.summary_json["disclosure"]["model_generated"] is True
        assert summary.summary_json["disclosure"]["human_review_required"] is True
        # This fake provider returns prose, not JSON, so the structured record
        # could not be extracted. Nothing may be invented to fill the gap: the
        # confidence must read as absent, not as a middling score.
        assert summary.summary_json["confidence"]["overall"] == 0.0
        assert "No model-derived confidence" in summary.summary_json["confidence"]["basis"]
        for qa in summary.summary_json["question_answers"]:
            assert qa["answer"].startswith("Not extracted")
            assert qa["confidence"] == 0.0
        assert summary.summary_json["recommendation"]["decision"].startswith("Not extracted")
    # every call hit the managed proxy with the managed key
    assert all(c["url"].startswith("https://proxy.replit.example/v1") for c in _FakeChatClient.calls)
    assert all(c["headers"]["Authorization"] == "Bearer proxy-managed-key" for c in _FakeChatClient.calls)


class _FakeSynthesisClient(_FakeChatClient):
    """Prose for the meeting turns, a structured record for the synthesis call."""

    record: dict = {}

    async def post(self, url, json=None, headers=None):
        _FakeChatClient.calls.append({"url": url, "json": json, "headers": headers})
        system = next(
            (m.get("content", "") for m in json["messages"] if m.get("role") == "system"), ""
        )
        if "recording secretary" in system.lower():
            content = "```json\n" + _json.dumps(_FakeSynthesisClient.record) + "\n```"
        else:
            content = f"Real answer {len(_FakeChatClient.calls)}"
        body = {
            "id": f"req-{len(_FakeChatClient.calls)}",
            "model": json["model"],
            "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 500},
        }
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))


async def test_structured_record_is_the_models_own(sessionmaker, monkeypatch, replit_env):
    """Every judgement in the summary must come from the model, not from us.

    The confidence scores in particular are the most quotable numbers in the
    report, so they have to be the model's own statement about its own work.
    """
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_replit_ai_run(db, rounds=1)
        run_id = run.id
        definition = await db.get(MeetingDefinition, run.meeting_definition_id)
        questions = list(definition.questions or [])
    assert questions, "fixture needs agenda questions for this test to mean anything"

    _FakeChatClient.calls = []
    _FakeSynthesisClient.record = {
        "executive_summary": "The panel converged on a staged rollout.",
        "recommendation": {
            "decision": "Adopt the staged rollout",
            "rationale": "Two specialists independently reached it.",
            "conditions": ["Re-assess after the pilot"],
        },
        "question_answers": [
            {"question": q, "answer": f"Answered: {q}", "evidence_ids": [],
             "confidence": 0.73, "open_issue": None}
            for q in questions
        ],
        "confidence": {
            "overall": 0.66,
            "basis": "Consistent agreement across specialists.",
            "uncertainty": "No experimental validation.",
        },
        "assumptions": [], "disagreements": [], "risks_and_limitations": [],
        "next_steps": [], "evidence": [], "role_contributions": [],
    }
    monkeypatch.setattr(httpx, "AsyncClient", _FakeSynthesisClient)

    await execute_run(sessionmaker, run_id, "test-worker")

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run.status == "completed"
        summary = (await db.execute(
            select(RunSummary).where(RunSummary.run_id == run_id)
        )).scalar_one()
        assert summary.validation_status == "valid", summary.validation_errors
        sj = summary.summary_json
        assert sj["executive_summary"] == "The panel converged on a staged rollout."
        assert sj["recommendation"]["decision"] == "Adopt the staged rollout"
        assert sj["confidence"]["overall"] == 0.66
        assert sj["confidence"]["basis"] == "Consistent agreement across specialists."
        assert [qa["confidence"] for qa in sj["question_answers"]] == [0.73] * len(questions)
        assert all(qa["answer"].startswith("Answered:") for qa in sj["question_answers"])


async def _record_run(sessionmaker):
    async with sessionmaker() as db:
        await seed(db)
        run = await _make_replit_ai_run(db, rounds=1)
        definition = await db.get(MeetingDefinition, run.meeting_definition_id)
        return run.id, list(definition.questions or [])


def _base_record(questions: list[str]) -> dict:
    return {
        "executive_summary": "The panel reached a conclusion.",
        "recommendation": {"decision": "Proceed", "rationale": "Agreed.", "conditions": []},
        "question_answers": [
            {"question": q, "answer": "An answer.", "evidence_ids": [],
             "confidence": 0.5, "open_issue": None}
            for q in questions
        ],
        "confidence": {"overall": 0.5, "basis": "Stated.", "uncertainty": "Some."},
        "evidence": [], "assumptions": [], "disagreements": [],
        "risks_and_limitations": [], "next_steps": [], "role_contributions": [],
    }


async def test_fabricated_citations_are_dropped(sessionmaker, monkeypatch, replit_env):
    """A model that mints evidence IDs must not produce citations.

    The prompt restricts citations to the evidence frozen into the meeting, but
    a prompt is not enforcement. A citation pointing at a source that was never
    attached is the most damaging thing a research summary could carry.
    """
    run_id, questions = await _record_run(sessionmaker)
    _FakeChatClient.calls = []
    record = _base_record(questions)
    record["evidence"] = [{
        "evidence_id": "EV-NEVER-ATTACHED", "claim": "Invented support.",
        "support_type": "supports", "locator": None,
    }]
    for qa in record["question_answers"]:
        qa["evidence_ids"] = ["EV-ALSO-INVENTED"]
    _FakeSynthesisClient.record = record
    monkeypatch.setattr(httpx, "AsyncClient", _FakeSynthesisClient)

    await execute_run(sessionmaker, run_id, "test-worker")

    async with sessionmaker() as db:
        summary = (await db.execute(
            select(RunSummary).where(RunSummary.run_id == run_id)
        )).scalar_one()
        sj = summary.summary_json
        assert sj["evidence"] == []
        assert all(qa["evidence_ids"] == [] for qa in sj["question_answers"])
        assert any("were removed" in lim for lim in sj["disclosure"]["limitations"])
        citations = list((await db.execute(
            select(RunCitation).where(RunCitation.run_id == run_id)
        )).scalars())
        assert citations == []


async def test_schema_invalid_record_is_rejected_not_published(
    sessionmaker, monkeypatch, replit_env
):
    """A malformed model record must not be published as a finding.

    Schema validation is a gate, not a label: we fall back to the honest
    not-extracted record rather than persisting a document that does not
    conform to the summary schema.
    """
    run_id, questions = await _record_run(sessionmaker)
    _FakeChatClient.calls = []
    record = _base_record(questions)
    # 'catastrophic' is not in the impact enum, so the document is invalid.
    record["assumptions"] = [
        {"assumption": "Reagents are pure.", "impact": "catastrophic", "validation": "Assay."}
    ]
    _FakeSynthesisClient.record = record
    monkeypatch.setattr(httpx, "AsyncClient", _FakeSynthesisClient)

    await execute_run(sessionmaker, run_id, "test-worker")

    async with sessionmaker() as db:
        summary = (await db.execute(
            select(RunSummary).where(RunSummary.run_id == run_id)
        )).scalar_one()
        # The published document is valid because the bad record was discarded.
        assert summary.validation_status == "valid", summary.validation_errors
        sj = summary.summary_json
        assert sj["assumptions"] == []
        assert sj["confidence"]["overall"] == 0.0
        assert all(qa["answer"].startswith("Not extracted") for qa in sj["question_answers"])
        rejected = (await db.execute(
            select(RunEvent).where(
                RunEvent.run_id == run_id,
                RunEvent.event_type == "summary.synthesis_rejected",
            )
        )).scalar_one()
        assert rejected.payload["errors"]
