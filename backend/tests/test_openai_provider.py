"""Unit tests for the OpenAI-compatible adapter, pricing, and secret crypto."""
import httpx
import pytest

from app import providers as providers_module
from app.providers import (
    CompletionRequest,
    ModelPricing,
    OpenAICompatibleProvider,
    ProviderCallError,
    ProviderConfigurationError,
    validate_base_url,
)
from app.secretbox import decrypt_secret, encrypt_secret


def _request(model: str = "gpt-5-mini") -> CompletionRequest:
    return CompletionRequest(
        model=model, system_prompt="sys",
        messages=[{"role": "user", "content": "hi"}],
        temperature=0.2, run_id="r", call_index=0,
        agent_title="A", role_type="lead", round_number=1, is_final=False,
    )


def test_secretbox_roundtrip():
    ct, nonce, ver = encrypt_secret("sk-super-secret")
    assert ct != b"sk-super-secret"
    assert decrypt_secret(ct, nonce, ver) == "sk-super-secret"


def test_pricing_cost():
    p = ModelPricing(input_per_million=0.25, output_per_million=2.0)
    assert p.complete
    assert p.cost(1_000_000, 0, 1_000_000) == pytest.approx(2.25)
    assert not ModelPricing(input_per_million=0.25).complete


def test_validate_base_url_blocks_private():
    with pytest.raises(ProviderConfigurationError):
        validate_base_url("http://169.254.169.254/v1")
    with pytest.raises(ProviderConfigurationError):
        validate_base_url("https://localhost/v1")
    assert validate_base_url("https://api.openai.com/v1/") == "https://api.openai.com/v1"


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


async def test_adapter_success_and_param_quirks(monkeypatch):
    body = {
        "id": "resp-123", "model": "gpt-5-mini",
        "choices": [{"message": {"content": "Hello"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 50,
                  "prompt_tokens_details": {"cached_tokens": 20}},
    }
    resp = httpx.Response(200, json=body, request=httpx.Request("POST", "https://x"))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _FakeClient(resp))
    provider = OpenAICompatibleProvider(
        "https://api.openai.com/v1", "sk-k",
        pricing_by_model={"gpt-5-mini": ModelPricing(input_per_million=0.25, output_per_million=2.0)},
    )
    result = await provider.complete(_request())
    assert result.content == "Hello"
    assert result.is_simulation is False
    assert result.provider_request_id == "resp-123"
    assert result.input_tokens == 100 and result.output_tokens == 50
    assert result.cached_input_tokens == 20
    assert result.cost_usd == pytest.approx((80 * 0.25 + 20 * 0.25 + 50 * 2.0) / 1_000_000)
    # gpt-5 models must not receive a temperature parameter
    assert "temperature" not in _FakeClient.last.captured["json"]
    assert _FakeClient.last.captured["headers"]["Authorization"] == "Bearer sk-k"

    result2 = await provider.complete(_request(model="gpt-4o-mini"))
    assert _FakeClient.last.captured["json"]["temperature"] == 0.2
    assert result2.cost_usd == 0.0  # no pricing configured for gpt-4o-mini


async def test_adapter_maps_errors(monkeypatch):
    resp = httpx.Response(401, json={"error": "nope"}, request=httpx.Request("POST", "https://x"))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _FakeClient(resp))
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "bad")
    with pytest.raises(ProviderCallError) as ei:
        await provider.complete(_request())
    assert ei.value.code == "provider_auth_failed"


class _SequenceClient:
    """Returns a scripted sequence of responses/exceptions, one per call."""

    calls = 0
    script: list = []

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None, headers=None):
        item = _SequenceClient.script[min(_SequenceClient.calls, len(_SequenceClient.script) - 1)]
        _SequenceClient.calls += 1
        if isinstance(item, Exception):
            raise item
        return item


