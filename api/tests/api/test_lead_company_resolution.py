"""Phase B: the email domain → company resolver, wired into lead capture.

The resolution engine (`company_profile_service`, `company_markup`,
`domain_normalizer`, the cross-tenant `company_profile` cache) shipped in
Phase A with 869 lines of tests and three review rounds — and nothing called
it. `grep resolve_company app/` returned only its own file. These tests cover
the wiring: the gates, the metering, and what actually lands on the lead.

The load-bearing decision here is that this SHARES the IP path's idempotency
key. To a customer, "who is this visitor's company?" is one feature with two
signal sources; a session must not be billed twice for the same answer
arriving by a second route.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest

from app.api.chat_routes import _resolve_lead_company
from app.db.models import Bot, ChatSession, Client, LeadInfo
from app.services.company_profile_service import ResolvedCompany

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

RESOLVED = ResolvedCompany(
    domain="infosys.com",
    name="Infosys Limited",
    description="Infosys is an IT services company.",
    logo_url="https://infosys.com/logo.png",
    source="markup",
)


class _Ctx:
    def __init__(self, db):
        self.db = db

    def __enter__(self):
        return self.db

    def __exit__(self, *args):
        return False


def _lead(db, bot_id: int, session_id: str) -> LeadInfo:
    db.add(Client(id=bot_id, email=f"c{bot_id}@x.com", name="C", api_key=f"k{bot_id}"))
    db.flush()
    db.add(Bot(id=bot_id, client_id=bot_id, bot_key=f"bot-pb{bot_id}", name="B", is_active=True))
    db.commit()
    db.add(ChatSession(id=session_id, bot_id=bot_id, status="bot"))
    db.commit()
    lead = LeadInfo(session_id=session_id, bot_id=bot_id, email="priya@infosys.com", company="infosys.com")
    db.add(lead)
    db.commit()
    return lead


@contextmanager
def _gates_open(db, *, resolved=RESOLVED, charge_ok=True):
    """All three gates open and the charge accepted. Yields (resolver, charge)
    so a test can assert on either."""
    from app.services import credit_service

    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch.object(credit_service, "is_feature_enabled", return_value=True),
        patch("app.api.chat_routes._agent_enrichment_opt_in", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=charge_ok) as charge,
        patch("app.services.company_profile_service.resolve_company", return_value=resolved) as resolver,
        patch("app.api.chat_routes.get_session", return_value=_Ctx(db)),
    ):
        yield resolver, charge


def test_a_resolved_company_lands_on_the_lead(db):
    _lead(db, 70, "s-pb70")
    with _gates_open(db):
        _resolve_lead_company("s-pb70", "infosys.com", 70)

    db.expire_all()
    lead = db.query(LeadInfo).filter(LeadInfo.session_id == "s-pb70").first()
    assert lead.company_name == "Infosys Limited"
    assert lead.company_description == "Infosys is an IT services company."
    assert lead.company_logo_url == "https://infosys.com/logo.png"


def test_the_raw_domain_is_never_overwritten(db):
    """`company` is free and always available. A resolution failure must
    degrade to "infosys.com", not to nothing — and existing consumers (leads
    list, CSV export, webhooks) read that column."""
    _lead(db, 71, "s-pb71")
    with _gates_open(db):
        _resolve_lead_company("s-pb71", "infosys.com", 71)

    db.expire_all()
    assert db.query(LeadInfo).filter(LeadInfo.session_id == "s-pb71").first().company == "infosys.com"


def test_an_unresolvable_domain_charges_nothing_and_leaves_the_lead_alone(db):
    _lead(db, 72, "s-pb72")
    from app.services import credit_service

    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch.object(credit_service, "is_feature_enabled", return_value=True),
        patch("app.api.chat_routes._agent_enrichment_opt_in", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=True) as charge,
        patch("app.services.company_profile_service.resolve_company", return_value=None),
        patch("app.api.chat_routes.get_session", return_value=_Ctx(db)),
    ):
        _resolve_lead_company("s-pb72", "parked.com", 72)

    assert charge.call_count == 0, "charged for a company we could not identify"
    db.expire_all()
    assert db.query(LeadInfo).filter(LeadInfo.session_id == "s-pb72").first().company_name is None


def test_it_shares_the_ip_paths_idempotency_key(db):
    """The double-charge guard. Both signal sources answer the same customer
    question, so a session where the IP already identified an employer must
    not be billed again when the email domain finds the same thing."""
    _lead(db, 73, "s-pb73")
    from app.services import credit_service

    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch.object(credit_service, "is_feature_enabled", return_value=True),
        patch("app.api.chat_routes._agent_enrichment_opt_in", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=True) as charge,
        patch("app.services.company_profile_service.resolve_company", return_value=RESOLVED),
        patch("app.api.chat_routes.get_session", return_value=_Ctx(db)),
    ):
        _resolve_lead_company("s-pb73", "infosys.com", 73)

    assert charge.call_args.kwargs["idempotency_key"] == "enrich:company_name:s-pb73", (
        "must reuse the IP path's key, or one session pays twice for one answer"
    )


def test_an_unpaid_resolution_is_withheld(db):
    """Out of credits: the answer is not given away, and the domain remains."""
    _lead(db, 74, "s-pb74")
    from app.services import credit_service

    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch.object(credit_service, "is_feature_enabled", return_value=True),
        patch("app.api.chat_routes._agent_enrichment_opt_in", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=False),
        patch("app.services.company_profile_service.resolve_company", return_value=RESOLVED),
        patch("app.api.chat_routes.get_session", return_value=_Ctx(db)),
    ):
        _resolve_lead_company("s-pb74", "infosys.com", 74)

    db.expire_all()
    lead = db.query(LeadInfo).filter(LeadInfo.session_id == "s-pb74").first()
    assert lead.company_name is None
    assert lead.company == "infosys.com"


@pytest.mark.parametrize(
    ("gate", "value"),
    [
        ("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", False),
        ("app.api.chat_routes._agent_enrichment_opt_in", False),
    ],
)
def test_each_gate_stops_the_crawl_entirely(db, gate, value):
    """Off must mean no crawl, not merely no charge — otherwise a disabled
    feature still spends OyeChats' own Spider/Jina quota per lead."""
    _lead(db, 75 if "visitor" in gate else 76, "s-pb-gate" + gate[-6:])
    from app.services import credit_service

    bot_id = 75 if "visitor" in gate else 76
    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch.object(credit_service, "is_feature_enabled", return_value=True),
        patch("app.api.chat_routes._agent_enrichment_opt_in", return_value=True),
        patch(gate, return_value=value),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=True) as charge,
        patch("app.services.company_profile_service.resolve_company", return_value=RESOLVED) as resolver,
        patch("app.api.chat_routes.get_session", return_value=_Ctx(db)),
    ):
        _resolve_lead_company("s-pb-gate" + gate[-6:], "infosys.com", bot_id)

    assert resolver.call_count == 0, "a disabled feature still paid for a crawl"
    assert charge.call_count == 0


