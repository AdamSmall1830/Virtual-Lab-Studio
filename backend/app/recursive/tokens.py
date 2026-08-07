"""Minting and verification of external-worker credentials.

A credential looks like ``rwk_<prefix>_<secret>`` (or ``rwe_...`` for a
one-time enrollment token). Only a keyed hash of the secret is stored:

* the ``prefix`` is a non-secret lookup handle, so verification is one indexed
  read followed by a single constant-time comparison rather than a scan that
  hashes every row;
* the hash is HMAC-SHA256 under a key derived from
  ``RECURSIVE_WORKER_TOKEN_PEPPER``, so a database dump alone -- without the
  deployment's pepper -- yields nothing a worker could authenticate with.

The raw secret exists exactly twice: in the response that mints it, and in the
operator's own configuration. It is never logged, never re-displayable, and
never written to a run event, an export or an audit payload.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from ..config import get_settings

# Bumping this invalidates every stored hash, which is the intended effect of
# rotating the pepper: enrolled workers must re-enroll.
KEY_VERSION = 1

ENROLLMENT_PREFIX = "rwe"
WORKER_PREFIX = "rwk"

_PREFIX_BYTES = 6  # 12 hex characters -- a lookup handle, not a secret
_SECRET_BYTES = 32


@dataclass(frozen=True)
class MintedToken:
    """A freshly minted credential. ``raw`` must never be persisted."""

    raw: str
    prefix: str
    token_hash: str


def _derive_key(kind: str) -> bytes:
    """Separate key material per credential kind.

    An enrollment token and a worker token are different privileges with
    different lifetimes; deriving separate keys means a hash captured from one
    table can never be replayed against the other.
    """
    pepper = get_settings().recursive_worker_token_pepper
    if not pepper:
        # get_settings() already refuses to start the feature without a pepper.
        # Reaching here means something bypassed that check, and silently
        # hashing under an empty key would make every credential forgeable.
        raise RuntimeError("Recursive worker token pepper is not configured")
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"vls-recursive-worker-tokens",
        info=f"{kind}-v{KEY_VERSION}".encode(),
    ).derive(pepper.encode())


def hash_secret(kind: str, secret: str) -> str:
    """Keyed hash of a credential secret, versioned so the pepper can rotate."""
    digest = hmac.new(_derive_key(kind), secret.encode(), hashlib.sha256).hexdigest()
    return f"v{KEY_VERSION}:{digest}"


def mint(kind: str) -> MintedToken:
    prefix = secrets.token_hex(_PREFIX_BYTES)
    secret = secrets.token_urlsafe(_SECRET_BYTES)
    return MintedToken(
        raw=f"{kind}_{prefix}_{secret}",
        prefix=prefix,
        token_hash=hash_secret(kind, secret),
    )


def parse(kind: str, raw: str | None) -> tuple[str, str] | None:
    """Split a presented credential into ``(prefix, secret)``.

    Returns None for anything that is not a well-formed credential of this
    kind, so callers can answer with a single generic rejection instead of
    telling an attacker which part of the value was wrong.
    """
    if not raw:
        return None
    parts = raw.split("_", 2)
    if len(parts) != 3:
        return None
    presented_kind, prefix, secret = parts
    if presented_kind != kind or not secret:
        return None
    if len(prefix) != _PREFIX_BYTES * 2 or not all(c in "0123456789abcdef" for c in prefix):
        return None
    return prefix, secret


def verify(kind: str, secret: str, stored_hash: str) -> bool:
    """Constant-time comparison against the stored keyed hash."""
    try:
        candidate = hash_secret(kind, secret)
    except RuntimeError:
        return False
    return hmac.compare_digest(candidate, stored_hash)
