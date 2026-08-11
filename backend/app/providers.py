"""Model provider protocol and the deterministic Demo Provider.

The Demo Provider replays the scripted scenario in
specs/demo_provider_scenario.json when the run matches, and otherwise emits a
clearly labeled deterministic simulated response derived from a SHA-256 hash
of run ID, call index, and agent title. It never contacts a network service
and costs nothing.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import random
import socket
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any, Protocol
from urllib.parse import urlparse

import httpx

from .config import SPECS_DIR, get_settings

logger = logging.getLogger("vls.providers")


@dataclass
class CompletionRequest:
    model: str
    system_prompt: str
    # Widened from str values to Any: a tool-using exchange carries assistant
    # messages with a `tool_calls` list and `role: "tool"` result messages.
    messages: list[dict[str, Any]]
    temperature: float
    run_id: str
    call_index: int
    agent_title: str
    role_type: str
    round_number: int
    is_final: bool
    metadata: dict[str, Any] = field(default_factory=dict)
    # Function schemas offered for this call, or None to offer no tools.
    tools: list[dict[str, Any]] | None = None


@dataclass
class ToolCallRequest:
    """A *simulated* tool event from the scripted demo scenario.

    It carries its own result because nothing executes: the scenario file
    supplies both halves. Real tool calls the model asks for are
    ProviderToolCall, which has no result until a handler produces one.
    """

    tool_slug: str
    arguments: dict[str, Any]
    result: dict[str, Any]
    label: str


@dataclass
class ProviderToolCall:
    """A tool invocation a model asked for. Not yet executed."""

    id: str
    name: str
    arguments: dict[str, Any]
    # Set when the model sent arguments that were not valid JSON. Kept as a
    # value rather than raised so the engine can hand the model a correctable
    # error instead of failing the whole turn.
    parse_error: str | None = None


@dataclass
class CompletionResult:
    content: str
    finish_reason: str
    provider_request_id: str | None
    model: str
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: int
    is_simulation: bool
    tool_calls: list[ToolCallRequest] = field(default_factory=list)
    structured_summary: dict[str, Any] | None = None
    # Tool calls the model requested on this response, in the order given.
    requested_tool_calls: list[ProviderToolCall] = field(default_factory=list)
    # The raw assistant message, replayed verbatim into the next request when
    # continuing a tool exchange. Providers reject a tool result whose call id
    # has no matching assistant message.
    raw_assistant_message: dict[str, Any] | None = None


class ModelProvider(Protocol):
    provider_type: str

    async def complete(self, request: CompletionRequest) -> CompletionResult: ...


class DemoProvider:
    provider_type = "demo"

    def __init__(self) -> None:
        spec = json.loads((SPECS_DIR / "demo_provider_scenario.json").read_text())
        self.provider_spec = spec["provider"]
        self.scenario = spec["scenario"]
        self.fallback = spec["fallback_behavior"]
        self.disclosure: str = self.provider_spec["required_disclosure"]
        usage = self.provider_spec["usage"]
        self.input_tokens_per_call = int(usage["input_tokens_per_call"])
        self.output_tokens_per_call = int(usage["output_tokens_per_call"])

    def matches_scenario(self, project_slug: str, meeting_type: str, rounds: int) -> bool:
        match = self.scenario["match"]
        return (
            match["project_slug"] == project_slug
            and match["meeting_type"] == meeting_type
            and int(match["rounds"]) == rounds
        )

    def scripted_call(self, call_index: int) -> dict[str, Any] | None:
        for call in self.scenario["scripted_calls"]:
            if int(call["call_index"]) == call_index:
                return call
        return None

    def tool_events_after(self, call_index: int) -> list[dict[str, Any]]:
        return [
            ev for ev in self.scenario.get("simulated_tool_events", [])
            if int(ev["after_call_index"]) == call_index
        ]

    def structured_summary(self) -> dict[str, Any]:
        return self.scenario["structured_summary"]

    def _fallback_content(self, request: CompletionRequest) -> str:
        digest = hashlib.sha256(
            f"{request.run_id}:{request.call_index}:{request.agent_title}".encode()
        ).hexdigest()[:12]
        stage = "final synthesis" if request.is_final else f"discussion round {request.round_number}"
        return (
            f"[Simulation] {request.agent_title} — {stage}. "
            f"This is deterministic placeholder discussion (fingerprint {digest}) generated by the "
            "Demo Provider for interface testing. It is not substantive scientific analysis. "
            "Connect a real model provider and attach reviewed evidence before using this "
            "meeting for research decisions. Cost: $0."
        )

    async def complete(
        self, request: CompletionRequest, scripted: bool = False
    ) -> CompletionResult:
        if scripted:
            call = self.scripted_call(request.call_index)
        else:
            call = None
        content = call["content"] if call else self._fallback_content(request)
        digest = hashlib.sha256(content.encode()).hexdigest()[:16]
        return CompletionResult(
            content=content,
            finish_reason="stop",
            provider_request_id=f"demo-{request.run_id[:8]}-{request.call_index}-{digest[:6]}",
            model=self.provider_spec["model_key"],
            input_tokens=self.input_tokens_per_call,
            cached_input_tokens=0,
            output_tokens=self.output_tokens_per_call,
            cost_usd=0.0,
            latency_ms=int(self.scenario["simulated_latency_ms"]["first_token"]),
            is_simulation=True,
        )


_demo_provider: DemoProvider | None = None


def get_demo_provider() -> DemoProvider:
    global _demo_provider
    if _demo_provider is None:
        _demo_provider = DemoProvider()
    return _demo_provider


class ProviderConfigurationError(ValueError):
    """A provider configuration is unsafe or incomplete (safe to show)."""


def validate_base_url(base_url: str, *, allow_private: bool = False) -> str:
    """Validate an OpenAI-compatible endpoint URL.

    Blocks non-HTTPS schemes and private/reserved networks by default to
    prevent server-side request forgery from user-supplied endpoints.
    Returns the normalized URL without a trailing slash.
    """
    url = (base_url or "").strip().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in {"https", "http"}:
        raise ProviderConfigurationError("Base URL must start with https://")
    if parsed.scheme == "http" and not allow_private:
        raise ProviderConfigurationError("Plain http endpoints are not allowed; use https.")
    if not parsed.hostname:
        raise ProviderConfigurationError("Base URL must include a hostname.")
    if parsed.username or parsed.password:
        raise ProviderConfigurationError("Credentials embedded in the URL are not allowed.")
    if not allow_private:
        host = parsed.hostname
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror:
            raise ProviderConfigurationError(f"Could not resolve host '{host}'.")
        for info in infos:
            ip = ipaddress.ip_address(info[4][0])
            if (
                ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified
            ):
                raise ProviderConfigurationError(
                    "Endpoints on private or reserved networks are not allowed."
                )
    return url


class ProviderCallError(RuntimeError):
    """A provider request failed; message is safe to persist/show."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message


