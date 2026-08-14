"""``annual_discount_percent`` is one number, derived, on every surface.

The bug this pins: commit d2f0a2f taught the admin app to compute the annual
saving from the prices it displays, so it began rendering "save up to 21%" —
while ``GET /public/pricing-catalog`` kept serving the stored
``Plan.annual_discount_percent``, and oyechats.com kept advertising 22% for the
same Professional tier. Two numbers under one name, on two properties.

These tests assert the SERVED value from each route rather than the helper in
isolation, because agreement between consumers is the actual requirement — a
correct helper that some route forgets to call reproduces the bug exactly.

Every plan row below is written with a deliberately WRONG stored column (22, or
the legacy default 30). A route that still reads it fails here.
"""

from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import public_pricing_routes, subscription_routes, superadmin_plan_routes
from app.api.auth import get_superadmin
from app.core.pricing import annual_saving_percent
from app.db.models import Plan
from scripts.seed_plans import _PLANS

# Slug → (12 × monthly INR paise, annual INR paise, the percent every surface
# must serve). Taken from the seeded catalogue; Professional is the tier that
# changes — it stored 22 for a 21.674% saving.
_SEEDED_EXPECTATIONS: dict[str, int] = {
    "free": 0,
    "starter": 20,
    "standard": 20,
    "professional": 21,
    "enterprise": 20,
}


@contextmanager
def _ctx(session):
    yield session


def _seed_catalogue(db) -> None:
    """Insert the real seeded matrix, with the stored percent set to a LIE.

    30 is the value the super-admin create route used to default to, so every row
    here is the exact shape of a bespoke tier published without anyone checking
    the number. Nothing served may reflect it.
    """
    for data in _PLANS:
        db.add(
            Plan(
                slug=data["slug"],
                name=data["name"],
                currency="INR",
                is_active=True,
                monthly_price_cents=data["monthly_price_cents"],
                annual_price_cents=data["annual_price_cents"],
                monthly_price_usd_cents=data["monthly_price_usd_cents"],
                annual_price_usd_cents=data["annual_price_usd_cents"],
                annual_discount_percent=30,
                limits=data["limits"],
                features=data["features"],
                marketing=data["marketing"],
                sort_order=data["sort_order"],
            )
        )
    db.commit()


