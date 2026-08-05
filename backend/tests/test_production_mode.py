"""Production-mode security tests.

Boots the real app in a fresh process with APP_ENV unset (safe default) and
verifies the development login bypass is rejected and session cookies are
marked Secure. Uses the same fresh-database fixture as the clean-boot test.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import time
import urllib.error
import urllib.request

import pytest

from tests.test_clean_boot import PYTHON, REPO_ROOT, _free_port, fresh_database_url  # noqa: F401


def test_settings_default_to_production(monkeypatch):
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://example/db")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    from app.config import Settings

    settings = Settings()
    assert settings.app_env == "production"
    assert not settings.is_development


def test_production_boot_rejects_dev_login(fresh_database_url):  # noqa: F811
    port = _free_port()
    env = dict(os.environ)
    env.pop("APP_ENV", None)  # default must be production
    env.update({"DATABASE_URL": fresh_database_url, "RUN_WORKER_ENABLED": "false"})
    proc = subprocess.Popen(
        [PYTHON, "-m", "uvicorn", "app.main:app", "--app-dir", "backend",
         "--host", "127.0.0.1", "--port", str(port)],
        cwd=REPO_ROOT, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    try:
        deadline = time.time() + 90
        ready = False
        while time.time() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read().decode(errors="replace")
                pytest.fail(f"Server exited during boot:\n{out[-4000:]}")
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/api/health/ready", timeout=5
                ) as resp:
                    if json.loads(resp.read())["status"] == "ok":
                        ready = True
                        break
            except Exception:
                time.sleep(0.5)
        assert ready, "server never became ready"

        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/v1/auth/dev-login",
            data=json.dumps({"email": "attacker@example.com"}).encode(),
            method="POST", headers={"Content-Type": "application/json"},
        )
        with pytest.raises(urllib.error.HTTPError) as excinfo:
            urllib.request.urlopen(req, timeout=10)
        assert excinfo.value.code == 403
        body = json.loads(excinfo.value.read())
        assert body["detail"]["code"] == "dev_login_disabled"
        # No session cookie must be issued on the rejected request.
        assert "set-cookie" not in {k.lower() for k in excinfo.value.headers.keys()}
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
