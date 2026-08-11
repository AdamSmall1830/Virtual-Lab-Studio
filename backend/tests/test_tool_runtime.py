"""Tests for the tool runtime: validation, bounds, scoping, and the engine loop.

The load-bearing claims here are about what must *not* happen — a tool must not
reach evidence the meeting was not launched with, a looping participant must not
have its half-finished prose published as a turn, and a real-model run must not
have simulated tool calls written into its record.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import func, select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import engine as engine_module  # noqa: E402
from app.engine import canonical_json, execute_run, sha256_text  # noqa: E402
from app.models import (  # noqa: E402
    AgentProfile,
    AgentVersion,
    EvidenceChunk,
    EvidenceSource,
    MeetingDefinition,
    MeetingDefinitionAgent,
    MeetingDefinitionEvidence,
    Project,
    ProviderConfig,
    ProviderModel,
    Run,
    RunEvent,
    RunTurn,
    ToolCall,
    ToolDefinition,
    Workspace,
)
from app.providers import (  # noqa: E402
    CompletionResult,
    ModelPricing,
    OpenAICompatibleProvider,
    ProviderToolCall,
    get_demo_provider,
)
from app.secretbox import encrypt_secret  # noqa: E402
from app.tools import (  # noqa: E402
    MAX_TOOL_ITERATIONS_PER_TURN,
    ToolExecutionError,
    ToolRuntimeContext,
    bound_result,
    handle_workspace_evidence_search,
    offerable,
    validate_arguments,
)
from tests.test_seed_and_run import _make_demo_run  # noqa: E402

SCHEMA = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "minLength": 1},
        "max_results": {"type": "integer", "maximum": 10},
    },
    "required": ["query"],
    "additionalProperties": False,
}


# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------

def test_validate_arguments_rejects_non_object():
    with pytest.raises(ToolExecutionError) as ei:
        validate_arguments(SCHEMA, ["query"])
    assert ei.value.code == "invalid_arguments"


def test_validate_arguments_enforces_the_declared_schema():
    # The schema is the contract the tool was reviewed against, so violations
    # are refused here rather than passed to a handler that assumed them away.
    for bad in ({}, {"query": ""}, {"query": "x", "max_results": 99},
                {"query": "x", "unexpected": 1}):
        with pytest.raises(ToolExecutionError) as ei:
            validate_arguments(SCHEMA, bad)
        assert ei.value.code == "invalid_arguments"
        assert "query" in ei.value.safe_message or "max_results" in ei.value.safe_message \
            or "unexpected" in ei.value.safe_message or "required" in ei.value.safe_message


def test_validate_arguments_accepts_valid_arguments():
    assert validate_arguments(SCHEMA, {"query": "crispr", "max_results": 3}) == {
        "query": "crispr", "max_results": 3
    }


# ---------------------------------------------------------------------------
# Result bounding
# ---------------------------------------------------------------------------

def test_bound_result_drops_whole_entries_and_flags_truncation():
    result = {"results": [{"excerpt": "x" * 200} for _ in range(20)], "result_count": 20}
    outcome = bound_result(result, 1000)
    assert outcome.truncated is True
    assert 0 < len(outcome.result["results"]) < 20
    # The count must track the trim, or the model is told it received more than
    # it did and may reason about entries that are not there.
    assert outcome.result["result_count"] == len(outcome.result["results"])
    # Entries that survive are intact, not cut mid-string.
    assert all(len(r["excerpt"]) == 200 for r in outcome.result["results"])


def test_bound_result_passes_small_results_through_untouched():
    result = {"results": [{"a": 1}], "result_count": 1}
    outcome = bound_result(result, 100_000)
    assert outcome.truncated is False
    assert outcome.result == result
    assert "truncated" not in outcome.result


def test_bound_result_refuses_an_untrimmable_result():
    with pytest.raises(ToolExecutionError) as ei:
        bound_result({"results": [{"excerpt": "x" * 5000}]}, 200)
    assert ei.value.code == "result_too_large"

    with pytest.raises(ToolExecutionError):
        bound_result({"blob": "x" * 5000}, 200)


# ---------------------------------------------------------------------------
# Which tools may be offered
# ---------------------------------------------------------------------------

def _tool(**kw):
    base = {"is_enabled": True, "policy": {}, "handler_key": "pmc_search",
            "slug": "pmc_search"}
    base.update(kw)
    return SimpleNamespace(**base)


def test_offerable_withholds_tools_needing_approval():
    # There is no way for a model to ask a human for approval mid-turn, so a
    # tool a reviewer flagged is withheld rather than quietly executed.
    ok, reason = offerable(_tool(policy={"requires_approval": True}))
    assert ok is False and reason == "requires_approval"


def test_offerable_withholds_disabled_and_unimplemented_tools():
    assert offerable(_tool(is_enabled=False))[0] is False
    assert offerable(_tool(handler_key="does_not_exist")) == (False, "no_handler")
    assert offerable(_tool())[0] is True


# ---------------------------------------------------------------------------
# Provider adapter: requesting and parsing tool calls
# ---------------------------------------------------------------------------

class _FakeClient:
    def __init__(self, response: httpx.Response):
        self._response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None, headers=None):
        self.captured = {"url": url, "json": json, "headers": headers}
        _FakeClient.last = self
        return self._response


def _request(tools=None):
    from app.providers import CompletionRequest

    return CompletionRequest(
        model="gpt-4o-mini", system_prompt="sys",
        messages=[{"role": "user", "content": "hi"}],
        temperature=0.2, run_id="r", call_index=0,
        agent_title="A", role_type="lead", round_number=1, is_final=False,
        tools=tools,
    )


def _tool_call_body(arguments: str):
    return {
        "id": "resp-1", "model": "gpt-4o-mini",
        "choices": [{
            "message": {
                "content": None,  # a tool-only response has null content
                "tool_calls": [{
                    "id": "call_abc", "type": "function",
                    "function": {"name": "pmc_search", "arguments": arguments},
                }],
            },
            "finish_reason": "tool_calls",
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }


async def test_adapter_sends_tools_and_parses_the_call(monkeypatch):
    resp = httpx.Response(200, json=_tool_call_body('{"query": "crispr"}'),
                          request=httpx.Request("POST", "https://x"))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _FakeClient(resp))
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "sk-k")

    schemas = [{"type": "function", "function": {"name": "pmc_search",
                                                 "description": "d", "parameters": SCHEMA}}]
    result = await provider.complete(_request(tools=schemas))

    sent = _FakeClient.last.captured["json"]
    assert sent["tools"] == schemas
    # "auto", not "required": a participant with nothing to look up should
    # answer rather than manufacture a search to satisfy the parameter.
    assert sent["tool_choice"] == "auto"

    assert result.content == ""  # null content must not crash the adapter
    assert len(result.requested_tool_calls) == 1
    call = result.requested_tool_calls[0]
    assert (call.id, call.name, call.arguments) == ("call_abc", "pmc_search",
                                                    {"query": "crispr"})
    assert call.parse_error is None
    assert result.raw_assistant_message is not None


async def test_adapter_reports_unparseable_arguments_without_raising(monkeypatch):
    # A malformed argument string is the model's mistake to correct, not a
    # reason to fail the run.
    resp = httpx.Response(200, json=_tool_call_body("{not json"),
                          request=httpx.Request("POST", "https://x"))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _FakeClient(resp))
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "sk-k")
    result = await provider.complete(_request())
    assert result.requested_tool_calls[0].parse_error is not None


async def test_adapter_omits_tools_when_none_are_offered(monkeypatch):
    body = {"id": "r", "model": "gpt-4o-mini",
            "choices": [{"message": {"content": "Hello"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
    resp = httpx.Response(200, json=body, request=httpx.Request("POST", "https://x"))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _FakeClient(resp))
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "sk-k")
    result = await provider.complete(_request())
    assert "tools" not in _FakeClient.last.captured["json"]
    assert "tool_choice" not in _FakeClient.last.captured["json"]
    assert result.requested_tool_calls == []
    assert result.raw_assistant_message is None


# ---------------------------------------------------------------------------
# Evidence search scoping
# ---------------------------------------------------------------------------

async def _evidence_fixture(db, *, budget: dict | None = None):
    """A definition with one chunk frozen in and one deliberately left out."""
    workspace = (
        await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))
    ).scalar_one()
    project = (
        await db.execute(select(Project).where(Project.workspace_id == workspace.id).limit(1))
    ).scalar_one()

    source = EvidenceSource(
        workspace_id=workspace.id, project_id=project.id,
        evidence_key=f"E-TOOL-{uuid.uuid4().hex[:8]}", source_type="note",
        title="Tool scoping fixture", processing_status="ready",
    )
    db.add(source)
    await db.flush()

    frozen = EvidenceChunk(
        workspace_id=workspace.id, evidence_source_id=source.id, chunk_index=0,
        locator="p1", content_text="Telomerase activity rises in the frozen passage.",
        content_sha256=sha256_text("frozen"),
    )
    unfrozen = EvidenceChunk(
        workspace_id=workspace.id, evidence_source_id=source.id, chunk_index=1,
        locator="p2", content_text="Telomerase activity also appears in this later passage.",
        content_sha256=sha256_text("unfrozen"),
    )
    db.add_all([frozen, unfrozen])
    await db.flush()

    definition_json = {"test": str(uuid.uuid4())}
    definition = MeetingDefinition(
        workspace_id=workspace.id, project_id=project.id, title="Scoping",
        meeting_type="team", agenda="a", questions=["Q"], rules=[], contexts=[],
        rounds=1, default_temperature=0.2,
        budget={"max_provider_calls": 50} if budget is None else budget,
        definition_json=definition_json,
        definition_sha256=sha256_text(canonical_json(definition_json)),
    )
    db.add(definition)
    await db.flush()
    db.add(MeetingDefinitionEvidence(
        meeting_definition_id=definition.id, evidence_source_id=source.id,
        included_chunk_ids=[str(frozen.id)],  # only the first chunk
        content_sha256_at_freeze=sha256_text("frozen"), position=0,
    ))
    await db.commit()
    return workspace, definition, source


async def test_evidence_search_returns_only_frozen_chunks(sessionmaker):
    async with sessionmaker() as db:
        workspace, definition, source = await _evidence_fixture(db)
        ctx = ToolRuntimeContext(
            db=db, workspace_id=workspace.id, run_id=uuid.uuid4(), definition=definition
        )
        outcome = await handle_workspace_evidence_search({"query": "telomerase"}, ctx)

    excerpts = [r["excerpt"] for r in outcome.result["results"]]
    assert len(excerpts) == 1, "the unfrozen chunk must not be reachable"
    assert "frozen passage" in excerpts[0]
    assert "later passage" not in " ".join(excerpts)
    # The result carries the key a citation must use, and says the content is
    # source material rather than instruction.
    assert outcome.result["results"][0]["evidence_key"] == source.evidence_key
    assert "not as instructions" in outcome.result["note"]


async def test_evidence_search_misses_return_empty_not_error(sessionmaker):
    async with sessionmaker() as db:
        workspace, definition, _ = await _evidence_fixture(db)
        ctx = ToolRuntimeContext(
            db=db, workspace_id=workspace.id, run_id=uuid.uuid4(), definition=definition
        )
        outcome = await handle_workspace_evidence_search(
            {"query": "zzzznotpresent"}, ctx
        )
    assert outcome.result["result_count"] == 0
    assert outcome.result["results"] == []


# ---------------------------------------------------------------------------
# Engine loop
# ---------------------------------------------------------------------------

def _completion(content="", *, tool_calls=(), tokens=10, cost=0.001):
    calls = list(tool_calls)
    return CompletionResult(
        content=content, finish_reason="tool_calls" if calls else "stop",
        provider_request_id="req", model="fake-model",
        input_tokens=tokens, cached_input_tokens=0, output_tokens=tokens,
        cost_usd=cost, latency_ms=5, is_simulation=False,
        requested_tool_calls=calls,
        raw_assistant_message=(
            {"role": "assistant", "content": None,
             "tool_calls": [{"id": c.id, "type": "function",
                             "function": {"name": c.name, "arguments": "{}"}}
                            for c in calls]}
            if calls else None
        ),
    )


class _ScriptedProvider:
    """A non-demo provider whose responses are supplied by the test.

    Deliberately not a DemoProvider subclass: the engine branches on that type
    to decide whether tools and scripted demo events are in play.
    """

    def __init__(self, tool_name: str | None, *, always_call_tools: bool = False):
        self.tool_name = tool_name
        self.always_call_tools = always_call_tools
        self.requests: list[list[dict]] = []
        self.offered: list[list | None] = []

    async def complete(self, request):
        self.requests.append([dict(m) for m in request.messages])
        self.offered.append(request.tools)
        wants_tool = self.always_call_tools or (
            self.tool_name is not None and len(self.requests) == 1
        )
        if wants_tool:
            return _completion(tool_calls=[
                ProviderToolCall(id=f"call_{len(self.requests)}",
                                 name=self.tool_name, arguments={"query": "telomerase"})
            ])
        return _completion(content=f"Answer {len(self.requests)}.")


async def _system_tool(db, slug: str) -> ToolDefinition:
    td = (
        await db.execute(select(ToolDefinition).where(
            ToolDefinition.workspace_id.is_(None), ToolDefinition.slug == slug)
            .order_by(ToolDefinition.version.desc()))
    ).scalars().first()
    assert td is not None, f"system tool {slug!r} is not seeded"
    return td


async def _make_tool_run(
    db,
    *,
    supports_tools: bool = True,
    tool_slugs: tuple[str, ...] = ("workspace_evidence_search",),
    extra_tool_ids: tuple[uuid.UUID, ...] = (),
    budget: dict | None = None,
) -> tuple[Run, MeetingDefinition]:
    """A run on a real (non-demo) provider whose shape does not match the demo
    scenario, with one chunk of evidence frozen in and `tool_slugs` frozen onto
    the participant."""
    workspace, definition, _ = await _evidence_fixture(db, budget=budget)
    demo = get_demo_provider()
    # Guarantee the scripted-scenario matcher cannot fire for this run, while
    # keeping the turn count small.
    scenario_rounds = int(demo.scenario["match"]["rounds"])
    definition.rounds = 1 if scenario_rounds != 1 else 2

    # A non-demo config must carry a secret and a base URL (schema CHECK).
    ciphertext, nonce, key_version = encrypt_secret("sk-test-not-a-real-key")
    config = ProviderConfig(
        workspace_id=workspace.id, name=f"tool-test-{uuid.uuid4().hex[:6]}",
        provider_type="openai_compatible", base_url="https://api.example.com/v1",
        secret_ciphertext=ciphertext, secret_nonce=nonce,
        secret_key_version=key_version,
    )
    db.add(config)
    await db.flush()
    model = ProviderModel(
        provider_config_id=config.id, model_key="fake-model",
        display_name="Fake Model", supports_tools=supports_tools,
        capabilities={"pricing": {"input_per_million": 0, "output_per_million": 0}},
    )
    db.add(model)
    await db.flush()

    async def version_for(slug: str) -> AgentVersion:
        profile = (
            await db.execute(select(AgentProfile).where(
                AgentProfile.workspace_id.is_(None), AgentProfile.slug == slug))
        ).scalar_one()
        return (
            await db.execute(select(AgentVersion)
                             .where(AgentVersion.agent_profile_id == profile.id)
                             .order_by(AgentVersion.version_number.desc()).limit(1))
        ).scalar_one()

    lead = await version_for("principal-investigator")
    tool_ids = [str((await _system_tool(db, slug)).id) for slug in tool_slugs]
    tool_ids += [str(t) for t in extra_tool_ids]
    db.add(MeetingDefinitionAgent(
        meeting_definition_id=definition.id, position=0, role_type="lead",
        agent_version_id=lead.id, provider_config_id=config.id, provider_model_id=model.id,
        tool_definition_ids=tool_ids,
    ))
    run = Run(
        workspace_id=workspace.id, project_id=definition.project_id,
        meeting_definition_id=definition.id, status="leased", demo_mode=False,
        lease_owner="tool-test-worker",
        lease_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    db.add(run)
    await db.commit()
    return run, definition


async def test_engine_executes_a_requested_tool_and_records_it(sessionmaker, monkeypatch):
    async with sessionmaker() as db:
        run, definition = await _make_tool_run(db)
        run_id, definition_id = run.id, definition.id

    provider = _ScriptedProvider("workspace_evidence_search")
    monkeypatch.setattr(engine_module, "build_provider", lambda *a, **kw: provider)
    await execute_run(sessionmaker, run_id, "tool-test-worker")

    async with sessionmaker() as db:
        calls = (
            await db.execute(select(ToolCall).where(ToolCall.run_id == run_id)
                             .order_by(ToolCall.sequence))
        ).scalars().all()
        assert len(calls) == 1
        call = calls[0]
        assert call.status == "completed"
        assert call.provider_tool_call_id == "call_1"
        # Arguments and results are hashed, so a later edit to either is
        # detectable rather than silent.
        assert call.arguments_sha256 == sha256_text(canonical_json(call.arguments_json))
        assert call.result_sha256 == sha256_text(canonical_json(call.result_json))
        assert call.result_json["results"][0]["excerpt"].startswith("Telomerase")
        assert call.error_code is None

        run_row = await db.get(Run, run_id)
        # The first turn made two provider calls; both must be billed.
        assert run_row.tool_call_count == 1
        first_turn = (
            await db.execute(select(RunTurn).where(RunTurn.run_id == run_id)
                             .order_by(RunTurn.sequence).limit(1))
        ).scalar_one()
        assert first_turn.input_tokens == 20, "usage must sum across the tool exchange"
        assert first_turn.cost_usd > 0

        events = [
            e.event_type for e in (
                await db.execute(select(RunEvent).where(RunEvent.run_id == run_id))
            ).scalars()
        ]
        assert "tool.requested" in events and "tool.completed" in events

    # Tools were offered, and the tool exchange stayed inside the turn: the
    # next turn's transcript carries the answer, not the tool traffic.
    assert provider.offered[0], "a tools-capable model should be offered tools"
    later = provider.requests[2]
    assert not any(m.get("role") == "tool" for m in later)


async def test_engine_withholds_tools_from_a_model_that_cannot_use_them(
    sessionmaker, monkeypatch
):
    async with sessionmaker() as db:
        run, _ = await _make_tool_run(db, supports_tools=False)
        run_id = run.id

    provider = _ScriptedProvider(None)
    monkeypatch.setattr(engine_module, "build_provider", lambda *a, **kw: provider)
    await execute_run(sessionmaker, run_id, "tool-test-worker")

    assert all(offered is None for offered in provider.offered)
    async with sessionmaker() as db:
        count = (
            await db.execute(select(func.count()).select_from(ToolCall)
                             .where(ToolCall.run_id == run_id))
        ).scalar_one()
    assert count == 0


async def test_engine_rejects_an_unknown_tool_without_failing_the_run(
    sessionmaker, monkeypatch
):
    async with sessionmaker() as db:
        run, _ = await _make_tool_run(db)
        run_id = run.id

    provider = _ScriptedProvider("no_such_tool")
    monkeypatch.setattr(engine_module, "build_provider", lambda *a, **kw: provider)
    await execute_run(sessionmaker, run_id, "tool-test-worker")

    async with sessionmaker() as db:
        run_row = await db.get(Run, run_id)
        assert run_row.status != "failed"
        count = (
            await db.execute(select(func.count()).select_from(ToolCall)
                             .where(ToolCall.run_id == run_id))
        ).scalar_one()
        assert count == 0, "a call to a nonexistent tool is not a tool call"
        events = [
            e.event_type for e in (
                await db.execute(select(RunEvent).where(RunEvent.run_id == run_id))
            ).scalars()
        ]
        assert "tool.rejected" in events

    # Every requested call still got a reply, or the provider would reject the
    # follow-up request outright.
    second = provider.requests[1]
    assert any(m.get("role") == "tool" for m in second)


async def test_engine_fails_rather_than_publishing_a_looping_turn(
    sessionmaker, monkeypatch
):
    async with sessionmaker() as db:
        run, _ = await _make_tool_run(db)
        run_id = run.id

    provider = _ScriptedProvider("workspace_evidence_search", always_call_tools=True)
    monkeypatch.setattr(engine_module, "build_provider", lambda *a, **kw: provider)
    await execute_run(sessionmaker, run_id, "tool-test-worker")

    async with sessionmaker() as db:
        run_row = await db.get(Run, run_id)
        assert run_row.status == "failed"
        assert run_row.failure_code == "tool_loop_exhausted"
        assert "narrower agenda" in run_row.failure_safe_message
        # No turn may carry text the model produced mid-search.
        completed = (
            await db.execute(select(RunTurn).where(RunTurn.run_id == run_id,
                                                   RunTurn.status == "completed"))
        ).scalars().all()
        assert completed == []
        # The bound is on tool rounds, not on total calls made.
        made = (
            await db.execute(select(func.count()).select_from(ToolCall)
                             .where(ToolCall.run_id == run_id))
        ).scalar_one()
        assert made == MAX_TOOL_ITERATIONS_PER_TURN
        # The lease is released so the run is not left looking alive.
        assert run_row.lease_owner is None
        # Every provider call the doomed turn made is still billed. The tokens
        # were spent; a failure that also erased the bill would let a runaway
        # participant burn a researcher's budget invisibly.
        assert run_row.provider_call_count >= MAX_TOOL_ITERATIONS_PER_TURN + 1
        assert run_row.input_tokens > 0
        assert float(run_row.actual_cost_usd) > 0


async def test_a_participant_only_gets_the_tools_frozen_onto_it(
    sessionmaker, monkeypatch
):
    """The frozen per-agent allowlist is the contract, not "every enabled tool".

    meeting_definition_agents.tool_definition_ids is restored verbatim when a
    definition is rebuilt and is reported in the provenance manifest as what the
    participant was equipped with. If the runtime offered more than that, the
    manifest would describe a meeting that did not happen.
    """
    async with sessionmaker() as db:
        run, _ = await _make_tool_run(db, tool_slugs=("pmc_search",))
        run_id = run.id

    # A real, enabled, seeded system tool — simply not attached to this agent.
    provider = _ScriptedProvider("workspace_evidence_search")
    monkeypatch.setattr(engine_module, "build_provider", lambda *a, **kw: provider)
    await execute_run(sessionmaker, run_id, "tool-test-worker")

    offered = {t["function"]["name"] for t in (provider.offered[0] or [])}
    assert offered == {"pmc_search"}, "only the frozen tool may be offered"

    async with sessionmaker() as db:
        count = (
            await db.execute(select(func.count()).select_from(ToolCall)
                             .where(ToolCall.run_id == run_id))
        ).scalar_one()
        assert count == 0, "a tool nobody attached to this participant must not run"
        events = [
            e.event_type for e in (
                await db.execute(select(RunEvent).where(RunEvent.run_id == run_id))
            ).scalars()
        ]
        assert "tool.rejected" in events


async def test_no_tools_are_offered_when_none_were_frozen(sessionmaker, monkeypatch):
    # A meeting launched without tools attached must not acquire them because
    # the workspace happens to have some enabled.
    async with sessionmaker() as db:
        run, _ = await _make_tool_run(db, tool_slugs=())
        run_id = run.id

    provider = _ScriptedProvider(None)
    monkeypatch.setattr(engine_module, "build_provider", lambda *a, **kw: provider)
    await execute_run(sessionmaker, run_id, "tool-test-worker")
    assert all(offered is None for offered in provider.offered)


async def test_an_approval_gated_tool_cannot_be_reached_through_its_slug(
    sessionmaker, monkeypatch
):
    """A tool a reviewer gated must not run — and must not be satisfiable by a
    same-slug tool attached alongside it.

    The model addresses tools by name, so if one definition for a slug needs
    approval and another does not, resolving that ambiguity permissively would
    execute exactly the handler the reviewer meant to gate.
    """
    async with sessionmaker() as db:
        workspace = (
            await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))
        ).scalar_one()
        system = await _system_tool(db, "workspace_evidence_search")
        # Reuse the row if an earlier run of this test already created it: the
        # suite runs against a persistent database.
        gated = (
            await db.execute(select(ToolDefinition).where(
                ToolDefinition.workspace_id == workspace.id,
                ToolDefinition.slug == "workspace_evidence_search",
                ToolDefinition.version == "1"))
        ).scalars().first()
        if gated is None:
            gated = ToolDefinition(
                workspace_id=workspace.id, slug="workspace_evidence_search",
                name="Gated evidence search", version="1",
                description="Same slug, but a reviewer required approval.",
                input_schema=system.input_schema,
                handler_key="workspace_evidence_search",
                policy={"requires_approval": True},
            )
            db.add(gated)
        await db.flush()
        run, _ = await _make_tool_run(
            db, tool_slugs=("workspace_evidence_search",), extra_tool_ids=(gated.id,)
        )
        run_id = run.id

    provider = _ScriptedProvider("workspace_evidence_search")
    monkeypatch.setattr(engine_module, "build_provider", lambda *a, **kw: provider)
    await execute_run(sessionmaker, run_id, "tool-test-worker")

    assert (provider.offered[0] or []) == [], "the gated slug must not be offered"
    async with sessionmaker() as db:
        count = (
            await db.execute(select(func.count()).select_from(ToolCall)
                             .where(ToolCall.run_id == run_id))
        ).scalar_one()
        assert count == 0, "an approval-gated slug must never execute"
        events = [
            e.event_type for e in (
                await db.execute(select(RunEvent).where(RunEvent.run_id == run_id))
            ).scalars()
        ]
        assert "tools.withheld" in events, "withholding must be on the record"


async def test_a_tool_loop_cannot_spend_past_the_frozen_budget(
    sessionmaker, monkeypatch
):
    """The budget binds every provider call, not every turn.

    A turn used to mean exactly one call, so checking between turns was the same
    thing. Now that a turn can call the model repeatedly to use tools, a
    boundary-only check would let one looping participant spend several times
    the ceiling the researcher agreed to.
    """
    async with sessionmaker() as db:
        run, _ = await _make_tool_run(db, budget={"max_provider_calls": 2})
        run_id = run.id

    # Never stops asking for the tool, so only the budget can stop it.
    provider = _ScriptedProvider("workspace_evidence_search", always_call_tools=True)
    monkeypatch.setattr(engine_module, "build_provider", lambda *a, **kw: provider)
    await execute_run(sessionmaker, run_id, "tool-test-worker")

    async with sessionmaker() as db:
        run_row = await db.get(Run, run_id)
        assert run_row.status == "budget_stopped", (
            f"expected the budget to stop the loop, got status {run_row.status!r}"
        )
        assert run_row.failure_code == "budget_exceeded"
        assert run_row.provider_call_count <= 2, (
            f"the loop made {run_row.provider_call_count} calls against a budget of 2"
        )


async def test_an_abandoned_attempts_tool_calls_are_retired_not_erased(
    sessionmaker, monkeypatch
):
    """Lookups that really ran must stay on the record.

    A turn interrupted mid-flight is replayed on the same row, because
    (run_id, sequence) is unique. The calls its first attempt made really
    happened — external services really were queried — and tool.* events already
    reference those rows by id. Deleting them would strand those events and let
    the run claim fewer lookups than took place.
    """
    async with sessionmaker() as db:
        run, definition = await _make_tool_run(db)
        run_id = run.id
        da = (
            await db.execute(select(MeetingDefinitionAgent).where(
                MeetingDefinitionAgent.meeting_definition_id == definition.id))
        ).scalars().first()
        av = await db.get(AgentVersion, da.agent_version_id)
        td = await _system_tool(db, "workspace_evidence_search")
        # An interrupted attempt: a streaming turn with a call still in flight.
        stale_turn = RunTurn(
            workspace_id=run.workspace_id, run_id=run.id, sequence=0,
            round_number=1, position_in_round=0,
            agent_version_id=da.agent_version_id, role_type="lead",
            status="streaming",
            provider_config_id=da.provider_config_id,
            provider_model_id=da.provider_model_id,
            system_prompt_sha256=av.system_prompt_sha256,
            request_payload_sha256="0" * 64,
            started_at=datetime.now(timezone.utc),
        )
        db.add(stale_turn)
        await db.flush()
        abandoned = ToolCall(
            workspace_id=run.workspace_id, run_id=run.id, run_turn_id=stale_turn.id,
            sequence=0, tool_definition_id=td.id, provider_tool_call_id="call_stale",
            status="running", arguments_json={"query": "from the prior attempt"},
            arguments_sha256="0" * 64, started_at=datetime.now(timezone.utc),
        )
        db.add(abandoned)
        await db.commit()
        abandoned_id, stale_turn_id = abandoned.id, stale_turn.id

    provider = _ScriptedProvider("workspace_evidence_search")
    monkeypatch.setattr(engine_module, "build_provider", lambda *a, **kw: provider)
    await execute_run(sessionmaker, run_id, "tool-test-worker")

    async with sessionmaker() as db:
        retired = await db.get(ToolCall, abandoned_id)
        assert retired is not None, "the abandoned attempt's call must not be deleted"
        assert retired.status == "cancelled", (
            f"an in-flight call from a dropped attempt must be cancelled, "
            f"not left as {retired.status!r}"
        )
        seqs = sorted(
            c.sequence for c in (
                await db.execute(select(ToolCall)
                                 .where(ToolCall.run_turn_id == stale_turn_id))
            ).scalars()
        )
        assert seqs == [0, 1], (
            f"the retry must continue the sequence past the retired call, got {seqs}"
        )


async def test_scripted_demo_events_never_reach_a_real_provider_run(
    sessionmaker, monkeypatch
):
    """A run whose shape matches the demo scenario but runs on a real model must
    not have the scenario's simulated tool calls written into its record."""
    demo = get_demo_provider()
    async with sessionmaker() as db:
        run = await _make_demo_run(
            db, rounds=int(demo.scenario["match"]["rounds"]),
            lease_owner="tool-test-worker",
        )
        run.demo_mode = False  # real providers were selected at launch
        await db.commit()
        run_id, definition_id = run.id, run.meeting_definition_id
        project = await db.get(Project, run.project_id)
        project_slug = project.slug

    async with sessionmaker() as db:
        definition = await db.get(MeetingDefinition, definition_id)
        assert demo.matches_scenario(project_slug, definition.meeting_type,
                                     definition.rounds), \
            "this test is only meaningful while the run matches the demo scenario"

    provider = _ScriptedProvider(None)
    monkeypatch.setattr(engine_module, "build_provider", lambda *a, **kw: provider)
    await execute_run(sessionmaker, run_id, "tool-test-worker")

    async with sessionmaker() as db:
        count = (
            await db.execute(select(func.count()).select_from(ToolCall)
                             .where(ToolCall.run_id == run_id))
        ).scalar_one()
        assert count == 0, "simulated tool calls must never enter a real run's record"
        simulated_tool_events = [
            e.event_type for e in (
                await db.execute(select(RunEvent).where(RunEvent.run_id == run_id))
            ).scalars()
            if e.event_type.startswith("tool.")
            and (e.payload or {}).get("simulation") is True
        ]
        assert simulated_tool_events == []
