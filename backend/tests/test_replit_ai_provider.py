"""Integration tests for the credentialless Replit AI provider source.

Covers: persistence of a credentialless config (amended CHECK constraint),
runtime credential resolution from server env, provider CRUD persistence,
and a full engine run executing against a mocked Replit AI proxy endpoint.
"""
from __future__ import annotations

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
    Run, RunSummary, RunTurn, Workspace,
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
        assert run.provider_call_count == 3  # team, 1 round, 1 member
        # usage priced from capabilities: (1000*1.0 + 500*4.0)/1e6 per call
        assert float(run.actual_cost_usd) == pytest.approx(3 * 0.003)
        turns = list((await db.execute(
            select(RunTurn).where(RunTurn.run_id == run_id).order_by(RunTurn.sequence)
        )).scalars())
        assert all(t.input_tokens == 1000 and t.output_tokens == 500 for t in turns)
        assert all(t.provider_request_id for t in turns)
        summary = (await db.execute(
            select(RunSummary).where(RunSummary.run_id == run_id)
        )).scalar_one()
        assert "[Simulation]" not in summary.summary_markdown
        assert "Simulation" not in summary.summary_json["executive_summary"]
        assert summary.summary_json["disclosure"]["model_generated"] is True
        assert summary.summary_json["disclosure"]["human_review_required"] is True
    # every call hit the managed proxy with the managed key
    assert all(c["url"].startswith("https://proxy.replit.example/v1") for c in _FakeChatClient.calls)
    assert all(c["headers"]["Authorization"] == "Bearer proxy-managed-key" for c in _FakeChatClient.calls)
