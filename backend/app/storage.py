"""App Storage access for evidence uploads and export packets.

Bytes go to Replit App Storage (GCS-backed) via the replit-object-storage
client; only object keys, hashes, and metadata are persisted in PostgreSQL.
Download paths are always server-side authorized routes — object keys are
never exposed as unrestricted URLs.

In development without a configured bucket the storage falls back to a local
directory so tests can run; production without a bucket fails loudly.
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path

import anyio

from .config import REPO_ROOT, get_settings

logger = logging.getLogger("vls.storage")

LOCAL_STORAGE_DIR = REPO_ROOT / "backend" / ".data" / "storage"


class StorageError(RuntimeError):
    pass


class ObjectStore:
    """Synchronous byte store; call through the async helpers below."""

    def put(self, key: str, data: bytes) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def get(self, key: str) -> bytes:  # pragma: no cover - interface
        raise NotImplementedError

    def get_to_file(self, key: str, dest_path: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError


class AppStorage(ObjectStore):
    def __init__(self) -> None:
        from replit.object_storage import Client

        bucket_id = os.environ.get("DEFAULT_OBJECT_STORAGE_BUCKET_ID") or None
        self._client = Client(bucket_id=bucket_id)
        # Fail fast at construction if the bucket is unreachable so the
        # factory can fall back (development) or raise loudly (production).
        self._client.exists("__storage_healthcheck__")

    def put(self, key: str, data: bytes) -> None:
        self._client.upload_from_bytes(key, data)

    def get(self, key: str) -> bytes:
        return self._client.download_as_bytes(key)

    def get_to_file(self, key: str, dest_path: str) -> None:
        # Stream the object to disk so large packets never sit in memory.
        self._client.download_to_filename(key, dest_path)


class LocalStorage(ObjectStore):
    """Development/test fallback when no App Storage bucket is configured."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        safe = key.strip("/")
        path = (self._root / safe).resolve()
        if not str(path).startswith(str(self._root.resolve())):
            raise StorageError("Invalid object key")
        return path

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get(self, key: str) -> bytes:
        path = self._path(key)
        if not path.exists():
            raise StorageError(f"Object not found: {key}")
        return path.read_bytes()

    def get_to_file(self, key: str, dest_path: str) -> None:
        import shutil

        path = self._path(key)
        if not path.exists():
            raise StorageError(f"Object not found: {key}")
        shutil.copyfile(path, dest_path)


@lru_cache
def get_object_store() -> ObjectStore:
    bucket = os.environ.get("DEFAULT_OBJECT_STORAGE_BUCKET_ID")
    if bucket:
        try:
            return AppStorage()
        except Exception as exc:  # noqa: BLE001
            if not get_settings().is_development:
                raise StorageError(f"App Storage unavailable: {type(exc).__name__}") from exc
            logger.warning("App Storage unavailable (%s); using local fallback", type(exc).__name__)
    elif not get_settings().is_development:
        raise StorageError("App Storage bucket is not configured")
    else:
        logger.warning("No App Storage bucket configured; using local development storage")
    return LocalStorage(LOCAL_STORAGE_DIR)


async def put_object(key: str, data: bytes) -> None:
    store = get_object_store()
    await anyio.to_thread.run_sync(store.put, key, data)


async def get_object(key: str) -> bytes:
    store = get_object_store()
    return await anyio.to_thread.run_sync(store.get, key)


async def get_object_to_file(key: str, dest_path: str) -> None:
    """Download an object directly to a file on disk (never fully in memory)."""
    store = get_object_store()
    await anyio.to_thread.run_sync(store.get_to_file, key, dest_path)
