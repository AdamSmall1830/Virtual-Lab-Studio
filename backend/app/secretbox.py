"""Server-side encryption for provider credentials.

API keys are encrypted at rest with AES-256-GCM. The data key is derived
from SESSION_SECRET via HKDF-SHA256 with a versioned info label so the key
can be rotated by bumping the version. Plaintext keys never leave the
server process and are never returned by the API.
"""
from __future__ import annotations

import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .config import get_settings

CURRENT_KEY_VERSION = 1


def _derive_key(version: int) -> bytes:
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"vls-provider-secrets",
        info=f"provider-secret-v{version}".encode(),
    )
    return hkdf.derive(get_settings().session_secret.encode())


def encrypt_secret(plaintext: str) -> tuple[bytes, bytes, int]:
    """Returns (ciphertext, nonce, key_version)."""
    nonce = os.urandom(12)
    ct = AESGCM(_derive_key(CURRENT_KEY_VERSION)).encrypt(nonce, plaintext.encode(), b"provider-secret")
    return ct, nonce, CURRENT_KEY_VERSION


def decrypt_secret(ciphertext: bytes, nonce: bytes, key_version: int) -> str:
    pt = AESGCM(_derive_key(key_version)).decrypt(nonce, ciphertext, b"provider-secret")
    return pt.decode()
