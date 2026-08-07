"""Async meeting engine.

Preserves upstream virtual_lab meeting semantics by reusing the upstream
prompt functions and speaking order:

- team: each round is lead then every specialist in order; a final lead-only
  synthesis turn follows (R * (M + 1) + 1 provider calls).
- individual: expert then critic per round; a final expert turn follows
  (2 * R + 1 provider calls).

Providers are injected (never constructed inside orchestration), every meeting
turn is persisted as an immutable run turn, and budgets/pause/cancel/interventions
are checked at every safe checkpoint (before each provider call).

A completed real run makes one further provider call to turn the transcript into
the structured record. It is not a meeting turn — no agent spoke it — so it is
recorded as a run event carrying its own usage and response hash rather than
being written into the transcript.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "src"))

from virtual_lab.agent import Agent  # noqa: E402
from virtual_lab.prompts import (  # noqa: E402
    individual_meeting_agent_prompt,
    individual_meeting_critic_prompt,
    individual_meeting_start_prompt,
    team_meeting_start_prompt,
    team_meeting_team_lead_final_prompt,
    team_meeting_team_lead_initial_prompt,
    team_meeting_team_lead_intermediate_prompt,
    team_meeting_team_member_prompt,
)

from .config import SPECS_DIR, get_settings
from .events import append_event
from .models import (
    AgentVersion,
    MeetingDefinition,
    MeetingDefinitionAgent,
    ProviderConfig,
    ProviderModel,
    Run,
    RunIntervention,
    RunSummary,
    RunTurn,
    ToolCall,
    ToolDefinition,
)
from .providers import (
    CompletionRequest,
    DemoProvider,
    ModelProvider,
    ProviderCallError,
    ProviderConfigurationError,
    build_provider,
    get_demo_provider,
    pricing_from_capabilities,
)
from .secretbox import decrypt_secret
from .provenance import (
    create_citations_from_summary,
    ensure_manifest_safe,
    validate_summary,
)

UTC = timezone.utc
logger = logging.getLogger("vls.engine")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


@dataclass
class PlannedTurn:
    call_index: int
    round_number: int  # 1-based; final synthesis round == rounds + 1
    position_in_round: int
    role_type: str
    agent_position: int  # position in meeting_definition_agents
    is_final: bool


def build_turn_plan(
    meeting_type: str,
    rounds: int,
    agents: list[MeetingDefinitionAgent],
) -> list[PlannedTurn]:
    """Upstream-compatible speaking order."""
    plan: list[PlannedTurn] = []
    call_index = 0
    by_role = {a.role_type: a for a in agents}
    if meeting_type == "team":
        lead = by_role["lead"]
        members = sorted(
            (a for a in agents if a.role_type == "member"), key=lambda a: a.position
        )
        for round_number in range(1, rounds + 1):
            plan.append(PlannedTurn(call_index, round_number, 0, "lead", lead.position, False))
            call_index += 1
            for idx, member in enumerate(members, start=1):
                plan.append(PlannedTurn(call_index, round_number, idx, "member", member.position, False))
                call_index += 1
        plan.append(PlannedTurn(call_index, rounds + 1, 0, "lead", lead.position, True))
    elif meeting_type == "individual":
        expert = by_role["expert"]
        critic = by_role["critic"]
        for round_number in range(1, rounds + 1):
            plan.append(PlannedTurn(call_index, round_number, 0, "expert", expert.position, False))
            call_index += 1
            plan.append(PlannedTurn(call_index, round_number, 1, "critic", critic.position, False))
            call_index += 1
        plan.append(PlannedTurn(call_index, rounds + 1, 0, "expert", expert.position, True))
    else:
        raise ValueError(f"Unsupported meeting type for execution: {meeting_type}")
    return plan


def expected_call_count(meeting_type: str, rounds: int, member_count: int) -> int:
    if meeting_type == "team":
        return rounds * (member_count + 1) + 1
    if meeting_type == "individual":
        return 2 * rounds + 1
    raise ValueError(f"Unsupported meeting type: {meeting_type}")


class RunCancelled(Exception):
    pass


class BudgetExceeded(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class RunContext:
    run: Run
    definition: MeetingDefinition
    def_agents: list[MeetingDefinitionAgent]
    agent_versions: dict[uuid.UUID, AgentVersion]
    provider_configs: dict[uuid.UUID, ProviderConfig]
    provider_models: dict[uuid.UUID, ProviderModel]
    project_slug: str


def _upstream_agent(version: AgentVersion, profile_title: str, model_key: str) -> Agent:
    return Agent(
        title=profile_title,
        expertise=version.expertise,
        goal=version.goal,
        role=version.role,
        model=model_key,
    )


async def _load_context(db: AsyncSession, run: Run) -> RunContext:
    definition = await db.get(MeetingDefinition, run.meeting_definition_id)
    assert definition is not None
    def_agents = list(
        (
            await db.execute(
                select(MeetingDefinitionAgent)
                .where(MeetingDefinitionAgent.meeting_definition_id == definition.id)
                .order_by(MeetingDefinitionAgent.position)
            )
        ).scalars()
    )
    agent_versions: dict[uuid.UUID, AgentVersion] = {}
    provider_configs: dict[uuid.UUID, ProviderConfig] = {}
    provider_models: dict[uuid.UUID, ProviderModel] = {}
    for da in def_agents:
        if da.agent_version_id not in agent_versions:
            av = await db.get(AgentVersion, da.agent_version_id)
            assert av is not None
            agent_versions[da.agent_version_id] = av
        if da.provider_config_id not in provider_configs:
            pc = await db.get(ProviderConfig, da.provider_config_id)
            assert pc is not None
            provider_configs[da.provider_config_id] = pc
        if da.provider_model_id not in provider_models:
            pm = await db.get(ProviderModel, da.provider_model_id)
            assert pm is not None
            provider_models[da.provider_model_id] = pm
    project_slug = (
        await db.execute(
            text("SELECT slug FROM projects WHERE id = :pid"), {"pid": str(run.project_id)}
        )
    ).scalar_one()
    return RunContext(
        run=run,
        definition=definition,
        def_agents=def_agents,
        agent_versions=agent_versions,
        provider_configs=provider_configs,
        provider_models=provider_models,
        project_slug=project_slug,
    )


class LeaseLost(Exception):
    """Another worker reclaimed this run mid-call; abandon without writing."""


async def _claim_lease(
    db: AsyncSession, run_id: uuid.UUID, worker_id: str, lease_seconds: int
) -> bool:
    """Take ownership of a run, but never from a worker holding a live lease.

    A duplicate dispatch or a delayed task must not produce two active writers,
    so ownership is only granted when the run is unowned, already ours, or its
    lease has expired. Returns False when someone else is legitimately running
    it — the caller must not start.
    """
    result = await db.execute(
        update(Run)
        .where(
            Run.id == run_id,
            or_(
                Run.lease_owner.is_(None),
                Run.lease_owner == worker_id,
                Run.lease_expires_at.is_(None),
                Run.lease_expires_at <= datetime.now(UTC),
            ),
        )
        .values(
            heartbeat_at=datetime.now(UTC),
            lease_expires_at=datetime.now(UTC) + timedelta(seconds=lease_seconds),
            lease_owner=worker_id,
        )
    )
    await db.commit()
    return result.rowcount == 1


async def _fence_lease(
    db: AsyncSession, run_id: uuid.UUID, worker_id: str, lease_seconds: int
) -> bool:
    """Owner-conditional lease renewal *inside the caller's transaction*.

    Commits nothing. The caller commits this fence together with the writes it
    protects, so a worker that lost the run cannot land a stale turn: either
    both the fence and the writes commit, or neither does.

    Returns False when ownership has been lost — the caller must abandon.
    """
    result = await db.execute(
        update(Run)
        .where(
            Run.id == run_id,
            Run.lease_owner == worker_id,
            Run.lease_expires_at.is_not(None),
            Run.lease_expires_at > datetime.now(UTC),
        )
        .values(
            heartbeat_at=datetime.now(UTC),
            lease_expires_at=datetime.now(UTC) + timedelta(seconds=lease_seconds),
        )
    )
    return result.rowcount == 1


async def _renew_lease(
    db: AsyncSession, run_id: uuid.UUID, worker_id: str, lease_seconds: int
) -> bool:
    """Extend the lease only while this worker still holds it, and commit."""
    held = await _fence_lease(db, run_id, worker_id, lease_seconds)
    await db.commit()
    return held


class _LeaseHeartbeat:
    """Keeps a run's lease alive across an arbitrarily long provider call.

    A single call can run for minutes (model latency plus rate-limit backoff),
    which no fixed lease can bound. Rather than inflating the lease — which
    would also delay recovery of genuinely dead workers — this renews it on a
    timer from a background task. If a renewal finds the lease is no longer
    ours, ``lost`` is set and the caller must abandon the attempt.

    Uses its own session: an AsyncSession cannot be shared between tasks.
    """

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        run_id: uuid.UUID,
        worker_id: str,
        lease_seconds: int,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._run_id = run_id
        self._worker_id = worker_id
        self._lease_seconds = lease_seconds
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None
        self.lost = False

    async def __aenter__(self) -> _LeaseHeartbeat:
        self._task = asyncio.create_task(self._loop())
        return self

    async def __aexit__(self, *exc_info: Any) -> bool:
        self._stop.set()
        if self._task is not None:
            with contextlib.suppress(Exception):
                await self._task
        return False

    async def _loop(self) -> None:
        # Renew well inside the lease window so one slow renewal is survivable.
        interval = max(5.0, self._lease_seconds / 3)
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=interval)
                return  # stopped: the call finished
            except TimeoutError:
                pass
            try:
                async with self._sessionmaker() as db:
                    if not await _renew_lease(
                        db, self._run_id, self._worker_id, self._lease_seconds
                    ):
                        self.lost = True
                        return
            except Exception:  # noqa: BLE001
                # A transient DB error must not kill the run; the next tick
                # retries, and a truly dead lease is caught after the call.
                logger.warning("Lease heartbeat failed for run %s", self._run_id)


async def _apply_pending_interventions(
    db: AsyncSession, ctx: RunContext, checkpoint: str, messages: list[dict[str, str]]
) -> None:
    pending = list(
        (
            await db.execute(
                select(RunIntervention).where(
                    RunIntervention.run_id == ctx.run.id,
                    RunIntervention.kind.in_(["instruction", "evidence_addition"]),
                    RunIntervention.applied_at_checkpoint.is_(None),
                ).order_by(RunIntervention.created_at)
            )
        ).scalars()
    )
    for iv in pending:
        if iv.content:
            messages.append(
                {
                    "role": "user",
                    "content": f"[Human intervention] {iv.content}",
                }
            )
        iv.applied_at_checkpoint = checkpoint
        await append_event(
            db,
            workspace_id=ctx.run.workspace_id,
            run_id=ctx.run.id,
            event_type="human.intervention_added",
            payload={"intervention_id": str(iv.id), "kind": iv.kind, "applied_at_checkpoint": checkpoint},
            actor_user_id=iv.actor_user_id,
            commit=False,
        )
    if pending:
        await db.commit()


async def _checkpoint(
    db: AsyncSession,
    ctx: RunContext,
    checkpoint: str,
    messages: list[dict[str, str]],
    worker_id: str,
    lease_seconds: int,
) -> None:
    """Safe checkpoint: renew lease, honor pause/cancel, apply interventions, check budget."""
    if not await _renew_lease(db, ctx.run.id, worker_id, lease_seconds):
        raise LeaseLost(f"run {ctx.run.id} lease lost at checkpoint {checkpoint}")
    await db.refresh(ctx.run)
    await append_event(
        db,
        workspace_id=ctx.run.workspace_id,
        run_id=ctx.run.id,
        event_type="checkpoint.reached",
        payload={"checkpoint": checkpoint},
    )
    await _apply_pending_interventions(db, ctx, checkpoint, messages)

    while True:
        await db.refresh(ctx.run)
        control = ctx.run.control_requested
        if control == "cancel" or ctx.run.status == "cancelling":
            raise RunCancelled()
        if control == "pause" or ctx.run.status == "pausing":
            if ctx.run.status != "paused":
                ctx.run.status = "paused"
                ctx.run.control_requested = None
                await db.commit()
                await append_event(
                    db,
                    workspace_id=ctx.run.workspace_id,
                    run_id=ctx.run.id,
                    event_type="run.paused",
                    payload={"checkpoint": checkpoint},
                )
        if ctx.run.status == "paused":
            if control == "resume":
                ctx.run.status = "running"
                ctx.run.control_requested = None
                await db.commit()
                await append_event(
                    db,
                    workspace_id=ctx.run.workspace_id,
                    run_id=ctx.run.id,
                    event_type="run.resumed",
                    payload={"checkpoint": checkpoint},
                )
                await _apply_pending_interventions(db, ctx, checkpoint, messages)
                break
            await asyncio.sleep(1.0)
            if not await _renew_lease(db, ctx.run.id, worker_id, lease_seconds):
                raise LeaseLost(f"run {ctx.run.id} lease lost while paused")
            continue
        break

    budget = ctx.definition.budget or {}
    max_calls = budget.get("max_provider_calls")
    max_cost = budget.get("max_cost_usd")
    if max_calls is not None and ctx.run.provider_call_count >= int(max_calls):
        raise BudgetExceeded("max_provider_calls")
    if max_cost is not None and float(ctx.run.actual_cost_usd) > float(max_cost):
        raise BudgetExceeded("max_cost_usd")


def _turn_prompt(
    ctx: RunContext,
    planned: PlannedTurn,
    upstream_agents: dict[int, Agent],
    rounds: int,
) -> str:
    d = ctx.definition
    agent = upstream_agents[planned.agent_position]
    questions = tuple(d.questions or ())
    rules = tuple(d.rules or ())
    contexts = tuple(d.contexts or ())
    summaries = tuple(d.previous_summary_refs or ())
    if d.meeting_type == "team":
        lead = next(upstream_agents[a.position] for a in ctx.def_agents if a.role_type == "lead")
        if planned.role_type == "lead":
            if planned.is_final:
                return team_meeting_team_lead_final_prompt(
                    team_lead=lead, agenda=d.agenda, agenda_questions=questions, agenda_rules=rules
                )
            if planned.round_number == 1:
                return team_meeting_team_lead_initial_prompt(team_lead=lead)
            return team_meeting_team_lead_intermediate_prompt(
                team_lead=lead, round_num=planned.round_number - 1, num_rounds=rounds
            )
        return team_meeting_team_member_prompt(
            team_member=agent, round_num=planned.round_number, num_rounds=rounds
        )
    # individual
    expert = next(upstream_agents[a.position] for a in ctx.def_agents if a.role_type == "expert")
    critic = next(upstream_agents[a.position] for a in ctx.def_agents if a.role_type == "critic")
    if planned.role_type == "critic":
        return individual_meeting_critic_prompt(critic=critic, agent=expert)
    if planned.round_number == 1 and not planned.is_final and planned.call_index == 0:
        return individual_meeting_start_prompt(
            team_member=expert,
            agenda=d.agenda,
            agenda_questions=questions,
            agenda_rules=rules,
            summaries=summaries,
            contexts=contexts,
        )
    return individual_meeting_agent_prompt(critic=critic, agent=expert)


def _fallback_summary(ctx: RunContext, transcript: list[dict[str, str]]) -> dict[str, Any]:
    """Schema-valid structured summary for non-scripted runs."""
    d = ctx.definition
    return {
        "agenda": d.agenda or "(no agenda)",
        "executive_summary": (
            "[Simulation] Deterministic demo meeting completed. This structured summary is "
            "simulated output for interface testing, not a scientific result."
        ),
        "role_contributions": [],
        "recommendation": {
            "decision": "No scientific recommendation — simulated output.",
            "rationale": "Connect a real model provider and reviewed evidence before use.",
            "conditions": [],
        },
        "question_answers": [
            {
                "question": q,
                "answer": "[Simulation] Not answered by the demo scenario.",
                "evidence_ids": [],
                "confidence": 0.1,
            }
            for q in (d.questions or [])
        ],
        "evidence": [],
        "assumptions": [],
        "disagreements": [],
        "risks_and_limitations": [
            {
                "risk": "Simulated output only; no scientific validity.",
                "severity": "high",
                "likelihood": "likely",
                "mitigation": "Re-run with a configured model provider and reviewed evidence.",
            }
        ],
        "next_steps": [],
        "confidence": {
            "overall": 0.1,
            "basis": "Deterministic simulation without model reasoning.",
            "uncertainty": "All content is placeholder output.",
        },
        "disclosure": {
            "model_generated": True,
            "human_review_required": True,
            "limitations": [get_demo_provider().disclosure],
        },
    }


# ---------------------------------------------------------------------------
# Structured synthesis
#
# The structured summary is what researchers read, quote and export, so every
# judgement in it — the recommendation, the per-question answers and above all
# the confidence numbers — has to come from the model that actually held the
# meeting. Filling those fields with application-authored defaults would put
# words, and a fabricated confidence score, into the model's mouth. Where the
# extraction cannot be performed we say so in the record itself rather than
# substituting a plausible-looking value.
# ---------------------------------------------------------------------------

_SYNTHESIS_SYSTEM_PROMPT = (
    "You are the recording secretary for a scientific meeting. You produce the "
    "structured record of what the meeting actually decided. Report only what the "
    "transcript contains: never introduce a claim, number, citation or conclusion "
    "that was not discussed, and state plainly wherever the discussion left "
    "something unresolved. Respond with a single JSON object and nothing else."
)

_UNEXTRACTED_ANSWER = (
    "Not extracted. The structured synthesis step did not produce a usable record "
    "for this meeting; read the transcript for what was actually said."
)

_UNEXTRACTED_BASIS = (
    "No model-derived confidence is available: the structured synthesis step did "
    "not complete, so this is not a scored judgement."
)


def _synthesis_prompt(ctx: RunContext, roster: dict[str, str]) -> str:
    """Ask the meeting's own model for the structured record of what it decided."""
    d = ctx.definition
    q_block = "\n".join(f"- {q}" for q in (d.questions or [])) or "- (no agenda questions)"
    keys = [
        str(e.get("evidence_key"))
        for e in ((d.definition_json or {}).get("evidence") or [])
        if e.get("evidence_key")
    ]
    ev_block = "\n".join(f"- {k}" for k in keys) or "- (no evidence was attached)"
    roster_block = "\n".join(f"- {t}" for t in roster) or "- (none)"
    return (
        "The meeting above is complete. Produce its structured record as a single "
        "JSON object with exactly these keys:\n\n"
        '"executive_summary": string — what the meeting concluded, in prose.\n'
        '"recommendation": {"decision": string, "rationale": string, "conditions": '
        "[string]} — the course of action the meeting settled on. If it did not "
        'settle on one, say exactly that in "decision" rather than inventing one.\n'
        '"question_answers": one entry per agenda question below, in the same order, '
        'quoting the question verbatim: {"question": string, "answer": string, '
        '"evidence_ids": [string], "confidence": number between 0 and 1, "open_issue": '
        "string or null}. Where the discussion did not answer a question, say what is "
        "actually known, give it a correspondingly low confidence, and put what "
        'remains open in "open_issue".\n'
        '"confidence": {"overall": number between 0 and 1, "basis": string, '
        '"uncertainty": string} — your own confidence in this record, and why.\n'
        '"evidence": [{"evidence_id": string, "claim": string, "support_type": '
        '"supports"|"contradicts"|"context"|"uncertain", "locator": string or null}] '
        "— claims the discussion drew from the attached evidence. Use ONLY the "
        'evidence IDs listed below, exactly as written. Never invent an ID.\n'
        '"assumptions": [{"assumption": string, "impact": "low"|"medium"|"high", '
        '"validation": string}]\n'
        '"disagreements": [{"topic": string, "positions": [{"agent_title": string, '
        '"position": string}] (at least two), "resolution_status": '
        '"resolved"|"lead_decision"|"unresolved"|"needs_evidence"}]\n'
        '"risks_and_limitations": [{"risk": string, "severity": '
        '"low"|"medium"|"high"|"critical", "likelihood": "unlikely"|"possible"|"likely", '
        '"mitigation": string}]\n'
        '"next_steps": [{"action": string, "owner_role": string, '
        '"acceptance_criterion": string, "priority": "now"|"next"|"later"}]\n'
        '"role_contributions": [{"agent_title": string, "contribution": string}] — use '
        "only the participant titles listed below, exactly as written.\n\n"
        "Use an empty array for any list the discussion does not support. Do not pad.\n\n"
        f"Agenda questions:\n{q_block}\n\n"
        f"Attached evidence IDs:\n{ev_block}\n\n"
        f"Participants:\n{roster_block}\n"
    )


