"""Idempotent super-admin seed.

Creates (or refreshes) a single super-admin ``Client`` so a freshly-reset local
database has an account that can reach the super-admin console (plan management,
pricing config). It is intentionally separate from any customer account you sign
up through the dashboard to test onboarding.

Idempotent: keyed on email. A re-run updates the existing row's password and
super-admin flag rather than inserting a duplicate (``clients.email`` is unique).

Credentials are read from the environment, falling back to local-dev defaults:

    SUPERADMIN_EMAIL     (default: superadmin@oyechats.com)
    SUPERADMIN_PASSWORD  (default: superadmin123)
    SUPERADMIN_NAME      (default: OyeChats Super Admin)
    SUPERADMIN_API_KEY   (default: superadmin-local-key)

Usage (from platform/api, inside the venv/conda env):

    .venv/bin/python scripts/seed_superadmin.py
"""

from __future__ import annotations

import os
import sys

# Allow running as a top-level script without installing the package.
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select  # noqa: E402

from app.core.security import get_password_hash  # noqa: E402
from app.db.models import Client  # noqa: E402
from app.db.session import get_session  # noqa: E402

DEFAULT_EMAIL = "superadmin@oyechats.com"
DEFAULT_PASSWORD = "superadmin123"
DEFAULT_NAME = "OyeChats Super Admin"
DEFAULT_API_KEY = "superadmin-local-key"


def seed_superadmin() -> None:
    email = os.getenv("SUPERADMIN_EMAIL", DEFAULT_EMAIL).strip().lower()
    password = os.getenv("SUPERADMIN_PASSWORD", DEFAULT_PASSWORD)
    name = os.getenv("SUPERADMIN_NAME", DEFAULT_NAME).strip()
    api_key = os.getenv("SUPERADMIN_API_KEY", DEFAULT_API_KEY).strip()

    with get_session() as session:
        existing = session.scalars(select(Client).where(Client.email == email)).first()

        if existing is not None:
            existing.hashed_password = get_password_hash(password)
            existing.is_superadmin = True
            if not existing.api_key:
                existing.api_key = api_key
            session.commit()
            action = "updated existing"
            api_key = existing.api_key
        else:
            client = Client(
                name=name,
                email=email,
                hashed_password=get_password_hash(password),
                api_key=api_key,
                is_superadmin=True,
                system_prompt="You are the OyeChats platform super administrator.",
            )
            session.add(client)
            session.commit()
            action = "created"

    print(f"Super-admin {action}:")
    print(f"   Email:    {email}")
    print(f"   Password: {password}")
    print(f"   API key:  {api_key}")


if __name__ == "__main__":
    seed_superadmin()
