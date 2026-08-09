"""Security-finding regression tests.

Covers four hardening fixes:
  1. dev-login is double-gated (APP_ENV AND not-a-deployment).
  2. Clerk JWT issuer is validated against the configured instance.
  3. Cross-workspace template-version references are rejected in draft validation.
  4. Interventions reject evidence IDs that are missing or foreign to the run's
     workspace.

Findings 1 and 2 are pure-config/crypto unit tests. Findings 3 and 4 exercise
the real API handlers against the shared development database via the
`sessionmaker` fixture (see conftest.py), seeding as the other integration
tests do.
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402


async def _any_user(db):
    """A User to stand in as the launching member for _validate_draft.

    Draft validation needs to know who is launching so it can refuse another
    member's personal provider key. These tests use workspace-scoped keys, so
    the identity is immaterial; an unsaved row is enough and keeps the test
    from depending on what happens to be in the development database.
    """
    from app.models import User as _User
    from sqlalchemy import select as _select

    found = (await db.execute(_select(_User).limit(1))).scalars().first()
    return found if found is not None else _User(id=uuid.uuid4(), email="validator@test.local")


# ---------------------------------------------------------------------------
# FINDING 1: dev-login double gate (APP_ENV *and* not-a-deployment)
# ---------------------------------------------------------------------------

def _settings(monkeypatch, **env) -> Settings:
    monkeypatch.setenv("DATABASE_URL", "postgresql://example/db")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("REPLIT_DEPLOYMENT", raising=False)
    for k, v in env.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)
    return Settings()


def test_dev_login_enabled_in_local_dev(monkeypatch):
    s = _settings(monkeypatch, APP_ENV="development")
    assert s.is_development is True
    assert s.is_deployment is False
    assert s.dev_login_enabled is True


def test_dev_login_refused_in_deployment_even_if_app_env_dev(monkeypatch):
    # The critical failsafe: a deployment with a misconfigured APP_ENV must
    # NOT unlock the passwordless bypass.
    s = _settings(monkeypatch, APP_ENV="development", REPLIT_DEPLOYMENT="1")
    assert s.is_development is True
    assert s.is_deployment is True
    assert s.dev_login_enabled is False


def test_dev_login_refused_in_production(monkeypatch):
    s = _settings(monkeypatch, APP_ENV="production")
    assert s.is_development is False
    assert s.dev_login_enabled is False


def test_is_deployment_treats_falsey_values_as_not_deployed(monkeypatch):
    for falsey in ("", "0", "false", "no"):
        s = _settings(monkeypatch, APP_ENV="development", REPLIT_DEPLOYMENT=falsey)
        assert s.is_deployment is False, falsey
        assert s.dev_login_enabled is True, falsey


# ---------------------------------------------------------------------------
# FINDING 2: Clerk JWT issuer validation
# ---------------------------------------------------------------------------

def _issue_token(private_pem: str, kid: str, *, iss: str, extra: dict | None = None) -> str:
    import time as _time

    import jwt as _jwt

    claims = {
        "sub": "user_test",
        "iss": iss,
        "iat": int(_time.time()) - 5,
        "exp": int(_time.time()) + 300,
    }
    if extra:
        claims.update(extra)
    return _jwt.encode(claims, private_pem, algorithm="RS256", headers={"kid": kid})


@pytest.fixture()
def clerk_rsa(monkeypatch):
    """A throwaway RSA keypair + a publishable key pinning a test issuer.

    Monkeypatches clerk._fetch_jwks so no network JWKS call happens, and sets
    a publishable key whose base64 payload decodes to the expected domain.
    """
    import base64

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from jwt.algorithms import RSAAlgorithm

    import app.clerk as clerk_mod

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    kid = "test-kid-1"
    jwk = RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
    jwk["kid"] = kid
    jwk["alg"] = "RS256"
    jwk["use"] = "sig"

    domain = "concise-test-99.clerk.accounts.dev"
    payload = base64.b64encode(f"{domain}$".encode()).decode()
    pub_key = f"pk_test_{payload}"

    # Point the settings the verifier reads at our test instance.
    settings = clerk_mod.get_settings()
    monkeypatch.setattr(settings, "clerk_publishable_key", pub_key, raising=False)
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_dummy", raising=False)

    async def _fake_fetch(client, force=False):
        return [jwk]

    monkeypatch.setattr(clerk_mod, "_fetch_jwks", _fake_fetch)

    return {"private_pem": private_pem, "kid": kid, "issuer": f"https://{domain}"}


async def test_clerk_valid_issuer_accepted(clerk_rsa):
    import httpx

    import app.clerk as clerk_mod

    token = _issue_token(clerk_rsa["private_pem"], clerk_rsa["kid"], iss=clerk_rsa["issuer"])
    async with httpx.AsyncClient() as client:
        claims = await clerk_mod._verify_token(client, token)
    assert claims["sub"] == "user_test"
    assert claims["iss"] == clerk_rsa["issuer"]


async def test_clerk_wrong_issuer_rejected(clerk_rsa):
    import httpx

    import app.clerk as clerk_mod

    token = _issue_token(
        clerk_rsa["private_pem"], clerk_rsa["kid"],
        iss="https://evil-instance.clerk.accounts.dev",
    )
    async with httpx.AsyncClient() as client:
        with pytest.raises(clerk_mod.ClerkAuthError) as exc:
            await clerk_mod._verify_token(client, token)
    assert exc.value.code == "invalid_issuer"


# ---------------------------------------------------------------------------
# Shared helpers for findings 3 & 4 (DB integration)
# ---------------------------------------------------------------------------

async def _seed(db):
    from app.seed import seed

    await seed(db)


async def _virtual_lab(db):
    from app.models import Workspace

    return (
        await db.execute(select(Workspace).where(Workspace.slug == "virtual-lab"))
    ).scalar_one()


async def _foreign_workspace(db):
    """A distinct, throwaway workspace to host foreign-tenant resources."""
    from app.models import Workspace

    ws = Workspace(
        slug=f"finding-foreign-{uuid.uuid4().hex[:8]}",
        name="Foreign Tenant",
    )
    db.add(ws)
    await db.flush()
    return ws


# ---------------------------------------------------------------------------
# FINDING 3: cross-workspace template reference rejected in draft validation
# ---------------------------------------------------------------------------

async def test_foreign_template_version_rejected(sessionmaker):
    from app.api.v1 import _validate_draft
    from app.models import TemplateProfile, TemplateVersion
    from app.schemas import MeetingDraftIn

    async with sessionmaker() as db:
        await _seed(db)
        target = await _virtual_lab(db)
        foreign = await _foreign_workspace(db)

        # A template that belongs ONLY to the foreign workspace.
        profile = TemplateProfile(
            workspace_id=foreign.id,
            slug=f"foreign-tmpl-{uuid.uuid4().hex[:8]}",
            name="Foreign Template",
        )
        db.add(profile)
        await db.flush()
        version = TemplateVersion(
            template_profile_id=profile.id,
            version_number=1,
            meeting_type="team",
            definition_json={"x": 1},
            definition_sha256="0" * 64,
        )
        db.add(version)
        await db.flush()

        # Build a minimal-but-valid team draft referencing the foreign template.
        draft = _minimal_team_draft(template_version_id=version.id)
        body = MeetingDraftIn.model_validate(draft)
        actor = await _any_user(db)
        errors, _warnings, _calls = await _validate_draft(db, target.id, body, actor)

        fields = {e["field"] for e in errors}
        assert "template_version_id" in fields, errors
        assert any(
            "not in this workspace" in e["message"]
            for e in errors if e["field"] == "template_version_id"
        )

        # Sanity: a nonexistent template id is also rejected.
        draft2 = _minimal_team_draft(template_version_id=uuid.uuid4())
        errors2, _, _ = await _validate_draft(
            db, target.id, MeetingDraftIn.model_validate(draft2), actor
        )
        assert "template_version_id" in {e["field"] for e in errors2}

        await db.rollback()


def _minimal_team_draft(*, template_version_id) -> dict:
    """A structurally-valid team draft; agent IDs are random (they are not
    what this test asserts on — we only care that the template check fires)."""
    return {
        "title": "T",
        "meeting_type": "team",
        "agenda": "a",
        "questions": ["q"],
        "rules": [],
        "contexts": [],
        "rounds": 1,
        "default_temperature": 0.2,
        "budget": {"max_provider_calls": 50, "max_cost_usd": 5},
        "template_version_id": str(template_version_id),
        "evidence_source_ids": [],
        "agents": [
            {
                "position": 0, "role_type": "lead",
                "agent_version_id": str(uuid.uuid4()),
                "provider_config_id": str(uuid.uuid4()),
                "provider_model_id": str(uuid.uuid4()),
                "tool_definition_ids": [],
            },
            {
                "position": 1, "role_type": "member",
                "agent_version_id": str(uuid.uuid4()),
                "provider_config_id": str(uuid.uuid4()),
                "provider_model_id": str(uuid.uuid4()),
                "tool_definition_ids": [],
            },
        ],
    }


# ---------------------------------------------------------------------------
# FINDING 4: interventions reject foreign / unknown evidence IDs
# ---------------------------------------------------------------------------

async def test_intervention_rejects_foreign_evidence(sessionmaker):
    from fastapi import HTTPException

    from app.api.v1 import add_intervention
    from app.models import (
        EvidenceSource,
        MeetingDefinition,
        Project,
        Run,
        User,
    )
    from app.engine import canonical_json, sha256_text
    from app.schemas import InterventionIn

    async with sessionmaker() as db:
        await _seed(db)
        target = await _virtual_lab(db)
        foreign = await _foreign_workspace(db)

        actor = (await db.execute(select(User).limit(1))).scalar_one_or_none()
        if actor is None:
            actor = User(auth_provider="dev", auth_subject="fx@test.dev", email="fx@test.dev",
                         display_name="fx")
            db.add(actor)
            await db.flush()

        project = (
            await db.execute(select(Project).where(Project.workspace_id == target.id).limit(1))
        ).scalar_one()

        djson = {"t": str(uuid.uuid4())}
        definition = MeetingDefinition(
            workspace_id=target.id, project_id=project.id, title="Interv test",
            meeting_type="team", agenda="a", questions=["q"], rules=[], contexts=[],
            rounds=1, default_temperature=0.2,
            budget={"max_provider_calls": 5, "max_cost_usd": 5},
            definition_json=djson, definition_sha256=sha256_text(canonical_json(djson)),
        )
        db.add(definition)
        await db.flush()
        run = Run(
            workspace_id=target.id, project_id=project.id,
            meeting_definition_id=definition.id, status="running", demo_mode=True,
            created_by=actor.id,
        )
        db.add(run)
        await db.flush()

        # Evidence that lives in the FOREIGN workspace.
        foreign_ev = EvidenceSource(
            workspace_id=foreign.id,
            evidence_key="EF1",
            source_type="note",
            title="Foreign evidence",
            content_sha256="0" * 64,
            processing_status="ready",
        )
        db.add(foreign_ev)
        await db.flush()

        # Foreign evidence -> 422 invalid_evidence.
        with pytest.raises(HTTPException) as exc:
            await add_intervention(
                run.id,
                InterventionIn(kind="evidence_addition", content="x",
                               evidence_source_ids=[foreign_ev.id]),
                user=actor, db=db,
            )
        assert exc.value.status_code == 422
        assert exc.value.detail["code"] == "invalid_evidence"

        # Nonexistent evidence -> also 422.
        with pytest.raises(HTTPException) as exc2:
            await add_intervention(
                run.id,
                InterventionIn(kind="evidence_addition", content="x",
                               evidence_source_ids=[uuid.uuid4()]),
                user=actor, db=db,
            )
        assert exc2.value.status_code == 422
        assert exc2.value.detail["code"] == "invalid_evidence"

        await db.rollback()