def _parse_synthesis(raw: str) -> dict[str, Any] | None:
    """Parse the model's JSON, tolerating a markdown fence or surrounding prose."""
    text_body = raw.strip()
    if text_body.startswith("```"):
        text_body = text_body.split("```")[1] if "```" in text_body[3:] else text_body[3:]
        if text_body.lstrip().startswith("json"):
            text_body = text_body.lstrip()[4:]
    start, end = text_body.find("{"), text_body.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text_body[start:end + 1])
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _real_summary(
    ctx: RunContext,
    transcript: list[dict[str, str]],
    extracted: dict[str, Any] | None,
    roster: dict[str, str],
    note: str,
) -> dict[str, Any]:
    """Schema-valid structured summary for real (non-simulation) provider runs.

    `extracted` is the model's own structured record, or None when the synthesis
    step could not run. Nothing in the returned document is invented on the
    model's behalf: fields the model did not supply come back empty, and the
    absence of a model-derived confidence is stated rather than scored.
    """
    d = ctx.definition
    final_text = ""
    for msg in reversed(transcript):
        if msg.get("role") == "assistant" and msg.get("content"):
            final_text = msg["content"]
            break
    src = extracted or {}

    def _list(key: str) -> list[Any]:
        value = src.get(key)
        return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []

    # The model is instructed to cite only the evidence frozen into this meeting,
    # but a prompt is not an enforcement mechanism. Any identifier it invents is
    # dropped here rather than persisted: a citation pointing at a source that
    # was never attached is the most damaging thing this document could carry.
    frozen_keys = {
        str(e.get("evidence_key"))
        for e in ((d.definition_json or {}).get("evidence") or [])
        if e.get("evidence_key")
    }
    dropped_citations = 0

    def _keep_frozen(ids: Any) -> list[str]:
        nonlocal dropped_citations
        kept: list[str] = []
        for ref in ids or []:
            if isinstance(ref, str) and ref in frozen_keys:
                kept.append(ref)
            else:
                dropped_citations += 1
        return kept

    exec_summary = str(src.get("executive_summary") or "").strip()
    if not exec_summary:
        exec_summary = final_text.strip()[:1500] or "The meeting produced no final synthesis."

    rec = src.get("recommendation")
    if isinstance(rec, dict) and str(rec.get("decision") or "").strip():
        recommendation = {
            "decision": str(rec.get("decision")),
            "rationale": str(rec.get("rationale") or ""),
            "conditions": [str(c) for c in (rec.get("conditions") or []) if isinstance(c, str)],
        }
    else:
        recommendation = {
            "decision": "Not extracted — no recommendation was recorded for this meeting.",
            "rationale": note,
            "conditions": [],
        }

    questions = list(d.questions or [])
    supplied = {
        str(a.get("question", "")).strip(): a
        for a in _list("question_answers")
    }
    question_answers = []
    for q in questions:
        a = supplied.get(q.strip())
        conf = a.get("confidence") if isinstance(a, dict) else None
        if a is not None and isinstance(conf, (int, float)) and 0 <= float(conf) <= 1:
            entry: dict[str, Any] = {
                "question": q,
                "answer": str(a.get("answer") or _UNEXTRACTED_ANSWER),
                "evidence_ids": _keep_frozen(a.get("evidence_ids")),
                "confidence": float(conf),
            }
            if isinstance(a.get("open_issue"), str) and a["open_issue"].strip():
                entry["open_issue"] = a["open_issue"]
            question_answers.append(entry)
        else:
            # No model-stated answer: record the absence, do not score it.
            question_answers.append({
                "question": q,
                "answer": _UNEXTRACTED_ANSWER,
                "evidence_ids": [],
                "confidence": 0.0,
                "open_issue": note,
            })

    conf_obj = src.get("confidence")
    overall = conf_obj.get("overall") if isinstance(conf_obj, dict) else None
    if isinstance(overall, (int, float)) and 0 <= float(overall) <= 1:
        confidence = {
            "overall": float(overall),
            "basis": str(conf_obj.get("basis") or "Stated by the model that held the meeting."),
            "uncertainty": str(conf_obj.get("uncertainty") or "Model-stated; not validated."),
        }
    else:
        confidence = {"overall": 0.0, "basis": _UNEXTRACTED_BASIS, "uncertainty": note}

    # agent_id is resolved from our own roster; the model is only asked for a
    # title, so it can never mint an identifier for a participant.
    role_contributions = []
    for rc in _list("role_contributions"):
        title = str(rc.get("agent_title") or "").strip()
        if title in roster and str(rc.get("contribution") or "").strip():
            role_contributions.append({
                "agent_id": roster[title],
                "agent_title": title,
                "contribution": str(rc["contribution"]),
            })

    evidence_claims = []
    for item in _list("evidence"):
        if str(item.get("evidence_id", "")) in frozen_keys:
            evidence_claims.append(item)
        else:
            dropped_citations += 1

    limitations = [
        "AI-generated decision support from a real model provider; not "
        "experimentally, clinically, ethically, or legally validated."
    ]
    if extracted is None:
        limitations.append(note)
    if dropped_citations:
        limitations.append(
            f"{dropped_citations} citation(s) in the model's record referred to evidence "
            "that was not attached to this meeting and were removed."
        )

    return {
        "agenda": d.agenda or "(no agenda)",
        "executive_summary": exec_summary,
        "role_contributions": role_contributions,
        "recommendation": recommendation,
        "question_answers": question_answers,
        "evidence": evidence_claims,
        "assumptions": _list("assumptions"),
        "disagreements": _list("disagreements"),
        "risks_and_limitations": _list("risks_and_limitations"),
        "next_steps": _list("next_steps"),
        "confidence": confidence,
        "disclosure": {
            "model_generated": True,
            "human_review_required": True,
            "limitations": limitations,
        },
    }