# Transient conditions on shared model endpoints. A long deliberation makes many
# sequential calls, so a single blip must be retried rather than killing the run.
_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
_RETRY_BASE_SECONDS = 2.0
_RETRY_MAX_DELAY_SECONDS = 30.0
# Chat completions are not idempotent. When a failure leaves it unknown whether
# the provider already generated (and billed) a completion, retrying can pay
# twice for one turn, so ambiguous failures get far less latitude than a clean
# rejection like a 429.
_MAX_AMBIGUOUS_RETRIES = 1


def _transient_status_error(status_code: int) -> ProviderCallError:
    if status_code == 429:
        return ProviderCallError(
            "provider_rate_limited", "The provider rate-limited the request."
        )
    return ProviderCallError(
        "provider_unavailable",
        f"The provider is temporarily unavailable (HTTP {status_code}).",
    )


def _exhausted_message(code: str, attempts: int) -> str:
    if code == "provider_rate_limited":
        return (
            f"The provider rate-limited this session and kept refusing after {attempts} "
            "attempts. Wait a minute, then run again with fewer researchers or rounds "
            "so the transcript stays smaller."
        )
    if code == "provider_timeout":
        return f"The model provider timed out after {attempts} attempts."
    if code == "provider_unreachable":
        return f"Could not reach the model provider endpoint after {attempts} attempts."
    return f"The provider was unavailable after {attempts} attempts."


