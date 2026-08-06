"""Clean-database boot test.

Creates a brand-new empty PostgreSQL database, boots the real FastAPI app
(fresh process via uvicorn, so lifespan bootstrap = migrations + seed runs
exactly as in deployment), then exercises dev login and a full demo meeting
launch end to end. Verifies the review criterion: a fresh deployment works
with no manual init steps.
"""
from __future__ import annotations

import json
import os
import secrets
import signal
import socket
import subprocess
import time
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

import psycopg
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON = str(REPO_ROOT / "backend" / ".venv" / "bin" / "python")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def fresh_database_url():
    admin_url = os.environ["DATABASE_URL"]
    db_name = f"vls_boottest_{secrets.token_hex(4)}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{db_name}"')
    parts = urllib.parse.urlsplit(admin_url)
    fresh = urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, f"/{db_name}", parts.query, "")
    )
    try:
        yield fresh
    finally:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s",
                (db_name,),
            )
            conn.execute(f'DROP DATABASE IF EXISTS "{db_name}"')


def _request(opener, method: str, url: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with opener.open(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def test_fresh_database_boot_login_and_demo_launch(fresh_database_url):
    port = _free_port()
    env = dict(os.environ)
    env.update({
        "DATABASE_URL": fresh_database_url,
        "APP_ENV": "development",
        "RUN_WORKER_ENABLED": "true",
        "WORKER_POLL_SECONDS": "0.2",
    })
    proc = subprocess.Popen(
        [PYTHON, "-m", "uvicorn", "app.main:app", "--app-dir", "backend",
         "--host", "127.0.0.1", "--port", str(port)],
        cwd=REPO_ROOT, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}/api/v1"
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    try:
        # Wait for boot (migrations + seed happen in lifespan before serving).
        deadline = time.time() + 90
        ready = None
        while time.time() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read().decode(errors="replace")
                pytest.fail(f"Server exited during boot:\n{out[-4000:]}")
            try:
                ready = _request(opener, "GET", f"http://127.0.0.1:{port}/api/health/ready")
                if ready.get("status") == "ok":
                    break
            except Exception:
                time.sleep(0.5)
        assert ready and ready["status"] == "ok", "server never became ready"
        assert ready["migration"] is not None

        # Dev login works on the freshly seeded database.
        login = _request(opener, "POST", f"{base}/auth/dev-login",
                         {"email": "boot@example.com", "display_name": "Boot Test"})
        assert login["user"]["email"] == "boot@example.com"

        workspaces = _request(opener, "GET", f"{base}/workspaces")
        assert workspaces, "seed did not create the demo workspace"
        ws = workspaces[0]["id"]
        projects = _request(opener, "GET", f"{base}/workspaces/{ws}/projects")
        assert projects, "seed did not create the demo project"
        agents = _request(opener, "GET", f"{base}/workspaces/{ws}/agents")
        by_slug = {a["slug"]: a for a in agents}
        assert "principal-investigator" in by_slug
        providers = _request(opener, "GET", f"{base}/workspaces/{ws}/providers")
        pc = providers[0]
        pm = pc["models"][0]

        draft = _request(opener, "POST", f"{base}/projects/{projects[0]['id']}/meeting-drafts", {
            "title": "Clean boot demo", "meeting_type": "team",
            "agenda": "Verify fresh deployment", "questions": ["Does it work?"],
            "rounds": 1,
            "agents": [
                {"position": 0, "role_type": "lead",
                 "agent_version_id": by_slug["principal-investigator"]["latest_version"]["id"],
                 "provider_config_id": pc["id"], "provider_model_id": pm["id"]},
                {"position": 1, "role_type": "member",
                 "agent_version_id": by_slug["scientific-critic"]["latest_version"]["id"],
                 "provider_config_id": pc["id"], "provider_model_id": pm["id"]},
            ],
        })
        launch = _request(opener, "POST", f"{base}/meeting-drafts/{draft['id']}/launch")
        run_id = launch["run_id"]

        # The in-process worker should pick it up and complete it.
        deadline = time.time() + 60
        status = None
        while time.time() < deadline:
            run = _request(opener, "GET", f"{base}/runs/{run_id}")
            status = run["status"]
            if status in {"completed", "failed", "cancelled", "budget_stopped"}:
                break
            time.sleep(0.5)
        assert status == "completed", f"run ended in status {status}"
        assert run["provider_call_count"] == 3

        # The terminal status is committed before the closing events (summary,
        # citations, manifest, run.completed) are appended, so poll for the
        # event rather than assuming it landed the instant status flipped.
        deadline = time.time() + 30
        types: list[str] = []
        while time.time() < deadline:
            events = _request(opener, "GET", f"{base}/runs/{run_id}/events?after=0&limit=200")
            types = [e["event_type"] for e in events]
            if "run.completed" in types:
                break
            time.sleep(0.5)
        assert "run.queued" in types and "run.completed" in types
        summary = _request(opener, "GET", f"{base}/runs/{run_id}/summary")
        assert summary["validation_status"] == "valid"
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
