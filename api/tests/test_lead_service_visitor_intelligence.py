"""build_lead_response — Visitor Intelligence fields (is_valid_email,
email_score, visitor_metadata), gated by include_visitor_intelligence.

Mirrors the existing include_attribution / include_intelligence tests in
spirit: the fields are absent by default and only appear when the caller
opts in (i.e. when the route already confirmed the plan qualifies).
"""

from datetime import UTC, datetime
from types import SimpleNamespace

from app.services.lead_service import build_lead_response


def _session(**overrides):
    base = dict(
        id="sess-1",
        bant_score=0,
        behavioral_score=0,
        dimension_scores=None,
        dimensions_assessed=0,
        bant_last_updated=None,
        bant_need=None,
        bant_budget=None,
        bant_authority=None,
        bant_timeline=None,
        qualification_framework="bant",
        location=None,
        device=None,
        visit_count=1,
        page_url=None,
        referrer=None,
        utm_params=None,
        lead_viewed_at=None,
        created_at=datetime(2026, 4, 1, tzinfo=UTC),
        last_active_at=datetime(2026, 4, 23, tzinfo=UTC),
        visitor_metadata=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _lead_info(**overrides):
    base = dict(
        name="Jane",
        email="jane@acme.com",
        phone=None,
        company="acme.com",
        is_valid_email=None,
        email_score=None,
        company_name=None,
        company_description=None,
        company_logo_url=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


class TestVisitorIntelligenceFieldsDefaultOff:
    def test_fields_absent_when_not_requested(self):
        payload = build_lead_response(_session(), _lead_info(is_valid_email=True, email_score=92))
        assert "is_valid_email" not in payload["contact"]
        assert "email_score" not in payload["contact"]
        assert "visitor_metadata" not in payload

    def test_fields_absent_with_no_lead_info(self):
        payload = build_lead_response(
            _session(visitor_metadata={"company": "Acme"}), None, include_visitor_intelligence=True
        )
        # No lead_info at all — contact stays None, but the session-level
        # visitor_metadata signal is still surfaced (it exists independent
        # of whether the visitor ever submitted a form).
        assert payload["contact"] is None
        assert payload["visitor_metadata"] == {"company": "Acme"}


class TestVisitorIntelligenceFieldsWhenEnabled:
    def test_email_validity_and_score_included(self):
        payload = build_lead_response(
            _session(),
            _lead_info(is_valid_email=True, email_score=87),
            include_visitor_intelligence=True,
        )
        assert payload["contact"]["is_valid_email"] is True
        assert payload["contact"]["email_score"] == 87

    def test_visitor_metadata_included_from_session(self):
        ip_intel = {"company": "Acme Corp", "asn": "AS15169", "is_vpn": False}
        payload = build_lead_response(
            _session(visitor_metadata=ip_intel),
            _lead_info(),
            include_visitor_intelligence=True,
        )
        assert payload["visitor_metadata"] == ip_intel

    def test_visitor_metadata_defaults_to_none_when_unresolved(self):
        payload = build_lead_response(_session(), _lead_info(), include_visitor_intelligence=True)
        assert payload["visitor_metadata"] is None
