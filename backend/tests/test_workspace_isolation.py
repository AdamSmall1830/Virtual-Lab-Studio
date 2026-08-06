"""Per-user private workspace provisioning + cross-user isolation.

Exercises the real HTTP surface through the shared proxy: two dev-login users
each get their own auto-provisioned personal workspace (owner role, baseline
demo project), and neither can read the other's workspace-scoped resources.
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
        me = json.loads(resp.read())
    return opener, me


@pytest.mark.skipif(not _proxy_up(), reason="shared proxy not reachable")
def test_personal_workspaces_are_isolated():
    alice, alice_me = _login("isolation.alice@test.dev")
    bob, bob_me = _login("isolation.bob@test.dev")

    def personal(me):
        [ws] = [w for w in me["workspaces"] if w["slug"].startswith("lab-")]
        return ws

    a_ws, b_ws = personal(alice_me), personal(bob_me)
    assert a_ws["id"] != b_ws["id"]

    # Owner of your own personal workspace.
    a_role = {m["workspace_id"]: m["role"] for m in alice_me["memberships"]}[a_ws["id"]]
    assert a_role == "owner"

    # Baseline seed exists in the personal workspace.
    with alice.open(f"{PROXY}/api/v1/workspaces/{a_ws['id']}/projects", timeout=10) as resp:
        slugs = [p["slug"] for p in json.loads(resp.read())]
    assert "biodegradable-packaging-pilot" in slugs

    # Cross-user access is a 404 (no existence leak).
    for path in ("projects", "agents", "providers"):
        try:
            alice.open(f"{PROXY}/api/v1/workspaces/{b_ws['id']}/{path}", timeout=10)
            raise AssertionError(f"alice should not read bob's {path}")
        except urllib.error.HTTPError as exc:
            assert exc.code == 404


@pytest.mark.skipif(not _proxy_up(), reason="shared proxy not reachable")
def test_clerk_login_requires_token():
    req = urllib.request.Request(f"{PROXY}/api/v1/auth/clerk-login", data=b"", method="POST")
    try:
        urllib.request.urlopen(req, timeout=10)
        raise AssertionError("clerk-login without a token should be rejected")
    except urllib.error.HTTPError as exc:
        assert exc.code == 401
