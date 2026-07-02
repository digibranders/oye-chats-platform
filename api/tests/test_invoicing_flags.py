"""Invoicing feature flags default OFF so nothing changes until rollout."""

from app import config


def test_invoicing_flags_default_off():
    assert config.INVOICING_V2_ENABLED is False
    assert config.INVOICE_EMAILS_ENABLED is False
