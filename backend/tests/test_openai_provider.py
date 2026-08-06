"""Unit tests for the OpenAI-compatible adapter, pricing, and secret crypto."""
import httpx
import pytest

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