def _plans_client(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(subscription_routes.router)
    return TestClient(app)


def _catalog_client(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(public_pricing_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(public_pricing_routes.router)
    return TestClient(app)


def _superadmin_client(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(superadmin_plan_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_plan_routes.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(id=1, is_superadmin=True)
    return TestClient(app)


def _by_slug(payload: list[dict]) -> dict[str, dict]:
    return {p["slug"]: p for p in payload}


# ── The two customer-facing catalogs ─────────────────────────────────────────


def test_subscriptions_plans_serves_the_derived_percent(db, monkeypatch):
    """The admin app's feed. It derives the same figure client-side, so a
    disagreement here is the "app says 21, server says 22" bug returning."""
    _seed_catalogue(db)
    plans = _by_slug(_plans_client(db, monkeypatch).get("/subscriptions/plans").json())

    for slug, expected in _SEEDED_EXPECTATIONS.items():
        assert plans[slug]["annual_discount_percent"] == expected, f"{slug} served the wrong annual saving"


def test_public_pricing_catalog_serves_the_derived_percent(db, monkeypatch):
    """The marketing site's feed — the surface that was advertising 22%.

    Serving the corrected number in the EXISTING key is what lets oyechats.com
    show 21% with no website deploy at all.
    """
    _seed_catalogue(db)
    plans = _by_slug(_catalog_client(db, monkeypatch).get("/public/pricing-catalog").json()["plans"])

    for slug, expected in _SEEDED_EXPECTATIONS.items():
        assert plans[slug]["annual_discount_percent"] == expected, f"{slug} served the wrong annual saving"


def test_professional_no_longer_advertises_twenty_two_percent(db, monkeypatch):
    """The specific defect, named: ₹28,188 against 12 × ₹2,999 is 21.674%."""
    _seed_catalogue(db)
    app_feed = _by_slug(_plans_client(db, monkeypatch).get("/subscriptions/plans").json())
    site_feed = _by_slug(_catalog_client(db, monkeypatch).get("/public/pricing-catalog").json()["plans"])

    assert app_feed["professional"]["annual_discount_percent"] == 21
    assert site_feed["professional"]["annual_discount_percent"] == 21


def test_both_catalogs_agree_plan_for_plan(db, monkeypatch):
    """Whatever the value is, the two feeds must never differ — that divergence
    IS the bug, independent of which number is right."""
    _seed_catalogue(db)
    app_feed = _by_slug(_plans_client(db, monkeypatch).get("/subscriptions/plans").json())
    site_feed = _by_slug(_catalog_client(db, monkeypatch).get("/public/pricing-catalog").json()["plans"])

    assert app_feed.keys() == site_feed.keys()
    for slug in app_feed:
        assert app_feed[slug]["annual_discount_percent"] == site_feed[slug]["annual_discount_percent"], (
            f"{slug}: the app feed and the marketing feed disagree"
        )


def test_the_response_shape_is_unchanged(db, monkeypatch):
    """The key stays, keeps its name, and stays an int.

    The marketing site consumes this payload and is deployed separately, so a
    rename or a removal would need a coordinated release. Only the value moved.
    """
    _seed_catalogue(db)
    for plan in _plans_client(db, monkeypatch).get("/subscriptions/plans").json():
        assert isinstance(plan["annual_discount_percent"], int)
    for plan in _catalog_client(db, monkeypatch).get("/public/pricing-catalog").json()["plans"]:
        assert isinstance(plan["annual_discount_percent"], int)


# ── The zero cases, matching the frontend exactly ────────────────────────────


def test_the_free_tier_serves_zero_not_the_stored_thirty(db, monkeypatch):
    """No monthly price means no saving to quote. Consumers drop the badge on 0
    rather than render "save 0%" — same rule as billingModel.annualSavingPercent.
    """
    _seed_catalogue(db)
    plans = _by_slug(_plans_client(db, monkeypatch).get("/subscriptions/plans").json())
    assert plans["free"]["annual_discount_percent"] == 0


def test_a_contact_sales_tier_serves_its_real_derived_percent(db, monkeypatch):
    """A bespoke tier is priced on request but still carries real amounts.

    The frontend excludes contact-sales tiers from the "save up to X%" toggle
    (``maxAnnualSavingPercent``) — an AGGREGATION rule, not a per-plan one:
    ``annualSavingPercent`` still returns the tier's own 35%. The server serves
    the same per-plan figure and leaves the aggregation choice to the surface,
    so the key never changes meaning depending on who is reading it.
    """
    db.add(
        Plan(
            slug="enterprise-acme",
            name="Acme",
            currency="INR",
            is_active=True,
            monthly_price_cents=100_000,  # ₹1,000/mo → ₹12,000 a year
            annual_price_cents=780_000,  # ₹7,800 — 35% off
            annual_discount_percent=30,
            features={"contact_sales": True},
            limits={},
            sort_order=99,
        )
    )
    db.commit()
    plans = _by_slug(_plans_client(db, monkeypatch).get("/subscriptions/plans").json())
    assert plans["enterprise-acme"]["annual_discount_percent"] == 35


@pytest.mark.parametrize(
    ("label", "monthly", "annual"),
    [
        ("no annual price at all", 59900, 0),
        ("annual exactly twelve monthly", 59900, 59900 * 12),
        ("annual dearer than monthly", 239900, 3_600_000),
    ],
)
def test_a_plan_with_no_real_saving_serves_zero(db, monkeypatch, label, monthly, annual):
    """Never a negative percent, and never a "save 0%" badge dressed as a deal.

    The dearer-than-monthly row is not hypothetical: commit ba22a0c shipped
    Professional annual at ₹36,000 against ₹2,399/mo, carried by a stored ``-25``.
    """
    db.add(
        Plan(
            slug="edge",
            name="Edge",
            currency="INR",
            is_active=True,
            monthly_price_cents=monthly,
            annual_price_cents=annual,
            annual_discount_percent=30,
            features={},
            limits={},
        )
    )
    db.commit()
    plans = _by_slug(_plans_client(db, monkeypatch).get("/subscriptions/plans").json())
    assert plans["edge"]["annual_discount_percent"] == 0, label


def test_the_helper_floors_and_never_rounds_up():
    """21.674% is 21. Rounding to nearest is what published a discount the plan
    does not give; the client (``billingModel.annualSavingPercent``) floors too."""
    assert annual_saving_percent(299900, 2818800) == 21  # 21.674%
    assert annual_saving_percent(100, 1080) == 10  # exactly 10% stays 10, not 9
    assert annual_saving_percent(None, None) == 0


# ── The super-admin write path, and the default that used to be 30 ───────────


def test_creating_a_plan_no_longer_defaults_to_thirty_percent(db, monkeypatch):
    """A bespoke tier created without the field used to publish "save 30%".

    Nothing verified it and the app ignored it, so the catalogue could advertise
    a discount that did not exist. It is now derived from the prices supplied in
    the same request.
    """
    c = _superadmin_client(db, monkeypatch)
    res = c.post(
        "/superadmin/plans",
        json={"name": "Bespoke", "slug": "bespoke", "monthly_price_cents": 299900, "annual_price_cents": 2818800},
    )
    assert res.status_code == 200, res.text
    plan_id = res.json()["plan_id"]

    listed = next(p for p in c.get("/superadmin/plans").json() if p["id"] == plan_id)
    assert listed["annual_discount_percent"] == 21

    stored = db.get(Plan, plan_id)
    db.refresh(stored)
    assert stored.annual_discount_percent == 21, "the column must be kept in sync, not left at the default"


def test_creating_a_plan_with_no_prices_derives_zero(db, monkeypatch):
    """The minimal create — no prices at all — must not advertise anything."""
    c = _superadmin_client(db, monkeypatch)
    plan_id = c.post("/superadmin/plans", json={"name": "Bare", "slug": "bare"}).json()["plan_id"]
    listed = next(p for p in c.get("/superadmin/plans").json() if p["id"] == plan_id)
    assert listed["annual_discount_percent"] == 0


def test_creating_a_plan_rejects_a_percent_the_prices_do_not_back(db, monkeypatch):
    """A supplied value is validated, not silently dropped — an editor field that
    looks editable but does nothing is a worse failure than the one being fixed.
    """
    c = _superadmin_client(db, monkeypatch)
    res = c.post(
        "/superadmin/plans",
        json={
            "name": "Overstated",
            "slug": "overstated",
            "monthly_price_cents": 299900,
            "annual_price_cents": 2818800,
            "annual_discount_percent": 22,
        },
    )
    assert res.status_code == 422, res.text
    assert "21%" in res.json()["detail"]
    assert db.query(Plan).filter(Plan.slug == "overstated").first() is None


def test_creating_a_plan_accepts_the_percent_the_prices_do_back(db, monkeypatch):
    """Sending the right number is not an error — only disagreement is."""
    c = _superadmin_client(db, monkeypatch)
    res = c.post(
        "/superadmin/plans",
        json={
            "name": "Agrees",
            "slug": "agrees",
            "monthly_price_cents": 299900,
            "annual_price_cents": 2818800,
            "annual_discount_percent": 21,
        },
    )
    assert res.status_code == 200, res.text
    listed = next(p for p in c.get("/superadmin/plans").json() if p["id"] == res.json()["plan_id"])
    assert listed["annual_discount_percent"] == 21


def test_updating_a_plan_self_heals_a_stale_stored_percent(db, monkeypatch):
    """Any save recomputes the column, so a legacy row converges without a
    migration — the seeded Professional 22 becomes 21 on the next edit."""
    plan = Plan(
        slug="legacy",
        name="Legacy",
        currency="INR",
        is_active=True,
        monthly_price_cents=299900,
        annual_price_cents=2818800,
        annual_discount_percent=22,
        features={},
        limits={},
    )
    db.add(plan)
    db.commit()

    c = _superadmin_client(db, monkeypatch)
    res = c.put(f"/superadmin/plans/{plan.id}", json={"description": "unrelated edit"})
    assert res.status_code == 200, res.text

    db.refresh(plan)
    assert plan.annual_discount_percent == 21


def test_updating_the_annual_price_moves_the_advertised_percent(db, monkeypatch):
    """A price edit cannot leave a stale headline behind.

    The gateway mint that a price change triggers is patched out — this asserts
    the discount arithmetic, not the Razorpay round trip.
    """
    plan = Plan(
        slug="repriced",
        name="Repriced",
        currency="INR",
        is_active=True,
        monthly_price_cents=10_000,  # ₹100/mo → ₹1,200 a year
        annual_price_cents=108_000,  # ₹1,080 — 10% off
        annual_discount_percent=10,
        features={},
        limits={},
    )
    db.add(plan)
    db.commit()

    from app.services import razorpay_service

    monkeypatch.setattr(razorpay_service, "create_plan_for_price", lambda **kwargs: "plan_NEW")

    c = _superadmin_client(db, monkeypatch)
    res = c.put(f"/superadmin/plans/{plan.id}", json={"annual_price_cents": 78_000})  # ₹780 — 35% off
    assert res.status_code == 200, res.text

    db.refresh(plan)
    assert plan.annual_discount_percent == 35


def test_updating_a_plan_rejects_a_percent_the_new_prices_do_not_back(db, monkeypatch):
    """Validated against the prices the edit LEAVES BEHIND, not the old ones."""
    plan = Plan(
        slug="editable",
        name="Editable",
        currency="INR",
        is_active=True,
        monthly_price_cents=299900,
        annual_price_cents=2818800,
        annual_discount_percent=21,
        features={},
        limits={},
    )
    db.add(plan)
    db.commit()

    c = _superadmin_client(db, monkeypatch)
    res = c.put(f"/superadmin/plans/{plan.id}", json={"annual_discount_percent": 30})
    assert res.status_code == 422, res.text

    db.refresh(plan)
    assert plan.annual_discount_percent == 21
