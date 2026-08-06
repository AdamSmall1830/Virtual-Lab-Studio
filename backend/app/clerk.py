"""Clerk (managed identity provider) server-side token verification.

The browser signs in through Clerk's hosted components; the frontend then
posts the short-lived Clerk session JWT to /api/v1/auth/clerk-login. Here we
verify the JWT signature against the instance JWKS (fetched with the Clerk
secret key, so this works for both development and production instances),
then look up the user's profile via the Clerk Backend API.

The verified identity is bridged into the app's existing signed session
cookie; Clerk tokens are never stored.
"""
from __future__ import annotations

import base64
import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from jwt import PyJWK

from .config import get_settings

CLERK_API_BASE = "https://api.clerk.com/v1"
_JWKS_TTL_SECONDS = 3600


def _expected_issuer() -> str | None:
    """Expected `iss` claim for the configured Clerk instance.

    Clerk session JWTs carry `iss = https://<frontend-api-domain>`. The
    publishable key (pk_test_*/pk_live_*) base64-encodes that domain as
    `<domain>$`, so we can pin the issuer without adding a new operator
    config value. Returns None only when no publishable key is configured,
    in which case the caller keeps the previous (unpinned) behavior.
    """
    pk = get_settings().clerk_publishable_key.strip()
    if not pk:
        return None
    try:
        payload = pk.split("_", 2)[2]
    except IndexError:
        return None
    if not payload:
        return None
    # base64 without padding; add it back before decoding.
    padded = payload + "=" * (-len(payload) % 4)
    try:
        domain = base64.b64decode(padded).decode("utf-8").rstrip("$")
    except (ValueError, UnicodeDecodeError):
        return None
    if not domain:
        return None
    return f"https://{domain}"

_jwks_cache: dict[str, Any] = {"keys": None, "fetched_at": 0.0}


class ClerkAuthError(Exception):
    """Raised when a Clerk token cannot be verified."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ClerkIdentity:
    subject: str
    email: str | None
    display_name: str | None
    avatar_url: str | None


def _secret_key() -> str:
    secret = get_settings().clerk_secret_key
    if not secret:
        raise ClerkAuthError("clerk_not_configured", "Clerk is not configured on the server.")
    return secret


async def _fetch_jwks(client: httpx.AsyncClient, force: bool = False) -> list[dict[str, Any]]:
    now = time.monotonic()
    if (
        not force
        and _jwks_cache["keys"] is not None
        and now - _jwks_cache["fetched_at"] < _JWKS_TTL_SECONDS
    ):
        return _jwks_cache["keys"]
    resp = await client.get(
        f"{CLERK_API_BASE}/jwks",
        headers={"Authorization": f"Bearer {_secret_key()}"},
    )
    resp.raise_for_status()
    keys = resp.json().get("keys", [])
    _jwks_cache["keys"] = keys
    _jwks_cache["fetched_at"] = now
    return keys


async def _verify_token(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError as exc:
        raise ClerkAuthError("invalid_token", "Malformed Clerk token.") from exc
    kid = header.get("kid")
    if not kid:
        raise ClerkAuthError("invalid_token", "Clerk token is missing a key id.")

    key_data = None
    for force in (False, True):  # refetch once on unknown kid (key rotation)
        keys = await _fetch_jwks(client, force=force)
        key_data = next((k for k in keys if k.get("kid") == kid), None)
        if key_data is not None:
            break
    if key_data is None:
        raise ClerkAuthError("unknown_key", "Clerk signing key not recognized.")

    expected_issuer = _expected_issuer()
    decode_kwargs: dict[str, Any] = {}
    if expected_issuer is not None:
        # Pin the issuer to the configured Clerk instance so a validly-signed
        # token from a different instance is rejected. PyJWT raises
        # InvalidIssuerError (a subclass of InvalidTokenError) on mismatch.
        decode_kwargs["issuer"] = expected_issuer
    try:
        claims = jwt.decode(
            token,
            PyJWK.from_dict(key_data).key,
            algorithms=["RS256"],
            leeway=10,
            # verify_aud stays off: Clerk session JWTs do not carry a fixed
            # `aud` claim for this app, and no audience is configured, so
            # there is nothing to validate against. Issuer is pinned instead.
            options={"verify_aud": False},
            **decode_kwargs,
        )
    except jwt.ExpiredSignatureError as exc:
        raise ClerkAuthError("token_expired", "Clerk token expired; sign in again.") from exc
    except jwt.InvalidIssuerError as exc:
        raise ClerkAuthError("invalid_issuer", "Clerk token issuer not recognized.") from exc
    except jwt.InvalidTokenError as exc:
        raise ClerkAuthError("invalid_token", "Clerk token failed verification.") from exc
    if not claims.get("sub"):
        raise ClerkAuthError("invalid_token", "Clerk token has no subject.")
    return claims


async def _fetch_profile(client: httpx.AsyncClient, subject: str) -> dict[str, Any]:
    resp = await client.get(
        f"{CLERK_API_BASE}/users/{subject}",
        headers={"Authorization": f"Bearer {_secret_key()}"},
    )
    if resp.status_code == 404:
        raise ClerkAuthError("unknown_user", "Clerk user no longer exists.")
    resp.raise_for_status()
    return resp.json()


async def resolve_clerk_identity(token: str) -> ClerkIdentity:
    """Verify a Clerk session JWT and return the user's identity/profile."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        claims = await _verify_token(client, token)
        subject = claims["sub"]
        try:
            profile = await _fetch_profile(client, subject)
        except httpx.HTTPError as exc:
            raise ClerkAuthError("clerk_unreachable", "Could not reach the identity provider.") from exc

    email = None
    primary_id = profile.get("primary_email_address_id")
    for entry in profile.get("email_addresses") or []:
        if entry.get("id") == primary_id or email is None:
            candidate = entry.get("email_address")
            if candidate:
                email = candidate
            if entry.get("id") == primary_id:
                break

    first = (profile.get("first_name") or "").strip()
    last = (profile.get("last_name") or "").strip()
    display_name = " ".join(p for p in (first, last) if p) or (profile.get("username") or None)
    return ClerkIdentity(
        subject=subject,
        email=email,
        display_name=display_name,
        avatar_url=profile.get("image_url") or None,
    )
