"""Allow credentialless provider configs for the managed Replit AI source.

The Replit AI Integrations proxy resolves its base URL and API key from
server-side environment variables at runtime, so provider_configs rows with
routing_policy.credential_source = 'replit_ai' legitimately carry neither an
encrypted secret nor a base_url. Amend the CHECK constraint to permit that
case explicitly; bring-your-own-key providers still require ciphertext,
nonce, and base URL.

Revision ID: 0002_replit_ai_credentialless
Revises: 0001_initial_schema
"""
from __future__ import annotations

from alembic import op

revision = "0002_replit_ai_credentialless"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None

NEW_CHECK = """
    provider_type = 'demo'
    OR (COALESCE(routing_policy->>'credential_source', '') = 'replit_ai')
    OR (secret_ciphertext IS NOT NULL AND secret_nonce IS NOT NULL AND base_url IS NOT NULL)
"""

OLD_CHECK = """
    provider_type = 'demo'
    OR (secret_ciphertext IS NOT NULL AND secret_nonce IS NOT NULL AND base_url IS NOT NULL)
"""


def upgrade() -> None:
    op.execute("ALTER TABLE provider_configs DROP CONSTRAINT provider_configs_check")
    op.execute(f"ALTER TABLE provider_configs ADD CONSTRAINT provider_configs_check CHECK ({NEW_CHECK})")


def downgrade() -> None:
    op.execute("ALTER TABLE provider_configs DROP CONSTRAINT provider_configs_check")
    op.execute(f"ALTER TABLE provider_configs ADD CONSTRAINT provider_configs_check CHECK ({OLD_CHECK})")
