"""Unit tests for the async engine's turn plan (upstream-order preserving)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import build_turn_plan, expected_call_count  # noqa: E402


class FakeDefAgent:
    def __init__(self, position: int, role_type: str) -> None:
        self.position = position
        self.role_type = role_type


def test_team_plan_matches_upstream_formula_and_order():
    agents = [FakeDefAgent(0, "lead"), FakeDefAgent(1, "member"), FakeDefAgent(2, "member")]
    plan = build_turn_plan("team", 2, agents)
    assert len(plan) == expected_call_count("team", 2, 2) == 7
    roles = [(t.round_number, t.role_type, t.agent_position) for t in plan]
    assert roles == [
        (1, "lead", 0), (1, "member", 1), (1, "member", 2),
        (2, "lead", 0), (2, "member", 1), (2, "member", 2),
        (3, "lead", 0),
    ]
    assert plan[-1].is_final
    assert [t.call_index for t in plan] == list(range(7))


def test_individual_plan_matches_upstream_formula_and_order():
    agents = [FakeDefAgent(0, "expert"), FakeDefAgent(1, "critic")]
    plan = build_turn_plan("individual", 2, agents)
    assert len(plan) == expected_call_count("individual", 2, 0) == 5
    roles = [(t.round_number, t.role_type) for t in plan]
    assert roles == [
        (1, "expert"), (1, "critic"),
        (2, "expert"), (2, "critic"),
        (3, "expert"),
    ]
    assert plan[-1].is_final


def test_member_order_follows_position():
    agents = [FakeDefAgent(2, "member"), FakeDefAgent(0, "lead"), FakeDefAgent(1, "member")]
    plan = build_turn_plan("team", 1, agents)
    assert [t.agent_position for t in plan] == [0, 1, 2, 0]


def test_unsupported_meeting_type_rejected():
    with pytest.raises(ValueError):
        build_turn_plan("ensemble_merge", 1, [FakeDefAgent(0, "merger")])
