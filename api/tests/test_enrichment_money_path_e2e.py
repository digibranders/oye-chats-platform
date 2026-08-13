"""End-to-end money path for email verification + company intelligence.

Everything else about this feature is unit-tested one gate at a time. What no
test covered is the thing that actually costs money: a real visitor filling the
widget form, against a real Postgres, with a real `CreditLedger` — and then
doing it a SECOND time, because the widget POSTs `/chat/lead-capture` from both
the pre-chat form and the handoff form. One visitor, two POSTs, and the
question the customer's invoice answers is whether that visitor cost 15 credits
or 30.

Only the two paid vendors are faked (Reoon, and the company resolver's crawl).
The route, the session, the lead row, the three gates, and every ledger write
are the production code paths.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import chat_routes
from app.api.auth import get_current_bot
from app.db.models import Bot, Client, CreditLedger, LeadInfo, PricingConfig
from app.services import credit_service
from app.services.company_profile_service import CompanyProfile
from app.services.credit_service import invalidate_pricing_cache

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_SESSION_ID = "sess-money-path"
_EMAIL = "priya@infosys.com"

# A fully-enriched lead is 15 credits, once: 10 for the address, 5 for the
# employer.
_EMAIL_COST = 10
_COMPANY_COST = 5

_REOON_VALID = {
    "is_valid_syntax": True,
    "is_disposable": False,
    "is_safe_to_send": True,
    "overall_score": 92,
}

_PROFILE = CompanyProfile(
    name="Infosys Limited",
    description="A global leader in next-generation digital services.",
    logo_url="https://infosys.com/logo.png",
)


@pytest.fixture
def paid_bot(db):
    """A Professional-plan agent with both toggles on and credits in its ledger."""
    db.add(Client(id=900, email="money@example.com", name="Money", api_key="k-money"))
    db.flush()
    bot = Bot(
        id=900,
        client_id=900,
        bot_key="bot-money",
        name="Money",
        is_active=True,
        email_verification_enabled=True,
        company_lookup_enabled=True,
    )
    db.add(bot)
    # The pool, not a per-bot bucket: `resolve_bot_ledger_bot_id` routes a bot
    # with no bot-scoped subscription to the client pool, so a grant parked
    # under bot_id=900 would be invisible to the very deduction under test.
    db.add(CreditLedger(client_id=900, bot_id=None, delta=1000, reason="manual_adjust", note="e2e"))
    db.commit()
    return bot


def _debits(db, reason: str) -> list[CreditLedger]:
    return (
        db.query(CreditLedger)
        .filter(CreditLedger.client_id == 900, CreditLedger.reason == reason, CreditLedger.delta < 0)
        .all()
    )


class _Ctx:
    """Stand-in for `get_session()` that hands back the test's own session.

    The production code opens several short-lived sessions per enrichment and
    commits each one; the test needs to see those writes, and a real second
    connection to the same test transaction would deadlock on the advisory
    lock `check_and_deduct` takes.
    """

    def __init__(self, session):
        self._session = session

    def __enter__(self):
        return self._session

    def __exit__(self, *_exc):
        return False


@pytest.fixture
def capture(db, paid_bot, monkeypatch):
    """POST a lead capture the way the widget does, with enrichment inline.

    `submit_background` and the ARQ hand-off both run the enrichment on another
    thread or another process. Running them inline is what makes this a single
    assertable transaction — the code under test is unchanged.
    """
    app = FastAPI()
    app.include_router(chat_routes.router)
    app.dependency_overrides[get_current_bot] = lambda: paid_bot
    client = TestClient(app)

    monkeypatch.setattr(chat_routes, "get_session", lambda: _Ctx(db))
    monkeypatch.setattr(credit_service, "get_session", lambda: _Ctx(db), raising=False)
    # Run the queued company resolution inline instead of handing it to ARQ.
    monkeypatch.setattr(
        chat_routes,
        "_queue_lead_company_resolution",
        lambda session_id, domain, bot_id: chat_routes._resolve_lead_company(session_id, domain, bot_id),
    )
    monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)
    monkeypatch.setattr(chat_routes, "is_visitor_intelligence_enabled_for_bot", lambda *_a, **_k: True)

    def _post():
        with patch("app.core.thread_pool.submit_background", lambda fn, *a, **k: fn(*a, **k)):
            return client.post(
                "/chat/lead-capture",
                json={"session_id": _SESSION_ID, "name": "Priya", "email": _EMAIL},
            )

    return _post


class TestOneVisitorOneCharge:
    def test_a_captured_lead_is_verified_identified_and_billed_fifteen(self, db, capture):
        """The happy path, priced: 10 for the address, 5 for the employer."""
        with (
            patch("app.services.reoon_service.verify_email", return_value=_REOON_VALID) as verify,
            patch("app.services.company_profile_service.resolve_company", return_value=_PROFILE) as resolve,
        ):
            assert capture().status_code == 200

        lead = db.query(LeadInfo).filter(LeadInfo.session_id == _SESSION_ID).one()
        assert lead.company == "infosys.com"  # the raw domain is always kept
        assert lead.company_name == "Infosys Limited"
        assert lead.company_description == _PROFILE.description
        assert lead.company_logo_url == _PROFILE.logo_url
        assert lead.is_valid_email is True
        assert lead.email_score == 92

        verify.assert_called_once()
        resolve.assert_called_once()
        assert credit_service.get_balance(db, 900) == 1000 - _EMAIL_COST - _COMPANY_COST

    def test_the_handoff_form_repost_is_free(self, db, capture):
        """Pre-chat form, then "talk to a human" — one lead, not two invoices.

        The email charge is stopped by its per-(session, address) ledger key.
        The company charge never gets that far on a sequential repost: the
        dedup guard sees `company_name` already written and returns before the
        vendor call, so the second POST costs nothing on OUR account either.
        The ledger key behind that guard is exercised separately, in
        `test_two_overlapping_runs_are_charged_once` — the guard is a read,
        and a read cannot stop a race.
        """
        with (
            patch("app.services.reoon_service.verify_email", return_value=_REOON_VALID),
            patch("app.services.company_profile_service.resolve_company", return_value=_PROFILE),
        ):
            capture()
        after_first = credit_service.get_balance(db, 900)

        with (
            patch("app.services.reoon_service.verify_email", return_value=_REOON_VALID),
            patch("app.services.company_profile_service.resolve_company", return_value=_PROFILE) as resolve,
        ):
            assert capture().status_code == 200

        assert credit_service.get_balance(db, 900) == after_first
        assert len(_debits(db, "email_verification")) == 1
        assert len(_debits(db, "company_name")) == 1
        # The dedup guard, not just the ledger: no second crawl on our dime.
        resolve.assert_not_called()

    def test_two_overlapping_runs_are_charged_once(self, db, capture):
        """The race the dedup guard cannot win, and the key that can.

        `_resolve_lead_company` reads `company_name` to decide whether this
        lead was already answered — but between that read and the write, a
        second background run can pass the same read. Re-entering the resolver
        from inside the vendor call reproduces exactly that interleaving.
        What makes the second run free is the shared idempotency key
        `enrich:company_name:{session_id}`, not the guard.
        """
        seen: list[str] = []

        def _reenter(domain: str):
            if not seen:
                seen.append(domain)
                # The overlapping run: past the guard, before the write.
                chat_routes._resolve_lead_company(_SESSION_ID, domain, 900)
            return _PROFILE

        with (
            patch("app.services.reoon_service.verify_email", return_value=_REOON_VALID),
            patch("app.services.company_profile_service.resolve_company", side_effect=_reenter) as resolve,
        ):
            assert capture().status_code == 200

        assert resolve.call_count == 2  # both runs really did reach the vendor
        assert len(_debits(db, "company_name")) == 1
        assert credit_service.get_balance(db, 900) == 1000 - _EMAIL_COST - _COMPANY_COST

    def test_a_second_capture_from_a_different_employer_re_resolves(self, db, capture, paid_bot):
        """The dedup guard must not freeze a stale company onto a moved lead.

        `lead.company` is rewritten on every capture, so a guard keyed only on
        "do we have a name?" would leave `company_name="Infosys Limited"`
        sitting above `company="wipro.com"` — `companyDisplay` renders the
        resolved name over the domain, so the rep would read a confidently
        wrong employer.
        """
        wipro = CompanyProfile(name="Wipro Limited", description=None, logo_url=None)

        with (
            patch("app.services.reoon_service.verify_email", return_value=_REOON_VALID),
            patch("app.services.company_profile_service.resolve_company", return_value=_PROFILE),
        ):
            capture()

        app = FastAPI()
        app.include_router(chat_routes.router)
        app.dependency_overrides[get_current_bot] = lambda: paid_bot
        with (
            patch("app.services.reoon_service.verify_email", return_value=_REOON_VALID),
            patch("app.services.company_profile_service.resolve_company", return_value=wipro) as resolve,
            patch("app.core.thread_pool.submit_background", lambda fn, *a, **k: fn(*a, **k)),
        ):
            TestClient(app).post(
                "/chat/lead-capture",
                json={"session_id": _SESSION_ID, "name": "Priya", "email": "priya@wipro.com"},
            )

        resolve.assert_called_once_with("wipro.com")
        lead = db.query(LeadInfo).filter(LeadInfo.session_id == _SESSION_ID).one()
        assert lead.company == "wipro.com"
        assert lead.company_name == "Wipro Limited"
        # Still one company charge: the ledger key is per SESSION, and this is
        # the same visitor correcting their address, not a second lead.
        assert len(_debits(db, "company_name")) == 1

    def test_an_unidentifiable_company_is_not_charged_for(self, db, capture):
        """Charge on success. A parked domain costs us the crawl, not them."""
        with (
            patch("app.services.reoon_service.verify_email", return_value=_REOON_VALID),
            patch("app.services.company_profile_service.resolve_company", return_value=None),
        ):
            assert capture().status_code == 200

        lead = db.query(LeadInfo).filter(LeadInfo.session_id == _SESSION_ID).one()
        assert lead.company == "infosys.com"  # degrades to the domain, never to nothing
        assert lead.company_name is None
        assert _debits(db, "company_name") == []
        assert credit_service.get_balance(db, 900) == 1000 - _EMAIL_COST


class TestTheCustomersOffSwitch:
    def test_company_lookup_off_still_verifies_the_email(self, db, paid_bot, capture):
        """The two toggles are independent — turning one off keeps the other."""
        paid_bot.company_lookup_enabled = False
        db.commit()

        with (
            patch("app.services.reoon_service.verify_email", return_value=_REOON_VALID) as verify,
            patch("app.services.company_profile_service.resolve_company", return_value=_PROFILE) as resolve,
        ):
            assert capture().status_code == 200

        verify.assert_called_once()
        resolve.assert_not_called()
        assert credit_service.get_balance(db, 900) == 1000 - _EMAIL_COST

    def test_email_verification_off_skips_the_vendor_entirely(self, db, paid_bot, capture):
        """Not "call it and hide the result" — the paid call must not fire."""
        paid_bot.email_verification_enabled = False
        db.commit()

        with (
            patch("app.services.reoon_service.verify_email") as verify,
            patch("app.services.company_profile_service.resolve_company", return_value=_PROFILE),
        ):
            assert capture().status_code == 200

        verify.assert_not_called()
        lead = db.query(LeadInfo).filter(LeadInfo.session_id == _SESSION_ID).one()
        assert lead.is_valid_email is None  # never asked, so not "invalid"
        assert lead.company_name == "Infosys Limited"
        assert credit_service.get_balance(db, 900) == 1000 - _COMPANY_COST

    def test_both_off_costs_nothing_and_still_captures_the_lead(self, db, paid_bot, capture):
        paid_bot.email_verification_enabled = False
        paid_bot.company_lookup_enabled = False
        db.commit()

        with (
            patch("app.services.reoon_service.verify_email") as verify,
            patch("app.services.company_profile_service.resolve_company") as resolve,
        ):
            assert capture().status_code == 200

        verify.assert_not_called()
        resolve.assert_not_called()
        assert credit_service.get_balance(db, 900) == 1000
        # The lead itself is never collateral damage of a cost decision.
        lead = db.query(LeadInfo).filter(LeadInfo.session_id == _SESSION_ID).one()
        assert lead.email == _EMAIL
        assert lead.company == "infosys.com"  # free domain extraction is unmetered


class TestTheSuperAdminKillSwitch:
    @pytest.mark.parametrize("feature", ["email_verification", "company_name"])
    def test_our_own_off_switch_outranks_the_plan_and_the_toggle(self, db, capture, feature):
        """The lever we pull when a vendor is down or burning money.

        Plan says yes and the customer's toggle says yes; the switch still
        wins, and — critically — it stops the VENDOR CALL, not just the
        ledger write. `_charge_for_enrichment` is deliberately unpatched here.
        """
        db.merge(PricingConfig(key=f"feature.{feature}_enabled", value=False))
        db.commit()
        invalidate_pricing_cache()
        try:
            with (
                patch("app.services.reoon_service.verify_email", return_value=_REOON_VALID) as verify,
                patch("app.services.company_profile_service.resolve_company", return_value=_PROFILE) as resolve,
            ):
                assert capture().status_code == 200

            stopped, other = (verify, resolve) if feature == "email_verification" else (resolve, verify)
            stopped.assert_not_called()
            other.assert_called_once()  # the switches are independent
            assert _debits(db, feature) == []
            still_charged = _COMPANY_COST if feature == "email_verification" else _EMAIL_COST
            assert credit_service.get_balance(db, 900) == 1000 - still_charged
        finally:
            # The pricing cache is process-global; a leaked False would turn
            # this feature off for every test that runs after this one.
            db.merge(PricingConfig(key=f"feature.{feature}_enabled", value=True))
            db.commit()
            invalidate_pricing_cache()


class TestFreeMailIsNotAnEmployer:
    def test_a_personal_address_never_reaches_the_company_resolver(self, db, capture, monkeypatch):
        """Free-mail is not an employer. Resolving gmail.com would bill 10
        credits to learn "Google" about someone who works elsewhere."""
        app = FastAPI()
        app.include_router(chat_routes.router)
        app.dependency_overrides[get_current_bot] = lambda: db.get(Bot, 900)

        with (
            patch("app.services.reoon_service.verify_email", return_value=_REOON_VALID),
            patch("app.services.company_profile_service.resolve_company") as resolve,
            patch("app.core.thread_pool.submit_background", lambda fn, *a, **k: fn(*a, **k)),
        ):
            TestClient(app).post(
                "/chat/lead-capture",
                json={"session_id": "sess-personal", "name": "Priya", "email": "priya@yahoo.co.uk"},
            )

        resolve.assert_not_called()
        assert _debits(db, "company_name") == []


class TestTheDedupGuardFailsOpen:
    """The guard is a cost optimisation, not a gate.

    `_already_resolved` on the IP path says it outright: "A failed check must
    never SUPPRESS resolution — fall through and do the work rather than
    silently skipping it." The domain guard has to behave the same way, because
    nothing retries this — the only trigger is another lead-capture POST, so a
    transient DB hiccup would cost the customer the enrichment permanently.
    """

    def test_a_failed_read_resolves_anyway(self, monkeypatch):
        def _boom():
            raise RuntimeError("connection reset")

        monkeypatch.setattr(chat_routes, "get_session", _boom)
        assert chat_routes._company_already_resolved("sess-x", "infosys.com") is False

    def test_a_resolved_lead_on_the_same_domain_is_skipped(self, db, capture):
        with (
            patch("app.services.reoon_service.verify_email", return_value=_REOON_VALID),
            patch("app.services.company_profile_service.resolve_company", return_value=_PROFILE),
        ):
            capture()

        assert chat_routes._company_already_resolved(_SESSION_ID, "infosys.com") is True
        # Same lead, different employer — not answered, so not skipped.
        assert chat_routes._company_already_resolved(_SESSION_ID, "wipro.com") is False


class TestTheQueueDedupesToo:
    """The DB guard is a read, so two concurrent posts both pass it.

    ARQ's own `_job_id` dedup closes the window the guard cannot: one visitor
    filling the pre-chat form and then asking for a human produces two posts,
    and without a deterministic job id both enqueue a ~70s crawl on our vendor
    account for the same domain.
    """

    def test_the_job_id_is_deterministic_per_session_and_domain(self, monkeypatch):
        calls: list[dict] = []
        monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", True)
        monkeypatch.setattr(
            "app.worker.enqueue.enqueue_sync",
            lambda *a, **kw: calls.append({"args": a, "kwargs": kw}),
        )

        chat_routes._queue_lead_company_resolution("sess-1", "infosys.com", 900)
        chat_routes._queue_lead_company_resolution("sess-1", "infosys.com", 900)

        assert len(calls) == 2  # both enqueued; ARQ collapses them, not us
        ids = {c["kwargs"]["_job_id"] for c in calls}
        assert ids == {"resolve-company:sess-1:infosys.com"}

    def test_a_different_domain_is_a_different_job(self, monkeypatch):
        """A visitor correcting their address to another employer must still
        be resolved, not swallowed as a duplicate."""
        calls: list[dict] = []
        monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", True)
        monkeypatch.setattr(
            "app.worker.enqueue.enqueue_sync",
            lambda *a, **kw: calls.append({"args": a, "kwargs": kw}),
        )

        chat_routes._queue_lead_company_resolution("sess-1", "infosys.com", 900)
        chat_routes._queue_lead_company_resolution("sess-1", "wipro.com", 900)

        assert len({c["kwargs"]["_job_id"] for c in calls}) == 2
