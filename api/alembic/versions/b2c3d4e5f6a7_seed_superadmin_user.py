"""Seed superadmin user for the Super Admin Dashboard.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-04-13

Security note (CRED remediation, 2026-07-03):
    This migration previously hardcoded a bcrypt hash of the literal password
    ``Admin@123`` for ``admin@oyechats.com`` — a known-password superadmin
    backdoor committed to git history. The password hash is now sourced from
    the ``SUPERADMIN_INITIAL_PASSWORD_HASH`` env var so fresh installs never
    seed a known default:

    * env hash set        -> seed with it (idempotent ``ON CONFLICT``).
    * unset + non-prod    -> SKIP the seed (logged). Tests/CI do not depend on
                             this seeded user (all test superadmins are built
                             as fixtures/SimpleNamespace), so skipping is safe
                             and avoids re-introducing any known default.
    * unset + production  -> RAISE: a fresh prod install must supply the hash.

    Editing an already-applied migration is acceptable here because the change
    only affects FRESH databases — existing databases have already recorded
    this revision and will not re-run ``upgrade()``. The prod superadmin that
    was seeded from the old hardcoded hash cannot be fixed by editing this file
    (git history retains the hash); rotating that password is a separate OPS
    step, out of scope for this code change.
"""

import logging
import os
import uuid

from sqlalchemy import text

from alembic import op

# revision identifiers, used by Alembic.
revision = "b2c3d4e5f6a7"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None

logger = logging.getLogger("alembic.runtime.migration")

_ENV_HASH_VAR = "SUPERADMIN_INITIAL_PASSWORD_HASH"
_ENV_EMAIL_VAR = "SUPERADMIN_INITIAL_EMAIL"
_DEFAULT_EMAIL = "admin@oyechats.com"
_SUPERADMIN_NAME = "OyeChats Admin"


def _resolve_seed_hash() -> str | None:
    """Return the bcrypt hash to seed the superadmin with, or ``None`` to skip.

    * If ``SUPERADMIN_INITIAL_PASSWORD_HASH`` is set, use it verbatim.
    * If unset and ``APP_ENV == "production"``, raise — a fresh prod install
      must supply the hash rather than fall back to any known default.
    * If unset and not production, return ``None`` so the caller skips the
      seed (CI/tests run migrations with no such env set and do not rely on
      the seeded superadmin existing).
    """
    env_hash = os.getenv(_ENV_HASH_VAR, "").strip()
    if env_hash:
        return env_hash

    if os.getenv("APP_ENV", "development") == "production":
        raise RuntimeError(
            f"{_ENV_HASH_VAR} is not set. A fresh production install must supply a "
            "bcrypt password hash for the initial superadmin (no known-password "
            f"default is permitted). Set {_ENV_HASH_VAR} (and optionally "
            f"{_ENV_EMAIL_VAR}) before running migrations."
        )

    return None


def upgrade() -> None:
    seed_hash = _resolve_seed_hash()
    if seed_hash is None:
        logger.info(
            "%s unset and APP_ENV != production; skipping superadmin seed. Set %s to seed an initial superadmin.",
            _ENV_HASH_VAR,
            _ENV_HASH_VAR,
        )
        return

    email = os.getenv(_ENV_EMAIL_VAR, "").strip() or _DEFAULT_EMAIL
    api_key = uuid.uuid4().hex

    # Insert superadmin only if one doesn't already exist with this email.
    # ON CONFLICT: if the email already exists, just promote to superadmin.
    # Parameter binding avoids SQL injection from env-sourced values.
    op.get_bind().execute(
        _insert_statement(),
        {
            "name": _SUPERADMIN_NAME,
            "email": email,
            "hashed_password": seed_hash,
            "api_key": api_key,
        },
    )


def downgrade() -> None:
    # Don't delete the user — just remove the superadmin flag. Email is
    # env-configurable on upgrade, so downgrade the same configured email.
    email = os.getenv(_ENV_EMAIL_VAR, "").strip() or _DEFAULT_EMAIL
    op.get_bind().execute(
        _downgrade_statement(),
        {"email": email},
    )


def _insert_statement():
    return text(
        """
        INSERT INTO clients (name, email, hashed_password, api_key, is_superadmin, max_bots)
        VALUES (:name, :email, :hashed_password, :api_key, true, 100)
        ON CONFLICT (email) DO UPDATE SET is_superadmin = true
        """
    )


def _downgrade_statement():
    return text("UPDATE clients SET is_superadmin = false WHERE email = :email")
