"""Integration tests for pricing-content read/write helpers in plan_service.

Requires a reachable Postgres at DB_URL (skips automatically when absent).
Uses the shared ``db`` fixture from conftest.py (real Session, rolled back
after each test with full table truncation).
"""

from app.services.plan_service import get_pricing_content, set_pricing_content


def test_get_pricing_content_returns_all_keys(db):
    content = get_pricing_content(db)
    assert set(content.keys()) == {"faq", "feature_matrix", "topup_packs", "credit_costs"}
    assert isinstance(content["faq"], list)
    assert isinstance(content["feature_matrix"], list)


def test_set_then_get_pricing_content_round_trip(db):
    set_pricing_content(db, {"faq": [{"q": "Refunds?", "a": "Pro-rated."}]})
    content = get_pricing_content(db)
    assert content["faq"] == [{"q": "Refunds?", "a": "Pro-rated."}]