def _md(value: Any) -> str:
    return str(value or "").strip()


def _summary_markdown(
    title: str, disclosure_line: str, summary_json: dict[str, Any], final_text: str
) -> str:
    """Render the whole structured record as the readable document.

    Every field the record holds is rendered here. This markdown is what exports
    carry and what a reader is most likely to quote, so a finding that lives only
    in ``summary_json`` is in practice invisible — the disagreements the team
    registered and the confidence the model stated matter most precisely when
    someone is deciding how much weight to give the result.

    Sections are omitted when empty rather than rendered as empty headings, so a
    sparse record reads as sparse instead of broken.
    """
    out: list[str] = [f"# {title}", "", f"> {disclosure_line}", ""]

    def heading(text: str) -> None:
        out.extend([f"## {text}", ""])

    def bullets(items: list[str]) -> None:
        out.extend(f"- {item}" for item in items)
        out.append("")

    if exec_summary := _md(summary_json.get("executive_summary")):
        heading("Executive summary")
        out.extend([exec_summary, ""])

    rec = summary_json.get("recommendation") or {}
    if decision := _md(rec.get("decision")):
        heading("Recommendation")
        out.extend([f"**{decision}**", ""])
        if rationale := _md(rec.get("rationale")):
            out.extend([rationale, ""])
        if conditions := [_md(c) for c in (rec.get("conditions") or []) if _md(c)]:
            out.extend(["**Required conditions**", ""])
            bullets(conditions)

    if question_answers := (summary_json.get("question_answers") or []):
        heading("Agenda questions")
        for qa in question_answers:
            out.extend([f"### {_md(qa.get('question'))}", "", _md(qa.get("answer")), ""])
            meta: list[str] = []
            confidence = qa.get("confidence")
            if isinstance(confidence, (int, float)):
                meta.append(f"Stated confidence {float(confidence):.2f}")
            if ids := [_md(i) for i in (qa.get("evidence_ids") or []) if _md(i)]:
                meta.append("Evidence " + ", ".join(f"`{i}`" for i in ids))
            if meta:
                out.extend([f"_{' · '.join(meta)}_", ""])
            if open_issue := _md(qa.get("open_issue")):
                out.extend([f"_Open issue: {open_issue}_", ""])

    if disagreements := (summary_json.get("disagreements") or []):
        heading("Disagreements")
        for item in disagreements:
            status = _md(item.get("resolution_status")).replace("_", " ")
            out.append(f"### {_md(item.get('topic'))}")
            out.append("")
            if status:
                out.extend([f"_Resolution: {status}_", ""])
            for position in item.get("positions") or []:
                out.append(
                    f"- **{_md(position.get('agent_title'))}** — {_md(position.get('position'))}"
                )
            out.append("")

    if assumptions := (summary_json.get("assumptions") or []):
        heading("Assumptions")
        for item in assumptions:
            line = f"- {_md(item.get('assumption'))}"
            if impact := _md(item.get("impact")):
                line += f" _(impact: {impact})_"
            out.append(line)
            if validation := _md(item.get("validation")):
                out.append(f"  - How to validate: {validation}")
        out.append("")

    if risks := (summary_json.get("risks_and_limitations") or []):
        heading("Risks and limitations")
        for item in risks:
            qualifiers = " · ".join(
                q for q in (
                    f"severity: {_md(item.get('severity'))}" if _md(item.get("severity")) else "",
                    f"likelihood: {_md(item.get('likelihood'))}" if _md(item.get("likelihood")) else "",
                ) if q
            )
            line = f"- {_md(item.get('risk'))}"
            if qualifiers:
                line += f" _({qualifiers})_"
            out.append(line)
            if mitigation := _md(item.get("mitigation")):
                out.append(f"  - Mitigation: {mitigation}")
        out.append("")

    if next_steps := (summary_json.get("next_steps") or []):
        heading("Next steps")
        for item in next_steps:
            qualifiers = " · ".join(
                q for q in (
                    _md(item.get("owner_role")),
                    f"priority: {_md(item.get('priority'))}" if _md(item.get("priority")) else "",
                ) if q
            )
            line = f"- {_md(item.get('action'))}"
            if qualifiers:
                line += f" _({qualifiers})_"
            out.append(line)
            if criterion := _md(item.get("acceptance_criterion")):
                out.append(f"  - Done when: {criterion}")
        out.append("")

    if evidence := (summary_json.get("evidence") or []):
        heading("Evidence cited")
        for item in evidence:
            line = f"- `{_md(item.get('evidence_id'))}` — {_md(item.get('claim'))}"
            if support := _md(item.get("support_type")):
                line += f" _({support})_"
            out.append(line)
            if locator := _md(item.get("locator")):
                out.append(f"  - Locator: {locator}")
        out.append("")

    if contributions := (summary_json.get("role_contributions") or []):
        heading("Team member contributions")
        for item in contributions:
            out.extend([f"### {_md(item.get('agent_title'))}", "", _md(item.get("contribution")), ""])

    confidence_obj = summary_json.get("confidence") or {}
    overall = confidence_obj.get("overall")
    if isinstance(overall, (int, float)):
        heading("Confidence")
        out.extend([f"**{float(overall):.2f}** — as stated by the model that held the meeting.", ""])
        if basis := _md(confidence_obj.get("basis")):
            out.extend([f"**Basis.** {basis}", ""])
        if uncertainty := _md(confidence_obj.get("uncertainty")):
            out.extend([f"**Remaining uncertainty.** {uncertainty}", ""])

    disclosure = summary_json.get("disclosure") or {}
    if limitations := [_md(x) for x in (disclosure.get("limitations") or []) if _md(x)]:
        heading("Disclosure")
        bullets(limitations)
        if disclosure.get("human_review_required"):
            out.extend(["Human expert review is required before this result is relied on.", ""])

    if final := final_text.strip():
        heading("Final synthesis (verbatim)")
        out.extend([final, ""])

    return "\n".join(out).rstrip() + "\n"


