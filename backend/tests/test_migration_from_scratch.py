"""`alembic upgrade head` must work on an empty database, not just this one.

The initial revision applies specs/database_schema.sql at runtime, so a
from-scratch upgrade creates every object in that first revision and reaches
the later revisions with the work already done. Each later revision therefore
has to be a complete no-op on a fresh database while still performing the real
migration on an existing one -- and the only honest way to know that is to
build a database from nothing and compare it to this one.

Skipped automatically when the connection cannot create databases.
"""
from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path

import asyncpg
import pytest

from app.config import get_settings

REPO_ROOT = Path(__file__).resolve().parents[2]

# Everything that makes two schemas either the same or not.
CATALOG_QUERIES = {
    "columns": """
        SELECT table_name || '.' || column_name || ' ' || data_type
               || ' null=' || is_nullable
               || ' default=' || coalesce(column_default, '-')
        FROM information_schema.columns WHERE table_schema = 'public'
    """,
    "constraints": """
        SELECT c.conrelid::regclass::text || ' ' || c.contype::text || ' '
               || pg_get_constraintdef(c.oid)
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public'
    """,
    "indexes": "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'",
    "enums": """
        SELECT t.typname || ':' || e.enumlabel
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    """,
    "triggers": """
        SELECT c.relname || '.' || t.tgname
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal
    """,
    "functions": """
        SELECT p.proname
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
    """,
}


def _base_url() -> str:
    """Plain postgresql:// with no driver suffix or query string.

    alembic/env.py rewrites this scheme to its own driver, and asyncpg accepts
    it as-is, so both consumers below can share one form.
    """
    url = get_settings().database_url.split("?")[0]
    return url.replace("postgresql+asyncpg://", "postgresql://", 1)


def _with_database(url: str, name: str) -> str:
    return url.rsplit("/", 1)[0] + "/" + name


async def _catalog(url: str) -> dict[str, set[str]]:
    conn = await asyncpg.connect(url)
    try:
        return {
            key: {row[0] for row in await conn.fetch(query)}
            for key, query in CATALOG_QUERIES.items()
        }
    finally:
        await conn.close()


async def test_fresh_database_upgrade_matches_the_migrated_one():
    base = _base_url()
    scratch_name = f"vls_migration_check_{uuid.uuid4().hex[:12]}"
    admin_url = _with_database(base, "postgres")

    try:
        admin = await asyncpg.connect(admin_url)
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"cannot reach the maintenance database: {exc}")

    try:
        try:
            await admin.execute(f'CREATE DATABASE "{scratch_name}"')
        except asyncpg.InsufficientPrivilegeError:  # pragma: no cover
            pytest.skip("connection is not allowed to create databases")

        try:
            env = dict(os.environ, DATABASE_URL=_with_database(base, scratch_name))
            result = subprocess.run(
                [sys.executable, "-m", "alembic", "upgrade", "head"],
                cwd=REPO_ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=300,
            )
            assert result.returncode == 0, (
                "alembic upgrade head failed on an empty database:\n"
                f"{result.stdout}\n{result.stderr}"
            )

            fresh = await _catalog(_with_database(base, scratch_name))
            migrated = await _catalog(base)

            for key in CATALOG_QUERIES:
                missing = sorted(migrated[key] - fresh[key])
                extra = sorted(fresh[key] - migrated[key])
                assert not missing and not extra, (
                    f"{key} differs between a fresh database and this one.\n"
                    f"  only in the migrated database: {missing[:10]}\n"
                    f"  only in the fresh database:    {extra[:10]}"
                )
        finally:
            # Drop even if the assertions failed, so a bad run leaves nothing
            # behind on a shared server.
            await admin.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = $1 AND pid <> pg_backend_pid()",
                scratch_name,
            )
            await admin.execute(f'DROP DATABASE IF EXISTS "{scratch_name}"')
    finally:
        await admin.close()
