"""Seed superadmin user for the Super Admin Dashboard.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-04-13
"""

import uuid

from alembic import op

# revision identifiers, used by Alembic.
revision = "b2c3d4e5f6a7"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None

# Pre-generated bcrypt hash for 'Admin@123'
_SUPERADMIN_PASSWORD_HASH = "$2b$12$arSHkE23D22wflXN6MuFVuwQuP1oYGBTkRNHyC6cpjoFiiAqcXpxm"
_SUPERADMIN_EMAIL = "admin@oyechats.com"
_SUPERADMIN_NAME = "OyeChats Admin"
_SUPERADMIN_API_KEY = uuid.uuid4().hex


def upgrade() -> None:
    # Insert superadmin only if one doesn't already exist with this email.
    # ON CONFLICT: if the email already exists, just promote to superadmin.
    op.execute(
        f"""
        INSERT INTO clients (name, email, hashed_password, api_key, is_superadmin, max_bots)
        VALUES (
            '{_SUPERADMIN_NAME}',
            '{_SUPERADMIN_EMAIL}',
            '{_SUPERADMIN_PASSWORD_HASH}',
            '{_SUPERADMIN_API_KEY}',
            true,
            100
        )
        ON CONFLICT (email) DO UPDATE SET is_superadmin = true
        """
    )


def downgrade() -> None:
    # Don't delete the user — just remove superadmin flag
    op.execute(f"UPDATE clients SET is_superadmin = false WHERE email = '{_SUPERADMIN_EMAIL}'")