@pytest.mark.parametrize(("domain", "bot_id"), [(None, 77), ("", 77), ("infosys.com", None)])
def test_a_missing_domain_or_bot_is_a_no_op(db, domain, bot_id):
    """Free-mail addresses yield no registrable company domain.

    Written with ALL THREE GATES OPEN. The first version left them unpatched,
    so the real gates denied the call and `resolver.call_count == 0` held
    whether or not the guard existed — a review showed deleting the guard it
    names left the test green. It asserted nothing.
    """
    with _gates_open(db) as (resolver, charge):
        _resolve_lead_company("s-none", domain, bot_id)

    assert resolver.call_count == 0
    assert charge.call_count == 0


def test_a_crash_never_escapes(db):
    """This runs behind lead capture, which has already committed."""
    from app.services import credit_service

    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch.object(credit_service, "is_feature_enabled", return_value=True),
        patch("app.api.chat_routes._agent_enrichment_opt_in", return_value=True),
        patch("app.services.company_profile_service.resolve_company", side_effect=RuntimeError("boom")),
        patch("app.api.chat_routes.get_session", return_value=_Ctx(db)),
    ):
        _resolve_lead_company("s-boom", "infosys.com", 78)  # must not raise


class TestTheWiringItself:
    """The call site, not just the callee.

    Every test above invokes `_resolve_lead_company` directly, so DELETING the
    call to it from `_enrich_lead_in_background` left all 3715 tests green — a
    review proved it. That is exactly the defect this whole commit exists to
    fix: Phase A shipped a resolver with no caller. Shipping the caller with
    no test on the call site is the same defect one level up.
    """

    def test_lead_enrichment_invokes_the_company_resolver(self, db):
        from app.api import chat_routes

        # `_enrich_lead_in_background` returns early when the LeadInfo row is
        # absent, so a wiring test without one passes for the wrong reason.
        _lead(db, 90, "s-wire")

        with (
            patch.object(chat_routes, "_resolve_lead_company") as resolve,
            patch("app.services.email_domain_service.extract_company_domain", return_value="infosys.com"),
            patch("app.api.chat_routes.is_email_validation_enabled_for_bot", return_value=False),
            patch("app.api.chat_routes.get_session", return_value=_Ctx(db)),
        ):
            chat_routes._enrich_lead_in_background("s-wire", "priya@infosys.com", bot_id=90)

        resolve.assert_called_once_with("s-wire", "infosys.com", 90)

    def test_it_runs_after_the_email_verdict_is_committed(self, db):
        """Ordering is the reason it is a tail call rather than earlier: the
        email verdict is the more actionable signal and must not wait behind a
        crawl that can take tens of seconds."""
        from app.api import chat_routes

        _lead(db, 91, "s-order")
        order: list[str] = []

        class _Recording(_Ctx):
            def __exit__(self, *args):
                order.append("commit")
                return False

        with (
            patch.object(chat_routes, "_resolve_lead_company", side_effect=lambda *_: order.append("resolve")),
            patch("app.services.email_domain_service.extract_company_domain", return_value="infosys.com"),
            patch("app.api.chat_routes.is_email_validation_enabled_for_bot", return_value=False),
            patch("app.api.chat_routes.get_session", return_value=_Recording(db)),
        ):
            chat_routes._enrich_lead_in_background("s-order", "priya@infosys.com", bot_id=91)

        assert order[-1] == "resolve", f"the resolver did not run last: {order}"


def test_the_super_admin_kill_switch_stops_the_crawl(db):
    """The THIRD gate, which `test_each_gate_stops_the_crawl_entirely` omitted.

    Removing `feature_on` from the pre-crawl condition left the whole suite
    green. Nothing is billed either way — `_charge_for_enrichment` re-checks
    it — but the lever's entire purpose is to stop the SPEND during a vendor
    outage or a cost spike, and the crawl is the spend.
    """
    from app.services import credit_service

    _lead(db, 79, "s-killswitch")
    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch.object(credit_service, "is_feature_enabled", return_value=False),
        patch("app.api.chat_routes._agent_enrichment_opt_in", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=True) as charge,
        patch("app.services.company_profile_service.resolve_company", return_value=RESOLVED) as resolver,
        patch("app.api.chat_routes.get_session", return_value=_Ctx(db)),
    ):
        _resolve_lead_company("s-killswitch", "infosys.com", 79)

    assert resolver.call_count == 0, "the kill switch is pulled but the crawl still ran"
    assert charge.call_count == 0