def _accumulate_wall_seconds(run: Run, attempt_started_at: datetime) -> Decimal:
    """Wall time is the sum of every attempt, not only the most recent one.

    A run that was resumed after a failure would otherwise report just the time
    its final attempt took, understating the work behind the result and
    contradicting the created/finished span shown beside it.
    """
    elapsed = (datetime.now(UTC) - attempt_started_at).total_seconds()
    return Decimal(str(round(float(run.wall_seconds or 0) + elapsed, 3)))


async def _run_structured_synthesis(
    db: AsyncSession,
    sessionmaker: async_sessionmaker[AsyncSession],
    ctx: RunContext,
    messages: list[dict[str, str]],
    providers_by_config: dict[uuid.UUID, ModelProvider],
    roster: dict[str, str],
    final_agent_position: int,
    worker_id: str,
    lease_seconds: int,
) -> tuple[dict[str, Any] | None, str]:
    """One extra provider call that turns the transcript into the structured record.

    Returns ``(extracted, note)``. ``extracted`` is None when the step could not
    run; ``note`` then states why, and that reason is written into the summary in
    place of the values the model would have supplied.

    This call is deliberately not persisted as a run turn: it is not something an
    agent said in the meeting, and recording it as a turn would misrepresent the
    transcript. Its usage is added to the run's counters and its provenance is
    appended as an immutable run event.
    """
    run = ctx.run
    d = ctx.definition

    # The budget is frozen at launch and counted in provider calls, so this call
    # has to fit inside it like any other.
    budget = d.budget or {}
    max_calls = budget.get("max_provider_calls")
    max_cost = budget.get("max_cost_usd")
    if max_calls is not None and run.provider_call_count >= int(max_calls):
        return None, (
            "The structured synthesis step was skipped: the meeting had already "
            "used its full provider-call budget."
        )
    if max_cost is not None and float(run.actual_cost_usd) >= float(max_cost):
        return None, (
            "The structured synthesis step was skipped: the meeting had already "
            "reached its cost budget."
        )

    # Ask the agent that closed the meeting, so the record comes from the same
    # model and provider that produced the final synthesis.
    da = next(a for a in ctx.def_agents if a.position == final_agent_position)
    pm = ctx.provider_models[da.provider_model_id]
    pc = ctx.provider_configs[da.provider_config_id]
    provider = providers_by_config[da.provider_config_id]

    convo = list(messages) + [{"role": "user", "content": _synthesis_prompt(ctx, roster)}]
    request = CompletionRequest(
        model=pm.model_key,
        system_prompt=_SYNTHESIS_SYSTEM_PROMPT,
        messages=convo,
        temperature=0.0,
        run_id=str(run.id),
        call_index=-1,
        agent_title="Recording secretary",
        role_type=da.role_type,
        round_number=0,
        is_final=True,
    )

    try:
        async with _LeaseHeartbeat(sessionmaker, run.id, worker_id, lease_seconds) as hb:
            if isinstance(provider, DemoProvider):
                result = await provider.complete(request, scripted=False)
            else:
                result = await provider.complete(request)
        if hb.lost or not await _renew_lease(db, run.id, worker_id, lease_seconds):
            raise LeaseLost(f"run {run.id} lease lost during structured synthesis")
    except LeaseLost:
        raise
    except Exception as exc:  # provider error, timeout, rate limit
        logger.warning("Structured synthesis failed for run %s: %s", run.id, exc)
        await append_event(
            db, workspace_id=run.workspace_id, run_id=run.id,
            event_type="summary.synthesis_failed",
            payload={"error_type": type(exc).__name__},
        )
        return None, (
            f"The structured synthesis step did not complete ({type(exc).__name__}); "
            "the fields it would have filled are marked as not extracted."
        )

    run.provider_call_count += 1
    run.input_tokens += result.input_tokens
    run.cached_input_tokens += result.cached_input_tokens
    run.output_tokens += result.output_tokens
    run.actual_cost_usd = Decimal(str(run.actual_cost_usd)) + Decimal(str(result.cost_usd))
    if not await _fence_lease(db, run.id, worker_id, lease_seconds):
        # Read the id before rolling back: the rollback expires every ORM
        # attribute and touching one here would trigger a lazy load.
        rid = run.id
        await db.rollback()
        raise LeaseLost(f"run {rid} lease lost before recording synthesis usage")
    await db.commit()

    await append_event(
        db, workspace_id=run.workspace_id, run_id=run.id,
        event_type="summary.synthesis_completed",
        payload={
            "provider_type": pc.provider_type,
            "model": pm.model_key,
            "provider_request_id": result.provider_request_id,
            "input_tokens": result.input_tokens,
            "output_tokens": result.output_tokens,
            "cost_usd": float(result.cost_usd),
            "latency_ms": result.latency_ms,
            "response_sha256": sha256_text(result.content),
            "simulation": result.is_simulation,
        },
    )

    parsed = _parse_synthesis(result.content)
    if parsed is None:
        return None, (
            "The structured synthesis step returned output that was not valid JSON; "
            "the fields it would have filled are marked as not extracted."
        )
    return parsed, "Structured record produced by the model that held the meeting."


