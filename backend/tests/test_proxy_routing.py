"""Deployed-routing smoke test through the shared reverse proxy.

Production and development both route through the platform's path-based
reverse proxy (most-specific-first: web static build at "/", FastAPI at
"/api"). This exercises the exact browser path: root HTML, dev-login with a
session cookie, and a cookie-protected /api/v1/me request — all via the
proxy, never a direct service port.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

import pytest

PROXY = "http://localhost:80"


def _proxy_up() -> bool:
    try:
        with urllib.request.urlopen(f"{PROXY}/api/health/ready", timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


@pytest.mark.skipif(not _proxy_up(), reason="shared proxy not reachable")
def test_login_and_protected_me_through_proxy():
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    # Unauthenticated protected route is rejected, proving /api reaches FastAPI
    # (a static-site rewrite would have returned index.html with a 200).
    try:
        opener.open(f"{PROXY}/api/v1/me", timeout=10)
        raise AssertionError("unauthenticated /api/v1/me should not return 200")
    except urllib.error.HTTPError as exc:
        assert exc.code == 401

    req = urllib.request.Request(
        f"{PROXY}/api/v1/auth/dev-login",
        data=json.dumps({"email": "proxy-smoke@example.com"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with opener.open(req, timeout=10) as resp:
        assert resp.status == 200
        login = json.loads(resp.read().decode())
    assert login["user"]["email"] == "proxy-smoke@example.com"

    with opener.open(f"{PROXY}/api/v1/me", timeout=10) as resp:
        me = json.loads(resp.read().decode())
    assert me["user"]["email"] == "proxy-smoke@example.com"

    # The web app is served at "/" by the same proxy.
    with opener.open(f"{PROXY}/", timeout=10) as resp:
        assert resp.status == 200
        assert b"<!DOCTYPE html>" in resp.read(200)
