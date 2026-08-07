"""A recursive participant must be refused, not crashed on.

Making the provider columns nullable means a draft can now describe a
participant with no provider at all. Nothing exists yet that can execute one,
so every path that used to assume a provider must say so plainly instead of
dereferencing the empty columns -- and must never quietly fall back to a
standard completion, which would run a different experiment than the one the
researcher configured.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from http.cookiejar import CookieJar

import pytest
from sqlalchemy import select, text

from app.api import v1 as v1_module
from app.config import Settings
from app.models import AgentVersion, MeetingDefinitionAgent, ProviderConfig, ProviderModel
from app.schemas import MeetingDraftIn

PROXY = "http://localhost:80"


def _proxy_up() -> bool:
    try:
        with urllib.request.urlopen(f"{PROXY}/api/health/ready", timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


def _login(email: str):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    req = urllib.request.Request(
        f"{PROXY}/api/v1/auth/dev-login",
        data=json.dumps({"email": email}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with opener.open(req, timeout=10) as resp:
        assert resp.status == 200
    with opener.open(f"{PROXY}/api/v1/me", timeout=10) as resp:
        return opener, json.loads(resp.read())


def _post(opener, path: str, body: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{PROXY}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with opener.open(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read() or b"{}"
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"raw": raw.decode(errors="replace")}


def _get(opener, path: str):
    with opener.open(f"{PROXY}{path}", timeout=30) as resp:
        return json.loads(resp.read())


def _recursive_agent(position: int, agent_version_id: str) -> dict:
    return {
        "position": position,
        "role_type": "member",
        "agent_version_id": agent_version_id,
        "execution_mode": "recursive_rlm",
        "recursive_execution": {
            "requested_worker_id": str(uuid.uuid4()),
            "coordinator_model_key": "ollama/qwen2.5-coder:32b",
        },
    }


@pytest.mark.skipif(not _proxy_up(), reason="shared proxy not reachable")
def test_recursive_draft_is_refused_by_validate_and_launch():
    """End to end over the real HTTP surface, with the feature off by default."""
    opener, me = _login("recursive.guard@test.dev")
    [workspace] = [w for w in me["workspaces"] if w["slug"].startswith("lab-")]
    ws_id = workspace["id"]

    project = _get(opener, f"/api/v1/workspaces/{ws_id}/projects")[0]
    providers = [p for p in _get(opener, f"/api/v1/workspaces/{ws_id}/providers") if p["models"]]
    if not providers:
        pytest.skip("workspace has no provider with models")
    provider = providers[0]
    model = provider["models"][0]

    agents = [a for a in _get(opener, f"/api/v1/workspaces/{ws_id}/agents") if a["latest_version"]]
    if len(agents) < 2:
        pytest.skip("workspace has fewer than two agents to build a team meeting")
    lead_version = agents[0]["latest_version"]["id"]
    member_version = agents[1]["latest_version"]["id"]

    draft_body = {
        "title": "Recursive runtime guard",
        "meeting_type": "team",
        "agenda": "Confirm an unexecutable runtime is refused rather than crashed on.",
        "rounds": 1,
        "agents": [
            {
                "position": 0,
                "role_type": "lead",
                "agent_version_id": lead_version,
                "provider_config_id": provider["id"],
                "provider_model_id": model["id"],
            },
            _recursive_agent(1, member_version),
        ],
    }

    status, draft = _post(opener, f"/api/v1/projects/{project['id']}/meeting-drafts", draft_body)
    assert status == 201, f"draft creation failed: {draft}"

    # Validate must answer, not fault. A 500 here is the null-provider crash.
    status, result = _post(opener, f"/api/v1/meeting-drafts/{draft['id']}/validate", {})
    assert status == 200, f"validate returned {status}: {result}"
    messages = " ".join(e["message"] for e in result["errors"])
    assert "recursive" in messages.lower(), f"no recursive-runtime error: {result['errors']}"

    # Launch must refuse for the same reason, as a client error.
    status, result = _post(opener, f"/api/v1/meeting-drafts/{draft['id']}/launch", {})
    assert status == 422, f"launch returned {status}: {result}"
    assert result["detail"]["code"] == "invalid_draft"

    # And no definition row was frozen for the refused participant.
    assert "run_id" not in result


async def test_validate_refuses_recursive_with_the_feature_enabled(sessionmaker, monkeypatch):
    """The same refusal when the flag is on: enabling it does not build a broker.

    Covers the branch the HTTP test above cannot reach without restarting the
    server, and proves neither branch touches the empty provider columns.
    """
    async with sessionmaker() as db:
        provider = (
            await db.execute(select(ProviderConfig).where(ProviderConfig.is_enabled.is_(True)))
        ).scalars().first()
        if provider is None:
            pytest.skip("no enabled provider config in the development database")
        model = (
            await db.execute(
                select(ProviderModel).where(ProviderModel.provider_config_id == provider.id)
            )
        ).scalars().first()
        versions = (await db.execute(select(AgentVersion).limit(2))).scalars().all()
        if model is None or len(versions) < 2:
            pytest.skip("development database lacks a provider model or agent versions")

        body = MeetingDraftIn.model_validate(
            {
                "title": "Recursive runtime guard",
                "meeting_type": "team",
                "agenda": "Feature enabled, still no broker.",
                "rounds": 1,
                "agents": [
                    {
                        "position": 0,
                        "role_type": "lead",
                        "agent_version_id": str(versions[0].id),
                        "provider_config_id": str(provider.id),
                        "provider_model_id": str(model.id),
                    },
                    _recursive_agent(1, str(versions[1].id)),
                ],
            }
        )

        enabled = Settings(
            database_url="postgresql://u:p@localhost/db",
            session_secret="x" * 32,
            recursive_agents_enabled=True,
            recursive_worker_token_pepper="p" * 32,
        )
        monkeypatch.setattr(v1_module, "get_settings", lambda: enabled)

        errors, _warnings, _base = await v1_module._validate_draft(db, provider.workspace_id, body)

        messages = [e["message"] for e in errors]
        assert any("recursive" in m.lower() for m in messages), messages
        # The standard participant alongside it is still judged on its own
        # merits: the recursive one must not poison an otherwise valid row.
        assert not any("Provider is missing" in m for m in messages), messages


async def test_engine_refuses_a_definition_it_cannot_execute(sessionmaker):
    """Backstop: if a recursive definition ever existed, name what is unsupported.

    Launch prevents this, so the engine should never see one -- but an
    AssertionError deep inside provider loading would be a far worse way to
    find out than a message naming the runtime. Built for real against the
    database (so the runtime CHECK constraint has to accept it too) and rolled
    back afterwards.
    """
    from app.engine import _load_context
    from app.models import Run

    async with sessionmaker() as db:
        run = (
            await db.execute(
                select(Run).join(
                    MeetingDefinitionAgent,
                    MeetingDefinitionAgent.meeting_definition_id == Run.meeting_definition_id,
                ).limit(1)
            )
        ).scalars().first()
        if run is None:
            pytest.skip("no run with a frozen definition in the development database")

        run_id = run.id
        workspace_id = run.workspace_id
        definition_id = run.meeting_definition_id

        savepoint = await db.begin_nested()
        try:
            worker_id = (
                await db.execute(
                    text(
                        "INSERT INTO recursive_workers "
                        "(workspace_id, display_name, token_prefix, token_hash) "
                        "VALUES (:w, 'guard-test', :p, :h) RETURNING id"
                    ),
                    {
                        "w": workspace_id,
                        "p": f"guard_{uuid.uuid4().hex[:8]}",
                        "h": "0" * 64,
                    },
                )
            ).scalar_one()
            await db.execute(
                text(
                    "UPDATE meeting_definition_agents SET "
                    "  execution_mode = 'recursive_rlm', "
                    "  provider_config_id = NULL, provider_model_id = NULL, "
                    "  recursive_worker_id = :wid, recursive_model_key = 'ollama/qwen2.5:32b' "
                    "WHERE meeting_definition_id = :d "
                    "  AND position = (SELECT min(position) FROM meeting_definition_agents "
                    "                  WHERE meeting_definition_id = :d)"
                ),
                {"wid": worker_id, "d": definition_id},
            )
            # Drop the identity map so _load_context reads the rewritten row,
            # then re-fetch the run so no attribute is left expired.
            db.expire_all()
            reloaded = await db.get(Run, run_id)

            with pytest.raises(RuntimeError, match="recursive_rlm"):
                await _load_context(db, reloaded)
        finally:
            await savepoint.rollback()
            await db.rollback()