def _install_sequence(monkeypatch, script, *, sleeps=None):
    _SequenceClient.calls = 0
    _SequenceClient.script = script
    monkeypatch.setattr(httpx, "AsyncClient", _SequenceClient)

    async def _no_sleep(seconds):
        if sleeps is not None:
            sleeps.append(seconds)

    monkeypatch.setattr(providers_module.asyncio, "sleep", _no_sleep)


def _ok_response():
    return httpx.Response(
        200,
        json={
            "id": "resp-1", "model": "gpt-4o-mini",
            "choices": [{"message": {"content": "Recovered"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        },
        request=httpx.Request("POST", "https://x"),
    )


async def test_rate_limit_is_retried_then_succeeds(monkeypatch):
    """A 429 mid-deliberation must not destroy the run."""
    sleeps: list[float] = []
    _install_sequence(
        monkeypatch,
        [
            httpx.Response(429, request=httpx.Request("POST", "https://x")),
            httpx.Response(503, request=httpx.Request("POST", "https://x")),
            _ok_response(),
        ],
        sleeps=sleeps,
    )
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "sk-k")
    result = await provider.complete(_request(model="gpt-4o-mini"))
    assert result.content == "Recovered"
    assert _SequenceClient.calls == 3
    assert len(sleeps) == 2
    assert sleeps[1] > sleeps[0]  # exponential backoff


async def test_rate_limit_honours_retry_after_header(monkeypatch):
    sleeps: list[float] = []
    _install_sequence(
        monkeypatch,
        [
            httpx.Response(429, headers={"retry-after": "5"},
                           request=httpx.Request("POST", "https://x")),
            _ok_response(),
        ],
        sleeps=sleeps,
    )
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "sk-k")
    await provider.complete(_request(model="gpt-4o-mini"))
    assert sleeps == [5.0]


async def test_rate_limit_gives_up_with_actionable_message(monkeypatch):
    _install_sequence(
        monkeypatch,
        [httpx.Response(429, request=httpx.Request("POST", "https://x"))],
        sleeps=[],
    )
    provider = OpenAICompatibleProvider(
        "https://api.openai.com/v1", "sk-k", max_attempts=3, retry_budget_seconds=600
    )
    with pytest.raises(ProviderCallError) as ei:
        await provider.complete(_request(model="gpt-4o-mini"))
    assert ei.value.code == "provider_rate_limited"
    assert _SequenceClient.calls == 3
    assert "fewer researchers or rounds" in ei.value.safe_message


async def test_retry_budget_caps_total_waiting(monkeypatch):
    """A long Retry-After beyond the budget fails fast instead of stalling."""
    sleeps: list[float] = []
    _install_sequence(
        monkeypatch,
        [httpx.Response(429, headers={"retry-after": "3600"},
                        request=httpx.Request("POST", "https://x"))],
        sleeps=sleeps,
    )
    provider = OpenAICompatibleProvider(
        "https://api.openai.com/v1", "sk-k", max_attempts=5, retry_budget_seconds=90
    )
    with pytest.raises(ProviderCallError):
        await provider.complete(_request(model="gpt-4o-mini"))
    assert _SequenceClient.calls == 1
    assert sleeps == []


async def test_timeouts_are_retried(monkeypatch):
    _install_sequence(
        monkeypatch,
        [httpx.TimeoutException("slow"), _ok_response()],
        sleeps=[],
    )
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "sk-k")
    result = await provider.complete(_request(model="gpt-4o-mini"))
    assert result.content == "Recovered"
    assert _SequenceClient.calls == 2


async def test_permanent_errors_are_not_retried(monkeypatch):
    """Retrying a bad key or unknown model just wastes the run's time."""
    for status, code in ((401, "provider_auth_failed"), (404, "provider_model_not_found")):
        _install_sequence(
            monkeypatch,
            [httpx.Response(status, request=httpx.Request("POST", "https://x"))],
            sleeps=[],
        )
        provider = OpenAICompatibleProvider("https://api.openai.com/v1", "sk-k")
        with pytest.raises(ProviderCallError) as ei:
            await provider.complete(_request(model="gpt-4o-mini"))
        assert ei.value.code == code
        assert _SequenceClient.calls == 1
