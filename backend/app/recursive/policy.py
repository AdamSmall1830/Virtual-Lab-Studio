"""Deployment and worker policy for a recursive participant.

Three ceilings apply to every recursive turn and the lowest always wins:

1. the schema bound on ``RecursiveExecutionConfigIn`` (what a client may ask
   for at all);
2. the deployment ceiling in settings (``recursive_job_hard_*``);
3. what the chosen worker actually advertises.

Requests are refused rather than silently clamped. A researcher who asked for
depth 2 and got depth 1 without being told would be reading results from an
experiment they did not configure, so an over-limit request is a validation
error with the number that was exceeded.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from ..config import Settings
from ..models import RecursiveWorker
from ..schemas import RecursiveExecutionConfigIn

# The only capability profile version 1 supports, and the only skills reviewed
# for it. Both are pinned in the request schema too; re-checked here because a
# frozen definition may outlive the schema that produced it.
SUPPORTED_PROFILES = frozenset({"research_read_only"})
REVIEWED_SKILL_IDS = frozenset({"vls_evidence"})


@dataclass(frozen=True)
class ResolvedLimits:
    """The bounds actually written onto a job, after every ceiling applies."""

    max_children: int
    max_depth: int
    max_agent_turns: int
    max_tokens: int
    max_runtime_seconds: int
    max_cost_usd: Decimal | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "max_children": self.max_children,
            "max_depth": self.max_depth,
            "max_agent_turns": self.max_agent_turns,
            "max_tokens": self.max_tokens,
            "max_runtime_seconds": self.max_runtime_seconds,
            "max_cost_usd": float(self.max_cost_usd) if self.max_cost_usd is not None else None,
        }


def worker_is_online(worker: RecursiveWorker, settings: Settings) -> bool:
    """A worker counts as online only if it checked in recently.

    ``status`` alone is not enough: a machine that lost power leaves its last
    status behind. Freshness of ``last_seen_at`` is the real signal.
    """
    if not worker.enabled or worker.revoked_at is not None:
        return False
    if worker.status in {"disabled", "revoked", "offline"}:
        return False
    if worker.last_seen_at is None:
        return False
    cutoff = datetime.now(UTC) - timedelta(seconds=settings.recursive_worker_offline_after_seconds)
    return worker.last_seen_at >= cutoff


def catalog_entry(worker: RecursiveWorker, model_key: str) -> dict[str, Any] | None:
    for entry in worker.model_catalog or []:
        if isinstance(entry, dict) and entry.get("model_key") == model_key:
            return entry
    return None


def _cap(name: str, requested: int, ceiling: int, errors: list[str]) -> int:
    if requested > ceiling:
        errors.append(f"{name} of {requested} exceeds the limit of {ceiling} for this deployment.")
    return min(requested, ceiling)


def resolve_limits(
    config: RecursiveExecutionConfigIn, settings: Settings, worker: RecursiveWorker | None
) -> tuple[ResolvedLimits, list[str]]:
    """Apply deployment then worker ceilings. Returns (limits, errors)."""
    errors: list[str] = []
    caps = (worker.capabilities or {}) if worker is not None else {}

    max_children = _cap(
        "Child agents", config.max_children, settings.recursive_job_hard_max_children, errors
    )
    max_depth = _cap("Depth", config.max_depth, settings.recursive_job_hard_max_depth, errors)
    max_agent_turns = _cap(
        "Agent turns", config.max_agent_turns, settings.recursive_job_hard_max_agent_turns, errors
    )
    max_tokens = _cap("Tokens", config.max_tokens, settings.recursive_job_hard_max_tokens, errors)
    max_runtime = _cap(
        "Runtime", config.max_runtime_seconds, settings.recursive_job_hard_max_runtime_seconds, errors
    )

    if worker is not None:
        worker_children = caps.get("max_children")
        if isinstance(worker_children, int) and config.max_children > worker_children:
            errors.append(
                f"The selected worker advertises at most {worker_children} child agents; "
                f"{config.max_children} were requested."
            )
            max_children = min(max_children, worker_children)
        worker_depth = caps.get("max_depth")
        if isinstance(worker_depth, int) and config.max_depth > worker_depth:
            errors.append(
                f"The selected worker advertises a maximum depth of {worker_depth}; "
                f"{config.max_depth} was requested."
            )
            max_depth = min(max_depth, worker_depth)

    max_cost: Decimal | None = None
    if config.max_cost_usd is not None:
        hard = settings.recursive_job_hard_max_cost_usd
        if config.max_cost_usd > hard:
            errors.append(
                f"A cost ceiling of {config.max_cost_usd} USD exceeds the deployment limit of {hard} USD."
            )
        max_cost = Decimal(str(min(config.max_cost_usd, hard)))

    return (
        ResolvedLimits(
            max_children=max_children,
            max_depth=max_depth,
            max_agent_turns=max_agent_turns,
            max_tokens=max_tokens,
            max_runtime_seconds=max_runtime,
            max_cost_usd=max_cost,
        ),
        errors,
    )


def check_worker_eligibility(
    config: RecursiveExecutionConfigIn, settings: Settings, worker: RecursiveWorker | None
) -> list[str]:
    """Everything about the worker that must hold before a draft can launch."""
    errors: list[str] = []
    if worker is None:
        errors.append("The selected recursive worker does not exist in this workspace.")
        return errors
    if worker.revoked_at is not None:
        errors.append(f"Worker '{worker.display_name}' has been revoked.")
        return errors
    if not worker.enabled:
        errors.append(f"Worker '{worker.display_name}' is disabled.")
    if not worker_is_online(worker, settings):
        errors.append(
            f"Worker '{worker.display_name}' is not online. Start the bridge on that machine and "
            "wait for it to check in."
        )

    caps = worker.capabilities or {}
    profiles = caps.get("profiles")
    advertised = set(profiles) if isinstance(profiles, list) else set()
    if config.capability_profile not in SUPPORTED_PROFILES:
        errors.append(f"Capability profile '{config.capability_profile}' is not supported.")
    elif advertised and config.capability_profile not in advertised:
        errors.append(
            f"Worker '{worker.display_name}' does not advertise the "
            f"'{config.capability_profile}' capability profile."
        )

    if config.allow_web or caps.get("allow_web") is True:
        errors.append("Web access is not available to recursive participants in this version.")

    unreviewed = sorted(set(config.allowed_skill_ids) - REVIEWED_SKILL_IDS)
    if unreviewed:
        errors.append(f"Skills not reviewed for recursive use: {', '.join(unreviewed)}.")

    coordinator = catalog_entry(worker, config.coordinator_model_key)
    if coordinator is None:
        errors.append(
            f"Model '{config.coordinator_model_key}' is not in the current catalogue advertised by "
            f"worker '{worker.display_name}'."
        )
    elif not coordinator.get("supports_recursive_agents"):
        errors.append(
            f"Model '{config.coordinator_model_key}' is not marked as supporting recursive agents."
        )

    if config.child_model_key is not None:
        child = catalog_entry(worker, config.child_model_key)
        if child is None:
            errors.append(
                f"Child model '{config.child_model_key}' is not in the catalogue advertised by "
                f"worker '{worker.display_name}'."
            )
        elif not child.get("supports_recursive_agents"):
            errors.append(
                f"Child model '{config.child_model_key}' is not marked as supporting recursive agents."
            )
    return errors


def pricing_is_complete(worker: RecursiveWorker, model_keys: list[str]) -> bool:
    """True only when every named model advertises full pricing.

    An unpriced local model is normal (self-hosted inference is not billed per
    token), but the estimate must say the cost figure is incomplete rather than
    presenting an unknown as zero.
    """
    for key in model_keys:
        entry = catalog_entry(worker, key)
        if entry is None:
            return False
        pricing = entry.get("pricing")
        if not isinstance(pricing, dict):
            return False
        if pricing.get("input_usd_per_1m") is None or pricing.get("output_usd_per_1m") is None:
            return False
    return True


def normalize_capabilities(report: Any) -> dict[str, Any]:
    """Map a worker's self-report onto the shape the API returns.

    Kept in one place so the stored JSON always matches
    ``RecursiveWorkerCapabilitiesOut``; a worker cannot introduce keys of its
    own choosing into a record that is rendered to researchers.
    """
    caps = report.capabilities
    return {
        "sandbox_mode": report.sandbox_mode,
        "supports_recursive_agents": any(
            m.supports_recursive_agents for m in report.model_catalog
        ),
        "supports_python": bool(caps.python),
        "supports_evidence_search": "research_read_only" in (caps.profiles or []),
        "allow_web": bool(caps.web),
        "max_children": caps.max_children,
        "max_depth": caps.max_depth,
        "profiles": list(caps.profiles or []),
    }


def normalize_catalog(report: Any) -> list[dict[str, Any]]:
    """Model metadata, re-serialised field by field.

    A worker's catalogue is displayed to researchers and used to price a
    meeting, so it is rebuilt from named fields rather than stored as sent --
    a base URL, an API key or a host path must not survive the trip.
    """
    return [
        {
            "model_key": m.model_key,
            "display_name": m.display_name or m.model_key,
            "provider_kind": m.provider_kind,
            "context_window": m.context_window,
            "supports_recursive_agents": m.supports_recursive_agents,
            "supports_tools": m.supports_tools,
            "pricing": {
                "input_usd_per_1m": m.pricing.input_usd_per_1m,
                "cached_input_usd_per_1m": m.pricing.cached_input_usd_per_1m,
                "output_usd_per_1m": m.pricing.output_usd_per_1m,
            },
        }
        for m in report.model_catalog
    ]
