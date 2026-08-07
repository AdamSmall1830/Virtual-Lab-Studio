"""Application configuration via Pydantic Settings."""
import os
from functools import lru_cache
from pathlib import Path
from typing import ClassVar

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]
SPECS_DIR = REPO_ROOT / "specs"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # Safe default: production. Development features (dev-login, non-secure
    # cookies) require an explicit APP_ENV=development opt-in.
    app_env: str = "production"
    database_url: str = ""
    session_secret: str = ""
    session_cookie_name: str = "vls_session"
    session_max_age_seconds: int = 60 * 60 * 24 * 14
    # Managed identity provider (Clerk). Empty = Clerk sign-in disabled.
    clerk_secret_key: str = ""
    # Clerk publishable key (pk_test_*/pk_live_*). Its base64 payload encodes
    # the instance Frontend API domain, from which the expected JWT issuer is
    # derived. Empty = issuer validation cannot be pinned (see clerk.py).
    clerk_publishable_key: str = ""
    run_worker_enabled: bool = True
    worker_id: str = "worker-1"
    worker_poll_seconds: float = 1.0
    worker_lease_seconds: int = 90
    demo_latency_enabled: bool = True
    # Replit AI Integrations proxy (zero-key OpenAI-compatible option).
    # Provisioned automatically when the integration is set up; empty = unavailable.
    ai_integrations_openai_base_url: str = ""
    ai_integrations_openai_api_key: str = ""
    # Comma-separated emails allowed to use the zero-key Replit AI option
    # (billed to the workspace owner's Replit credits). Empty = nobody.
    replit_ai_allowed_emails: str = ""

    # --- Optional Recursive Agent (Beta) -------------------------------
    # A participant may optionally be executed by an external worker the user
    # runs on their own machine instead of by a direct provider completion.
    # Every flag here is off or conservative by default: the feature cannot
    # switch itself on, and no code path may silently substitute a standard
    # completion when recursive execution is unavailable.
    recursive_agents_enabled: bool = False
    # Deterministic in-process simulator used to exercise the broker without
    # real hardware. Gated further by recursive_fake_worker_enabled so it can
    # never be reachable in a Replit deployment.
    recursive_agents_allow_fake_worker: bool = False
    # Keyed-hash pepper for worker credentials. Never stored alongside the
    # hashes it protects; required before the feature may be enabled.
    recursive_worker_token_pepper: str = ""
    recursive_worker_offline_after_seconds: int = 90
    recursive_worker_enrollment_ttl_seconds: int = 900
    recursive_job_lease_seconds: int = 60
    recursive_job_max_attempts: int = 3
    recursive_job_event_batch_max: int = 100
    recursive_job_event_body_max_bytes: int = 262_144
    recursive_job_result_body_max_bytes: int = 1_048_576
    # Per-job budget ceilings. "default_" seeds a new participant config;
    # "hard_" is the deployment policy limit a workspace cannot exceed.
    recursive_job_default_max_runtime_seconds: int = 900
    recursive_job_hard_max_runtime_seconds: int = 3600
    recursive_job_default_max_tokens: int = 32_000
    recursive_job_hard_max_tokens: int = 200_000
    recursive_job_default_max_children: int = 3
    recursive_job_hard_max_children: int = 8
    recursive_job_default_max_depth: int = 1
    recursive_job_hard_max_depth: int = 2
    recursive_job_default_max_agent_turns: int = 8
    recursive_job_hard_max_agent_turns: int = 20
    recursive_job_default_max_cost_usd: float = 2.0
    recursive_job_hard_max_cost_usd: float = 25.0

    # Shortest pepper we will accept. Worker credentials are the only thing
    # standing between a stranger and a job bundle of frozen evidence.
    RECURSIVE_PEPPER_MIN_LENGTH: ClassVar[int] = 32

    @property
    def recursive_fake_worker_enabled(self) -> bool:
        """Deterministic simulator gate.

        Requires the feature, its own opt-in flag, and that we are not in a
        Replit deployment. The deployment check is the hard failsafe, mirroring
        dev_login_enabled: a simulated recursive result must never be reachable
        in a live deployment, where it could be mistaken for real analysis.
        """
        return (
            self.recursive_agents_enabled
            and self.recursive_agents_allow_fake_worker
            and not self.is_deployment
        )

    def require_recursive_ready(self) -> None:
        """Refuse to run with the feature on but its credential secret unset.

        Fail loudly rather than quietly disabling the feature: an operator who
        set RECURSIVE_AGENTS_ENABLED expects it on, and hashing worker
        credentials with an empty pepper would look like it worked.
        """
        if not self.recursive_agents_enabled:
            return
        if len(self.recursive_worker_token_pepper) < self.RECURSIVE_PEPPER_MIN_LENGTH:
            raise ValueError(
                "RECURSIVE_AGENTS_ENABLED requires RECURSIVE_WORKER_TOKEN_PEPPER "
                f"(pepper) of at least {self.RECURSIVE_PEPPER_MIN_LENGTH} characters"
            )

    def replit_ai_email_allowed(self, email: str | None) -> bool:
        allowed = {
            e.strip().lower() for e in self.replit_ai_allowed_emails.split(",") if e.strip()
        }
        return bool(email) and email.strip().lower() in allowed

    @property
    def is_development(self) -> bool:
        return self.app_env.lower() == "development"

    @property
    def is_deployment(self) -> bool:
        """True when running inside a Replit deployment.

        Replit sets REPLIT_DEPLOYMENT in deployed environments. This is an
        INDEPENDENT signal from APP_ENV: APP_ENV is operator-controlled and
        therefore not trustworthy on its own (a deploy misconfigured with
        APP_ENV=development must NOT unlock development-only bypasses). We
        read the process environment directly rather than a Settings field so
        it cannot be overridden by a stray env var of the same Pydantic name.
        """
        value = os.environ.get("REPLIT_DEPLOYMENT", "")
        return value.strip().lower() not in ("", "0", "false", "no")

    @property
    def dev_login_enabled(self) -> bool:
        """Passwordless dev-login gate.

        Requires BOTH APP_ENV=development AND that we are not in a Replit
        deployment. The deployment check is the hard failsafe: even if APP_ENV
        is accidentally set to development in a live deployment, dev-login
        stays disabled.
        """
        return self.is_development and not self.is_deployment

    @property
    def async_database_url(self) -> str:
        url = self.database_url
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
        # asyncpg does not understand sslmode query param
        for token in ("?sslmode=require", "&sslmode=require", "?sslmode=disable", "&sslmode=disable"):
            url = url.replace(token, "")
        return url

    @property
    def sync_database_url(self) -> str:
        url = self.database_url
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
        return url


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL is required")
    if not settings.session_secret:
        raise RuntimeError("SESSION_SECRET is required")
    if not settings.is_development and settings.session_secret in {"dev", "changeme", "secret"}:
        raise RuntimeError("Refusing to start production with a weak SESSION_SECRET")
    try:
        settings.require_recursive_ready()
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc
    return settings
