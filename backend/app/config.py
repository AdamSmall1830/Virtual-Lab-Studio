"""Application configuration via Pydantic Settings."""
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
    run_worker_enabled: bool = True
    worker_id: str = "worker-1"
    worker_poll_seconds: float = 1.0
    worker_lease_seconds: int = 90
    demo_latency_enabled: bool = True
    # Replit AI Integrations proxy (zero-key OpenAI-compatible option).
    # Provisioned automatically when the integration is set up; empty = unavailable.
    ai_integrations_openai_base_url: str = ""
    ai_integrations_openai_api_key: str = ""

    @property
    def is_development(self) -> bool:
        return self.app_env.lower() == "development"

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
