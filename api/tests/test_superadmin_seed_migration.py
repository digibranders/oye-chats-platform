"""Guard the CRED remediation of the superadmin seed migration.

The migration ``b2c3d4e5f6a7_seed_superadmin_user`` must NOT ship a usable
hardcoded production credential. Its password hash is sourced from the
``SUPERADMIN_INITIAL_PASSWORD_HASH`` env var; behavior when unset depends on
``APP_ENV``. These tests exercise the pure env-resolution logic directly (no
DB round-trip needed to validate the security-relevant branches) and assert the
old ``Admin@123`` hash literal is gone from the file.
"""

import importlib.util
from pathlib import Path

import pytest

_MIGRATION_PATH = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "b2c3d4e5f6a7_seed_superadmin_user.py"

# The literal bcrypt hash of "Admin@123" that used to be committed here.
_OLD_HARDCODED_HASH = "$2b$12$arSHkE23D22wflXN6MuFVuwQuP1oYGBTkRNHyC6cpjoFiiAqcXpxm"


def _load_migration():
    spec = importlib.util.spec_from_file_location("_seed_superadmin_migration", _MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_no_hardcoded_password_hash_in_file():
    """The old known-password hash must be gone from source."""
    source = _MIGRATION_PATH.read_text(encoding="utf-8")
    assert _OLD_HARDCODED_HASH not in source
    assert "Admin@123" not in source.split('"""', 3)[-1], (
        "Admin@123 must not appear in migration code (docstring mention is fine)"
    )


def test_resolves_env_hash_when_set(monkeypatch):
    monkeypatch.setenv("SUPERADMIN_INITIAL_PASSWORD_HASH", "$2b$12$fromenvfromenvfromenvfromenvfromenvfromenvfrom")
    monkeypatch.setenv("APP_ENV", "production")
    module = _load_migration()
    assert module._resolve_seed_hash() == "$2b$12$fromenvfromenvfromenvfromenvfromenvfromenvfrom"


def test_skips_when_unset_in_non_production(monkeypatch):
    monkeypatch.delenv("SUPERADMIN_INITIAL_PASSWORD_HASH", raising=False)
    monkeypatch.setenv("APP_ENV", "development")
    module = _load_migration()
    assert module._resolve_seed_hash() is None


def test_raises_when_unset_in_production(monkeypatch):
    monkeypatch.delenv("SUPERADMIN_INITIAL_PASSWORD_HASH", raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    module = _load_migration()
    with pytest.raises(RuntimeError, match="SUPERADMIN_INITIAL_PASSWORD_HASH"):
        module._resolve_seed_hash()


def test_blank_env_hash_is_treated_as_unset(monkeypatch):
    monkeypatch.setenv("SUPERADMIN_INITIAL_PASSWORD_HASH", "   ")
    monkeypatch.setenv("APP_ENV", "development")
    module = _load_migration()
    assert module._resolve_seed_hash() is None