async def execute_run(
    sessionmaker: async_sessionmaker[AsyncSession], run_id: uuid.UUID, worker_id: str
) -> None:
    settings = get_settings()
    lease_seconds = settings.worker_lease_seconds
    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        assert run is not None
        if run.status in {"completed", "failed", "cancelled", "budget_stopped"}:
            return  # already terminal (e.g. duplicate reclaim); nothing to do
        ctx = await _load_context(db, run)
        # Take ownership before doing anything. Every later renewal is fenced
        # on still holding it.
        if not await _claim_lease(db, run_id, worker_id, lease_seconds):
            logger.warning(
                "Run %s holds a live lease for another worker; not starting", run_id
            )
            return

        attempt_started_at = datetime.now(UTC)
        try:
            await append_event(
                db, workspace_id=run.workspace_id, run_id=run.id,
                event_type="run.validating", payload={},
            )
            d = ctx.definition
            rounds = d.rounds
            plan = build_turn_plan(d.meeting_type, rounds, ctx.def_agents)

            # Build one provider instance per referenced configuration.
            # Secrets are decrypted server-side only; raises before the run
            # starts if any provider is unavailable or misconfigured.
            providers_by_config: dict[uuid.UUID, ModelProvider] = {}
            for pc_id, pc_row in ctx.provider_configs.items():
                decrypted = None
                if pc_row.secret_ciphertext and pc_row.secret_nonce and pc_row.secret_key_version:
                    decrypted = decrypt_secret(
                        pc_row.secret_ciphertext, pc_row.secret_nonce, pc_row.secret_key_version
                    )
                pricing = {
                    pm_row.model_key: pricing_from_capabilities(pm_row.capabilities)
                    for pm_row in ctx.provider_models.values()
                    if pm_row.provider_config_id == pc_id
                }
                providers_by_config[pc_id] = build_provider(pc_row, decrypted, pricing)

            run.status = "running"
            # Keep the first attempt's start time. A resumed run already began
            # earlier, and overwriting this loses when the work actually started.
            if run.started_at is None:
                run.started_at = attempt_started_at
            await db.commit()
            await append_event(
                db, workspace_id=run.workspace_id, run_id=run.id,
                event_type="run.started",
                payload={
                    "meeting_type": d.meeting_type,
                    "rounds": rounds,
                    "planned_calls": len(plan),
                    "demo_mode": run.demo_mode,
                },
            )

            upstream_agents: dict[int, Agent] = {}
            for da in ctx.def_agents:
                av = ctx.agent_versions[da.agent_version_id]
                pm = ctx.provider_models[da.provider_model_id]
                title = (
                    await db.execute(
                        text(
                            "SELECT p.title FROM agent_profiles p "
                            "JOIN agent_versions v ON v.agent_profile_id = p.id WHERE v.id = :vid"
                        ),
                        {"vid": str(da.agent_version_id)},
                    )
                ).scalar_one()
                upstream_agents[da.position] = _upstream_agent(av, title, pm.model_key)

            demo = get_demo_provider()
            scripted = demo.matches_scenario(ctx.project_slug, d.meeting_type, rounds)

            # Shared transcript, mirroring upstream message handling.
            messages: list[dict[str, str]] = []
            if d.meeting_type == "team":
                lead_da = next(a for a in ctx.def_agents if a.role_type == "lead")
                member_das = sorted(
                    (a for a in ctx.def_agents if a.role_type == "member"), key=lambda a: a.position
                )
                start = team_meeting_start_prompt(
                    team_lead=upstream_agents[lead_da.position],
                    team_members=tuple(upstream_agents[m.position] for m in member_das),
                    agenda=d.agenda,
                    agenda_questions=tuple(d.questions or ()),
                    agenda_rules=tuple(d.rules or ()),
                    summaries=tuple(d.previous_summary_refs or ()),
                    contexts=tuple(d.contexts or ()),
                    num_rounds=rounds,
                )
                messages.append({"role": "user", "content": start})

            # Durable resume: reuse persisted turns from a previous attempt
            # (lease expiry / worker restart) instead of restarting at 0.
            existing_turns: dict[int, RunTurn] = {
                t.sequence: t
                for t in (
                    await db.execute(
                        select(RunTurn).where(RunTurn.run_id == run.id).order_by(RunTurn.sequence)
                    )
                ).scalars()
            }

            current_round = 0
            for planned in plan:
                # Replay already-completed turns: rebuild the transcript
                # deterministically and skip the provider call entirely.
                completed_prior = existing_turns.get(planned.call_index)
                if completed_prior is not None and completed_prior.status == "completed":
                    prompt = _turn_prompt(ctx, planned, upstream_agents, rounds)
                    messages.append({"role": "user", "content": prompt})
                    messages.append({"role": "assistant", "content": completed_prior.response_text or ""})
                    current_round = planned.round_number
                    continue
                if planned.round_number != current_round:
                    current_round = planned.round_number
                    await append_event(
                        db, workspace_id=run.workspace_id, run_id=run.id,
                        event_type="round.started",
                        payload={
                            "round": current_round,
                            "is_final_round": planned.is_final,
                            "total_rounds": rounds + 1,
                        },
                    )
                await _checkpoint(
                    db, ctx, f"before_call_{planned.call_index}", messages, worker_id, lease_seconds
                )

                da = next(a for a in ctx.def_agents if a.position == planned.agent_position)
                av = ctx.agent_versions[da.agent_version_id]
                pc = ctx.provider_configs[da.provider_config_id]
                pm = ctx.provider_models[da.provider_model_id]
                agent = upstream_agents[da.position]

                prompt = _turn_prompt(ctx, planned, upstream_agents, rounds)
                messages.append({"role": "user", "content": prompt})

                temperature = float(da.temperature_override or d.default_temperature)
                request = CompletionRequest(
                    model=pm.model_key,
                    system_prompt=av.system_prompt,
                    messages=list(messages),
                    temperature=temperature,
                    run_id=str(run.id),
                    call_index=planned.call_index,
                    agent_title=agent.title,
                    role_type=planned.role_type,
                    round_number=planned.round_number,
                    is_final=planned.is_final,
                )

                request_sha = sha256_text(canonical_json(
                    {"system": av.system_prompt, "messages": messages, "model": pm.model_key,
                     "temperature": temperature}
                ))
                stale = existing_turns.get(planned.call_index)
                if stale is not None:
                    # An in-flight turn from an interrupted attempt: reuse the
                    # row (unique (run_id, sequence)) and retry the call.
                    turn = stale
                    turn.status = "streaming"
                    turn.response_text = None
                    turn.response_sha256 = None
                    turn.finish_reason = None
                    turn.request_payload_sha256 = request_sha
                    turn.started_at = datetime.now(UTC)
                    turn.completed_at = None
                else:
                    turn = RunTurn(
                        workspace_id=run.workspace_id,
                        run_id=run.id,
                        sequence=planned.call_index,
                        round_number=planned.round_number,
                        position_in_round=planned.position_in_round,
                        agent_version_id=da.agent_version_id,
                        role_type=planned.role_type,
                        status="streaming",
                        provider_config_id=da.provider_config_id,
                        provider_model_id=da.provider_model_id,
                        system_prompt_sha256=av.system_prompt_sha256,
                        request_payload_sha256=request_sha,
                        started_at=datetime.now(UTC),
                    )
                    db.add(turn)
                run.current_round = planned.round_number
                run.current_position = planned.position_in_round
                run.current_agent_version_id = da.agent_version_id
                await db.commit()
                await append_event(
                    db, workspace_id=run.workspace_id, run_id=run.id,
                    event_type="turn.started",
                    payload={
                        "turn_id": str(turn.id),
                        "sequence": planned.call_index,
                        "round": planned.round_number,
                        "agent_title": agent.title,
                        "role_type": planned.role_type,
                        "model": pm.model_key,
                        "provider_type": pc.provider_type,
                        "is_final": planned.is_final,
                        "simulation": pc.provider_type == "demo",
                    },
                )

                provider = providers_by_config[da.provider_config_id]
                # A call can outlast any fixed lease (model latency plus
                # rate-limit backoff), so hold the lease open with a heartbeat
                # instead. Without this the sweeper requeues the run mid-call
                # and a second worker replays the same turn.
                async with _LeaseHeartbeat(
                    sessionmaker, run.id, worker_id, lease_seconds
                ) as heartbeat:
                    if isinstance(provider, DemoProvider):
                        result = await provider.complete(request, scripted=scripted)
                    else:
                        result = await provider.complete(request)
                # Re-assert ownership before persisting: if another worker took
                # over, writing this result would duplicate its work.
                if heartbeat.lost or not await _renew_lease(
                    db, run.id, worker_id, lease_seconds
                ):
                    raise LeaseLost(
                        f"run {run.id} lease lost during call {planned.call_index}"
                    )

                if settings.demo_latency_enabled and run.demo_mode:
                    import asyncio

                    await asyncio.sleep(min(result.latency_ms, 400) / 1000)

                # Coalesced streaming deltas for live UI.
                content = result.content
                chunk_count = 3 if len(content) > 300 else 1
                size = max(1, len(content) // chunk_count)
                for ci in range(chunk_count):
                    chunk = content[ci * size:] if ci == chunk_count - 1 else content[ci * size:(ci + 1) * size]
                    await append_event(
                        db, workspace_id=run.workspace_id, run_id=run.id,
                        event_type="turn.delta",
                        payload={"turn_id": str(turn.id), "sequence": planned.call_index,
                                 "index": ci, "text": chunk},
                    )

                # Simulated tool events (scripted scenario only).
                if scripted:
                    for tev in demo.tool_events_after(planned.call_index):
                        tool_slug = tev["tool"]
                        tool_def_id = (
                            await db.execute(
                                text(
                                    "SELECT id FROM tool_definitions WHERE slug = :slug "
                                    "AND workspace_id IS NULL ORDER BY created_at LIMIT 1"
                                ),
                                {"slug": tool_slug},
                            )
                        ).scalar_one_or_none()
                        if tool_def_id is None:
                            continue
                        args_json = tev.get("arguments", {})
                        result_json = tev.get("result", {})
                        tc = ToolCall(
                            workspace_id=run.workspace_id,
                            run_id=run.id,
                            run_turn_id=turn.id,
                            sequence=0,
                            tool_definition_id=tool_def_id,
                            status="completed",
                            arguments_json=args_json,
                            arguments_sha256=sha256_text(canonical_json(args_json)),
                            result_json=result_json,
                            result_sha256=sha256_text(canonical_json(result_json)),
                            started_at=datetime.now(UTC),
                            completed_at=datetime.now(UTC),
                        )
                        db.add(tc)
                        run.tool_call_count += 1
                        await db.commit()
                        await append_event(
                            db, workspace_id=run.workspace_id, run_id=run.id,
                            event_type="tool.requested",
                            payload={"tool_call_id": str(tc.id), "tool": tool_slug,
                                     "turn_id": str(turn.id), "arguments": args_json,
                                     "label": tev.get("label", ""), "simulation": True},
                        )
                        await append_event(
                            db, workspace_id=run.workspace_id, run_id=run.id,
                            event_type="tool.completed",
                            payload={"tool_call_id": str(tc.id), "tool": tool_slug,
                                     "turn_id": str(turn.id), "result": result_json,
                                     "simulation": True},
                        )

                turn.status = "completed"
                turn.response_text = content
                turn.response_sha256 = sha256_text(content)
                turn.finish_reason = result.finish_reason
                turn.provider_request_id = result.provider_request_id
                turn.input_tokens = result.input_tokens
                turn.cached_input_tokens = result.cached_input_tokens
                turn.output_tokens = result.output_tokens
                turn.cost_usd = Decimal(str(result.cost_usd))
                turn.latency_ms = result.latency_ms
                turn.completed_at = datetime.now(UTC)

                run.provider_call_count += 1
                run.input_tokens += result.input_tokens
                run.cached_input_tokens += result.cached_input_tokens
                run.output_tokens += result.output_tokens
                run.actual_cost_usd = Decimal(str(run.actual_cost_usd)) + Decimal(str(result.cost_usd))
                # Fence the turn and its usage counters on still owning the run.
                # The fence commits in the same transaction as these writes, so
                # a worker that lost the lease cannot land a stale turn.
                if not await _fence_lease(db, run.id, worker_id, lease_seconds):
                    call_index = planned.call_index
                    await db.rollback()
                    # Use the plain id: the rollback expired every ORM
                    # attribute, and touching one here would trigger a lazy
                    # load that asyncio cannot service.
                    raise LeaseLost(
                        f"run {run_id} lease lost before persisting call {call_index}"
                    )
                await db.commit()

                messages.append({"role": "assistant", "content": content})

                await append_event(
                    db, workspace_id=run.workspace_id, run_id=run.id,
                    event_type="turn.completed",
                    payload={
                        "turn_id": str(turn.id), "sequence": planned.call_index,
                        "round": planned.round_number, "agent_title": agent.title,
                        "role_type": planned.role_type, "text": content,
                        "finish_reason": result.finish_reason,
                        "simulation": result.is_simulation,
                    },
                )
                await append_event(
                    db, workspace_id=run.workspace_id, run_id=run.id,
                    event_type="usage.updated",
                    payload={
                        "provider_call_count": run.provider_call_count,
                        "input_tokens": run.input_tokens,
                        "output_tokens": run.output_tokens,
                        "actual_cost_usd": float(run.actual_cost_usd),
                    },
                )

            # Structured summary + completion — idempotent and atomic. A prior
            # attempt may have crashed after persisting the summary but before
            # marking the run completed; reuse the existing summary and finish
            # in a single transaction so recovery cannot double-insert.
            existing_summary = await db.get(RunSummary, run.id)
            validation_errors: list[dict[str, str]] = []
            if existing_summary is None:
                if run.demo_mode:
                    summary_json = (
                        demo.structured_summary() if scripted else _fallback_summary(ctx, messages)
                    )
                    disclosure_line = get_demo_provider().disclosure
                else:
                    # Every judgement in the structured record — including the
                    # confidence numbers — comes from the model that held the
                    # meeting, via one extra call. Where that call cannot run,
                    # the record says so instead of carrying invented values.
                    roster = {
                        upstream_agents[a.position].title: str(a.agent_version_id)
                        for a in ctx.def_agents
                    }
                    extracted, synth_note = await _run_structured_synthesis(
                        db, sessionmaker, ctx, messages, providers_by_config,
                        roster, plan[-1].agent_position, worker_id, lease_seconds,
                    )
                    summary_json = _real_summary(ctx, messages, extracted, roster, synth_note)
                    # Schema validation gates the model's record, it does not
                    # merely label it. Publishing a malformed document as a
                    # finding is worse than admitting the extraction failed, so
                    # fall back to the not-extracted record — which is valid by
                    # construction — and record why.
                    schema_errors = validate_summary(summary_json) if extracted is not None else []
                    if schema_errors:
                        await append_event(
                            db, workspace_id=run.workspace_id, run_id=run.id,
                            event_type="summary.synthesis_rejected",
                            payload={"errors": schema_errors[:10]},
                        )
                        summary_json = _real_summary(
                            ctx, messages, None, roster,
                            "The structured synthesis step returned a record that failed "
                            "schema validation; the fields it would have filled are marked "
                            "as not extracted.",
                        )
                    disclosure_line = (
                        "AI-generated decision support produced by a configured model "
                        "provider. Requires human scientific review; not a validated result."
                    )
                validation_errors = validate_summary(summary_json)
                validation_status = "valid" if not validation_errors else "invalid"
                final_text = messages[-1]["content"] if messages else ""
                summary_markdown = _summary_markdown(
                    d.title, disclosure_line, summary_json, final_text
                )
                db.add(RunSummary(
                    run_id=run.id,
                    workspace_id=run.workspace_id,
                    summary_markdown=summary_markdown,
                    summary_json=summary_json,
                    schema_version="1.0",
                    summary_sha256=sha256_text(canonical_json(summary_json)),
                    validation_status=validation_status,
                    validation_errors=validation_errors,
                ))
            else:
                validation_status = existing_summary.validation_status
                summary_json = existing_summary.summary_json

            # Citations from the summary evidence claims, validated against the
            # evidence frozen into the meeting definition (idempotent).
            citation_stats = await create_citations_from_summary(
                db, run, ctx.definition, summary_json
            )

            run.status = "completed"
            run.completed_at = datetime.now(UTC)
            run.wall_seconds = _accumulate_wall_seconds(run, attempt_started_at)
            run.lease_owner = None
            run.lease_expires_at = None
            await db.commit()

            if existing_summary is None:
                if validation_errors:
                    await append_event(
                        db, workspace_id=run.workspace_id, run_id=run.id,
                        event_type="summary.validation_failed",
                        payload={"errors": validation_errors[:10]},
                    )
                await append_event(
                    db, workspace_id=run.workspace_id, run_id=run.id,
                    event_type="summary.completed",
                    payload={"validation_status": validation_status, "schema_version": "1.0"},
                )
            if citation_stats["created"]:
                await append_event(
                    db, workspace_id=run.workspace_id, run_id=run.id,
                    event_type="citations.recorded",
                    payload=citation_stats,
                )

            # Provenance manifest (idempotent; validated against the schema).
            _manifest, _mf_err = await ensure_manifest_safe(db, run)
            if _manifest is not None:
                await append_event(
                    db, workspace_id=run.workspace_id, run_id=run.id,
                    event_type="manifest.created", payload={"manifest_version": "1.0"},
                )
            elif _mf_err is not None:
                await append_event(
                    db, workspace_id=run.workspace_id, run_id=run.id,
                    event_type="manifest.failed", payload={"message": _mf_err},
                )
            await append_event(
                db, workspace_id=run.workspace_id, run_id=run.id,
                event_type="run.completed",
                payload={
                    "provider_call_count": run.provider_call_count,
                    "actual_cost_usd": float(run.actual_cost_usd),
                    "wall_seconds": float(run.wall_seconds),
                },
            )
        except LeaseLost as exc:
            # The recovery sweeper already requeued (or failed) this run and a
            # second worker owns it. Touching run state here would clobber that
            # decision, so drop the attempt and let the new owner proceed.
            await db.rollback()
            logger.warning("Abandoning run attempt: %s", exc)
            return
        except RunCancelled:
            await db.rollback()
            run = await db.get(Run, run_id)
            run.status = "cancelled"
            run.control_requested = None
            run.completed_at = datetime.now(UTC)
            run.wall_seconds = _accumulate_wall_seconds(run, attempt_started_at)
            run.lease_owner = None
            run.lease_expires_at = None
            await db.commit()
            await append_event(
                db, workspace_id=run.workspace_id, run_id=run.id,
                event_type="run.cancelled", payload={},
            )
            _m, _e = await ensure_manifest_safe(db, run)
            if (_m, _e) != (None, None):
                # (None, None) means the write was skipped because a retry
                # requeued this run; the attempt's artifacts are not its own.
                await append_event(
                    db, workspace_id=run.workspace_id, run_id=run.id,
                    event_type="manifest.created" if _e is None else "manifest.failed",
                    payload={"manifest_version": "1.0"} if _e is None else {"message": _e},
                )
        except BudgetExceeded as exc:
            await db.rollback()
            run = await db.get(Run, run_id)
            run.status = "budget_stopped"
            run.failure_code = "budget_exceeded"
            run.failure_safe_message = f"Budget limit reached: {exc.reason}"
            run.completed_at = datetime.now(UTC)
            run.wall_seconds = _accumulate_wall_seconds(run, attempt_started_at)
            run.lease_owner = None
            run.lease_expires_at = None
            await db.commit()
            await append_event(
                db, workspace_id=run.workspace_id, run_id=run.id,
                event_type="budget.warning",
                payload={"reason": exc.reason, "stopped": True},
            )
            await append_event(
                db, workspace_id=run.workspace_id, run_id=run.id,
                event_type="run.failed",
                payload={"failure_code": "budget_exceeded", "message": run.failure_safe_message},
            )
            _m, _e = await ensure_manifest_safe(db, run)
            if (_m, _e) != (None, None):
                # (None, None) means the write was skipped because a retry
                # requeued this run; the attempt's artifacts are not its own.
                await append_event(
                    db, workspace_id=run.workspace_id, run_id=run.id,
                    event_type="manifest.created" if _e is None else "manifest.failed",
                    payload={"manifest_version": "1.0"} if _e is None else {"message": _e},
                )
        except (ProviderCallError, ProviderConfigurationError) as exc:
            await db.rollback()
            run = await db.get(Run, run_id)
            run.status = "failed"
            run.failure_code = getattr(exc, "code", "provider_configuration_error")
            run.failure_safe_message = getattr(exc, "safe_message", str(exc))
            run.completed_at = datetime.now(UTC)
            run.wall_seconds = _accumulate_wall_seconds(run, attempt_started_at)
            run.lease_owner = None
            run.lease_expires_at = None
            await db.commit()
            await append_event(
                db, workspace_id=run.workspace_id, run_id=run.id,
                event_type="run.failed",
                payload={"failure_code": run.failure_code, "message": run.failure_safe_message},
            )
            _m, _e = await ensure_manifest_safe(db, run)
            if (_m, _e) != (None, None):
                # (None, None) means the write was skipped because a retry
                # requeued this run; the attempt's artifacts are not its own.
                await append_event(
                    db, workspace_id=run.workspace_id, run_id=run.id,
                    event_type="manifest.created" if _e is None else "manifest.failed",
                    payload={"manifest_version": "1.0"} if _e is None else {"message": _e},
                )
        except Exception as exc:  # noqa: BLE001
            await db.rollback()
            run = await db.get(Run, run_id)
            run.status = "failed"
            run.failure_code = type(exc).__name__
            run.failure_safe_message = "Run failed due to an internal error."
            run.completed_at = datetime.now(UTC)
            run.wall_seconds = _accumulate_wall_seconds(run, attempt_started_at)
            run.lease_owner = None
            run.lease_expires_at = None
            await db.commit()
            await append_event(
                db, workspace_id=run.workspace_id, run_id=run.id,
                event_type="run.failed",
                payload={"failure_code": run.failure_code, "message": run.failure_safe_message},
            )
            _m, _e = await ensure_manifest_safe(db, run)
            if (_m, _e) != (None, None):
                # (None, None) means the write was skipped because a retry
                # requeued this run; the attempt's artifacts are not its own.
                await append_event(
                    db, workspace_id=run.workspace_id, run_id=run.id,
                    event_type="manifest.created" if _e is None else "manifest.failed",
                    payload={"manifest_version": "1.0"} if _e is None else {"message": _e},
                )
            raise