@dataclass
class ModelPricing:
    input_per_million: float | None = None
    cached_input_per_million: float | None = None
    output_per_million: float | None = None

    @property
    def complete(self) -> bool:
        return self.input_per_million is not None and self.output_per_million is not None

    def cost(self, input_tokens: int, cached_input_tokens: int, output_tokens: int) -> float:
        total = 0.0
        if self.input_per_million is not None:
            uncached = max(0, input_tokens - cached_input_tokens)
            total += uncached * self.input_per_million / 1_000_000
            cached_rate = (
                self.cached_input_per_million
                if self.cached_input_per_million is not None
                else self.input_per_million
            )
            total += cached_input_tokens * cached_rate / 1_000_000
        if self.output_per_million is not None:
            total += output_tokens * self.output_per_million / 1_000_000
        return round(total, 6)


def pricing_from_capabilities(capabilities: dict[str, Any] | None) -> ModelPricing:
    p = (capabilities or {}).get("pricing") or {}
    def _num(key: str) -> float | None:
        v = p.get(key)
        return float(v) if v is not None else None
    return ModelPricing(
        input_per_million=_num("input_per_million"),
        cached_input_per_million=_num("cached_input_per_million"),
        output_per_million=_num("output_per_million"),
    )


def _model_rejects_temperature(model: str) -> bool:
    # gpt-5+ and o-series reasoning models reject non-default temperature.
    m = model.lower()
    return m.startswith(("gpt-5", "o1", "o3", "o4"))


