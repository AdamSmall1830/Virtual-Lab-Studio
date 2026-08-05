"""Baseline compatibility tests for the preserved upstream package.

These lock in the original call-count formulas, speaking order, transcript
sharing, and system-prompt behavior of src/virtual_lab before any adapter
work, per docs/CORE_INTEGRATION.md.
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "src"))

from virtual_lab.agent import Agent  # noqa: E402
from virtual_lab.prompts import SCIENTIFIC_CRITIC  # noqa: E402
import importlib  # noqa: E402

run_meeting_module = importlib.import_module("virtual_lab.run_meeting")
run_meeting = run_meeting_module.run_meeting


class FakeCompletions:
    def __init__(self, recorder: list[dict]) -> None:
        self.recorder = recorder

    def create(self, *, model, messages, temperature=None, tools=None, **kwargs):
        self.recorder.append({
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "tools": tools,
        })
        content = f"Response {len(self.recorder)}"
        message = SimpleNamespace(content=content, tool_calls=None)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


class FakeClient:
    def __init__(self, recorder: list[dict]) -> None:
        self.chat = SimpleNamespace(completions=FakeCompletions(recorder))


@pytest.fixture()
def recorded_calls(monkeypatch, tmp_path):
    calls: list[dict] = []
    monkeypatch.setattr(run_meeting_module, "OpenAI", lambda: FakeClient(calls))
    return calls


def _system_prompt(call: dict) -> str:
    assert call["messages"][0]["role"] == "system"
    return call["messages"][0]["content"]


LEAD = Agent("Principal Investigator", "strategy", "decide", "lead the meeting", "model-lead")
MEMBER_A = Agent("Specialist A", "a", "goal a", "role a", "model-a")
MEMBER_B = Agent("Specialist B", "b", "goal b", "role b", "model-b")
EXPERT = Agent("Machine Learning Specialist", "ml", "goal ml", "role ml", "model-ml")


def test_team_two_members_two_rounds_seven_calls_exact_order(recorded_calls, tmp_path):
    run_meeting(
        meeting_type="team", agenda="Agenda", save_dir=tmp_path,
        team_lead=LEAD, team_members=(MEMBER_A, MEMBER_B), num_rounds=2,
    )
    # R * (M + 1) + 1 = 2 * 3 + 1 = 7
    assert len(recorded_calls) == 7
    order = [_system_prompt(c) for c in recorded_calls]
    expected = [LEAD.prompt, MEMBER_A.prompt, MEMBER_B.prompt,
                LEAD.prompt, MEMBER_A.prompt, MEMBER_B.prompt, LEAD.prompt]
    assert order == expected


def test_individual_two_rounds_five_calls_exact_order(recorded_calls, tmp_path):
    run_meeting(
        meeting_type="individual", agenda="Agenda", save_dir=tmp_path,
        team_member=EXPERT, num_rounds=2,
    )
    # 2 * R + 1 = 5
    assert len(recorded_calls) == 5
    order = [_system_prompt(c) for c in recorded_calls]
    expected = [EXPERT.prompt, SCIENTIFIC_CRITIC.prompt,
                EXPERT.prompt, SCIENTIFIC_CRITIC.prompt, EXPERT.prompt]
    assert order == expected


def test_zero_round_team_lead_only(recorded_calls, tmp_path):
    run_meeting(
        meeting_type="team", agenda="Agenda", save_dir=tmp_path,
        team_lead=LEAD, team_members=(MEMBER_A,), num_rounds=0,
    )
    assert len(recorded_calls) == 1
    assert _system_prompt(recorded_calls[0]) == LEAD.prompt


def test_zero_round_individual_expert_only(recorded_calls, tmp_path):
    run_meeting(
        meeting_type="individual", agenda="Agenda", save_dir=tmp_path,
        team_member=EXPERT, num_rounds=0,
    )
    assert len(recorded_calls) == 1
    assert _system_prompt(recorded_calls[0]) == EXPERT.prompt


def test_specialist_sees_prior_transcript(recorded_calls, tmp_path):
    run_meeting(
        meeting_type="team", agenda="Agenda", save_dir=tmp_path,
        team_lead=LEAD, team_members=(MEMBER_A,), num_rounds=1,
    )
    # Second call (Specialist A, round 1) must include the lead's earlier response.
    member_call = recorded_calls[1]
    contents = [m.get("content", "") for m in member_call["messages"]]
    assert any("Response 1" in c for c in contents if isinstance(c, str))


def test_final_team_call_receives_final_synthesis_instruction(recorded_calls, tmp_path):
    run_meeting(
        meeting_type="team", agenda="My unique agenda", save_dir=tmp_path,
        team_lead=LEAD, team_members=(MEMBER_A,), num_rounds=1,
    )
    final_call = recorded_calls[-1]
    user_contents = [
        m["content"] for m in final_call["messages"]
        if m.get("role") == "user" and isinstance(m.get("content"), str)
    ]
    assert any("summary" in c.lower() for c in user_contents[-1:])


def test_mixed_models_used_per_agent(recorded_calls, tmp_path):
    run_meeting(
        meeting_type="team", agenda="Agenda", save_dir=tmp_path,
        team_lead=LEAD, team_members=(MEMBER_A, MEMBER_B), num_rounds=1,
    )
    models = [c["model"] for c in recorded_calls]
    assert models == ["model-lead", "model-a", "model-b", "model-lead"]


def test_agent_prompt_property_remains_compatible():
    agent = Agent("Immunologist", "immunology", "advise", "review designs", "gpt-4o")
    assert agent.prompt == (
        "You are a Immunologist. "
        "Your expertise is in immunology. "
        "Your goal is to advise. "
        "Your role is to review designs."
    )
    assert agent.message == {"role": "system", "content": agent.prompt}
