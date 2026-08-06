"""Application configuration via Pydantic Settings."""
import os
from functools import lru_cache
from pathlib import Path

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
    return settings