class OpenAICompatibleProvider:
    """Chat-completions adapter for OpenAI and OpenAI-compatible endpoints."""

    provider_type = "openai_compatible"

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        organization_id: str | None = None,
        pricing_by_model: dict[str, ModelPricing] | None = None,
        timeout_seconds: float = 180.0,
        max_attempts: int = 4,
        retry_budget_seconds: float = 90.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.organization_id = organization_id
        self.pricing_by_model = pricing_by_model or {}
        self.timeout_seconds = timeout_seconds
        self.max_attempts = max(1, max_attempts)
        self.retry_budget_seconds = max(0.0, retry_budget_seconds)

    def _headers(self) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if self.organization_id:
            headers["OpenAI-Organization"] = self.organization_id
        return headers

    @staticmethod
    def _retry_after_seconds(resp: httpx.Response) -> float | None:
        """Parse a Retry-After header (delta-seconds or HTTP-date), if present."""
        raw = (resp.headers.get("retry-after") or "").strip()
        if not raw:
            return None
        try:
            return max(0.0, float(raw))
        except ValueError:
            pass
        try:
            when = parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            return None
        if when is None:
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        return max(0.0, (when - datetime.now(UTC)).total_seconds())

    async def _post_with_retry(self, payload: dict[str, Any]) -> tuple[httpx.Response, int]:
        """POST the completion, retrying transient provider failures.

        Rate limits and upstream hiccups are routine on shared endpoints and
        must not destroy a long-running deliberation. Permanent failures (bad
        key, unknown model) are raised immediately — retrying cannot fix them.

        Returns the response together with the latency of the attempt that
        produced it, so stored per-turn latency reflects the model rather than
        the time this adapter spent waiting out a rate limit.
        """
        attempt = 0
        waited = 0.0
        ambiguous_failures = 0
        while True:
            attempt += 1
            resp: httpx.Response | None = None
            call_started = time.monotonic()
            # "Ambiguous" means the provider may already have generated and
            # billed a completion that never reached us.
            ambiguous = False
            try:
                async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                    resp = await client.post(
                        f"{self.base_url}/chat/completions",
                        json=payload,
                        headers=self._headers(),
                    )
            except (httpx.ConnectTimeout, httpx.PoolTimeout):
                # No request ever reached the provider: safe to retry.
                pending = ProviderCallError("provider_timeout", "The model provider timed out.")
            except httpx.TimeoutException:
                ambiguous = True
                pending = ProviderCallError("provider_timeout", "The model provider timed out.")
            except httpx.ConnectError:
                pending = ProviderCallError(
                    "provider_unreachable", "Could not reach the model provider endpoint."
                )
            except httpx.HTTPError:
                ambiguous = True
                pending = ProviderCallError(
                    "provider_unreachable", "Could not reach the model provider endpoint."
                )
            else:
                if resp.status_code not in _RETRYABLE_STATUS:
                    return resp, int((time.monotonic() - call_started) * 1000)
                # A 429 is a clean refusal; a 5xx may hide a completion the
                # upstream already produced.
                ambiguous = resp.status_code >= 500
                pending = _transient_status_error(resp.status_code)

            if ambiguous:
                ambiguous_failures += 1

            delay = self._retry_after_seconds(resp) if resp is not None else None
            if delay is None:
                delay = min(_RETRY_BASE_SECONDS * (2 ** (attempt - 1)), _RETRY_MAX_DELAY_SECONDS)
                delay += random.uniform(0.0, _RETRY_BASE_SECONDS)
            if (
                attempt >= self.max_attempts
                or waited + delay > self.retry_budget_seconds
                or ambiguous_failures > _MAX_AMBIGUOUS_RETRIES
            ):
                pending.safe_message = _exhausted_message(pending.code, attempt)
                pending.args = (pending.safe_message,)
                raise pending
            logger.warning(
                "Provider call transient failure (%s%s); retrying in %.1fs (attempt %d/%d)",
                pending.code,
                "; upstream may have billed the lost attempt" if ambiguous else "",
                delay, attempt, self.max_attempts,
            )
            await asyncio.sleep(delay)
            waited += delay

    async def complete(self, request: CompletionRequest) -> CompletionResult:
        payload: dict[str, Any] = {
            "model": request.model,
            "messages": (
                [{"role": "system", "content": request.system_prompt}] + request.messages
            ),
        }
        if not _model_rejects_temperature(request.model):
            payload["temperature"] = request.temperature
        if request.tools:
            payload["tools"] = request.tools
            # "auto", not "required": a participant that has nothing to look up
            # should answer, not manufacture a search to satisfy the parameter.
            payload["tool_choice"] = "auto"
        resp, latency_ms = await self._post_with_retry(payload)
        if resp.status_code == 401 or resp.status_code == 403:
            raise ProviderCallError("provider_auth_failed", "The provider rejected the API key.")
        if resp.status_code == 404:
            raise ProviderCallError(
                "provider_model_not_found",
                f"The provider endpoint rejected model '{request.model}'.",
            )
        # Retryable statuses (429/5xx) never reach here: _post_with_retry either
        # succeeds or raises once the retry budget is spent.
        if resp.status_code >= 400:
            raise ProviderCallError(
                "provider_error", f"The provider returned an error (HTTP {resp.status_code})."
            )
        try:
            data = resp.json()
            choice = data["choices"][0]
            message = choice["message"]
            # A response that only requests tools has a null content field.
            content = message.get("content") or ""
            finish_reason = choice.get("finish_reason") or "stop"
        except (ValueError, KeyError, IndexError, TypeError):
            raise ProviderCallError(
                "provider_bad_response", "The provider returned an unexpected response shape."
            )

        requested: list[ProviderToolCall] = []
        raw_tool_calls = message.get("tool_calls") or []
        if raw_tool_calls and not isinstance(raw_tool_calls, list):
            raise ProviderCallError(
                "provider_bad_response", "The provider returned a malformed tool call."
            )
        if isinstance(raw_tool_calls, list):
            seen_ids: set[str] = set()
            for entry in raw_tool_calls:
                fn = entry.get("function") or {} if isinstance(entry, dict) else {}
                name = str(fn.get("name") or "").strip()
                call_id = str(entry.get("id") or "").strip() if isinstance(entry, dict) else ""
                if not name or not call_id or call_id in seen_ids:
                    # Every requested call must get a reply keyed by its id, and
                    # a duplicate or id-less entry makes that impossible. We
                    # cannot skip it either: the assistant message is replayed
                    # verbatim, so an unanswered entry makes the provider reject
                    # the follow-up. Fail the call instead of building a request
                    # that cannot succeed.
                    raise ProviderCallError(
                        "provider_bad_response",
                        "The provider returned a tool call without a usable id or name.",
                    )
                seen_ids.add(call_id)
                raw_args = fn.get("arguments")
                parsed: dict[str, Any] = {}
                parse_error: str | None = None
                if isinstance(raw_args, dict):
                    parsed = raw_args
                else:
                    try:
                        decoded = json.loads(raw_args or "{}")
                        if isinstance(decoded, dict):
                            parsed = decoded
                        else:
                            parse_error = "Tool arguments must be a JSON object."
                    except (ValueError, TypeError):
                        parse_error = "Tool arguments were not valid JSON."
                requested.append(
                    ProviderToolCall(
                        id=call_id, name=name, arguments=parsed, parse_error=parse_error
                    )
                )
        usage = data.get("usage") or {}
        input_tokens = int(usage.get("prompt_tokens") or 0)
        output_tokens = int(usage.get("completion_tokens") or 0)
        cached = int(((usage.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0)
        pricing = self.pricing_by_model.get(request.model, ModelPricing())
        return CompletionResult(
            content=content,
            finish_reason=finish_reason,
            provider_request_id=data.get("id"),
            model=data.get("model") or request.model,
            input_tokens=input_tokens,
            cached_input_tokens=cached,
            output_tokens=output_tokens,
            cost_usd=pricing.cost(input_tokens, cached, output_tokens),
            latency_ms=latency_ms,
            is_simulation=False,
            requested_tool_calls=requested,
            raw_assistant_message=message if requested else None,
        )


DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"


def replit_ai_credentials() -> tuple[str, str] | None:
    """Zero-key option: Replit AI Integrations proxy credentials from the
    environment, when provisioned. Returns (base_url, api_key) or None."""
    settings = get_settings()
    base = settings.ai_integrations_openai_base_url.strip().rstrip("/")
    key = settings.ai_integrations_openai_api_key.strip()
    if base and key:
        return base, key
    return None


def resolve_credentials(provider_config: Any, decrypted_key: str | None) -> tuple[str, str]:
    """Resolve (base_url, api_key) for a non-demo provider config.

    Supports two credential sources recorded in routing_policy:
    - "api_key" (default): encrypted key stored server-side
    - "replit_ai": Replit AI Integrations proxy from the environment
    """
    source = (provider_config.routing_policy or {}).get("credential_source", "api_key")
    if source == "replit_ai":
        creds = replit_ai_credentials()
        if creds is None:
            raise ProviderConfigurationError(
                "Replit AI credentials are not configured in this environment."
            )
        return creds
    base_url = provider_config.base_url or DEFAULT_OPENAI_BASE_URL
    if not decrypted_key:
        raise ProviderConfigurationError(
            f"Provider '{provider_config.name}' has no stored API key."
        )
    return base_url, decrypted_key


def build_provider(
    provider_config: Any,
    decrypted_key: str | None,
    pricing_by_model: dict[str, ModelPricing] | None = None,
) -> ModelProvider:
    """Build a provider instance for a stored ProviderConfig row."""
    if provider_config.provider_type == "demo":
        return get_demo_provider()
    if provider_config.provider_type in {"openai", "openai_compatible"}:
        base_url, api_key = resolve_credentials(provider_config, decrypted_key)
        return OpenAICompatibleProvider(
            base_url=base_url,
            api_key=api_key,
            organization_id=provider_config.organization_id,
            pricing_by_model=pricing_by_model,
        )
    raise LookupError(
        f"Provider type '{provider_config.provider_type}' is not configured in this environment"
    )


def get_provider(provider_type: str) -> DemoProvider:
    """Legacy registry lookup for the Demo Provider. Real providers are
    constructed per configuration via build_provider()."""
    if provider_type == "demo":
        return get_demo_provider()
    raise LookupError(f"Provider type '{provider_type}' is not configured in this environment")
