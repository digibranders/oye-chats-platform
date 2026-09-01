"""Coupon resolution and redemption.

The table shipped with a superadmin CRUD and no realiser, so checkout refused
every code including the valid ones. These pin the two shapes that are
honourable and the several that are not.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Client, Coupon
from app.services import coupon_service


def _coupon(session, **kwargs) -> Coupon:
    defaults = {
        "code": "TESTCODE",
        "percent_off": 20,
        "is_active": True,
        "redemptions": 0,
    }
    coupon = Coupon(**{**defaults, **kwargs})
    session.add(coupon)
    session.flush()
    return coupon


class TestResolve:
    def test_no_code_is_not_an_error(self, db):
        assert coupon_service.resolve(db, None) is None
        assert coupon_service.resolve(db, "   ") is None

    def test_percentage_resolves_to_basis_points_for_life(self, db):
        _coupon(db, code="SAVE20", percent_off=20)
        grant = coupon_service.resolve(db, "SAVE20")
        assert grant is not None
        assert grant.discount_bps == 2000
        assert grant.free_months == 0
        assert grant.is_free_period is False

    def test_full_discount_with_duration_resolves_to_free_months(self, db):
        _coupon(db, code="FREE3", percent_off=100, duration_months=3)
        grant = coupon_service.resolve(db, "FREE3")
        assert grant is not None
        assert grant.is_free_period is True
        assert grant.free_months == 3
        assert grant.discount_bps == 0

    def test_code_is_matched_case_insensitively(self, db):
        _coupon(db, code="SAVE20", percent_off=20)
        assert coupon_service.resolve(db, "save20") is not None
        assert coupon_service.resolve(db, "  Save20  ") is not None

    def test_free_period_end_counts_whole_months(self, db):
        _coupon(db, code="FREE2", percent_off=100, duration_months=2)
        grant = coupon_service.resolve(db, "FREE2")
        now = datetime(2026, 1, 1, tzinfo=UTC)
        assert grant is not None
        assert grant.free_period_end(now) == now + timedelta(days=60)

    @pytest.mark.parametrize(
        ("kwargs", "fragment"),
        [
            ({"is_active": False}, "no longer active"),
            ({"expires_at": datetime.now(UTC) - timedelta(days=1)}, "expired"),
            ({"max_redemptions": 5, "redemptions": 5}, "fully redeemed"),
            # 100% off with no duration is a free plan, not a coupon.
            ({"percent_off": 100}, "not configured"),
            # A flat amount cannot be expressed as a recurring plan price.
            ({"percent_off": None, "amount_off_cents": 500}, "cannot be applied"),
        ],
    )
    def test_unhonourable_coupons_say_which(self, db, kwargs, fragment):
        _coupon(db, code="NOPE", **kwargs)
        with pytest.raises(coupon_service.CouponError, match=fragment):
            coupon_service.resolve(db, "NOPE")

    def test_unknown_code_is_not_recognised(self, db):
        with pytest.raises(coupon_service.CouponError, match="not recognised"):
            coupon_service.resolve(db, "NOSUCHCODE")

    def test_plan_scope_is_enforced(self, db):
        _coupon(db, code="ONLY1", percent_off=10, applies_to_plan_ids=[1])
        assert coupon_service.resolve(db, "ONLY1", plan_id=1) is not None
        with pytest.raises(coupon_service.CouponError, match="does not apply to this plan"):
            coupon_service.resolve(db, "ONLY1", plan_id=2)

    def test_plan_scope_is_ignored_when_no_plan_is_named(self, db):
        # The preview endpoint may be called before a plan is chosen.
        _coupon(db, code="ONLY1", percent_off=10, applies_to_plan_ids=[1])
        assert coupon_service.resolve(db, "ONLY1") is not None


class TestConsume:
    def test_uncapped_coupon_always_has_a_slot(self, db):
        _coupon(db, code="UNCAPPED", percent_off=10, max_redemptions=None)
        grant = coupon_service.resolve(db, "UNCAPPED")
        assert grant is not None
        assert coupon_service.consume(db, grant) is True

    def test_the_cap_cannot_be_oversold(self, db):
        coupon = _coupon(db, code="LASTONE", percent_off=10, max_redemptions=1)
        grant = coupon_service.resolve(db, "LASTONE")
        assert grant is not None
        assert coupon_service.consume(db, grant) is True
        # The second claim loses the guarded UPDATE rather than overselling.
        assert coupon_service.consume(db, grant) is False
        db.refresh(coupon)
        assert coupon.redemptions == 1

    def test_a_deactivated_coupon_cannot_be_consumed(self, db):
        coupon = _coupon(db, code="PAUSED", percent_off=10)
        grant = coupon_service.resolve(db, "PAUSED")
        assert grant is not None
        coupon.is_active = False
        db.flush()
        assert coupon_service.consume(db, grant) is False


class TestStandingAttribution:
    def _client(self, session) -> Client:
        client = Client(
            name="Buyer",
            email=f"buyer{datetime.now(UTC).timestamp()}@example.com",
            hashed_password="x",
            api_key=f"k{datetime.now(UTC).timestamp()}",
        )
        session.add(client)
        session.flush()
        return client

    def test_attach_records_the_coupon(self, db):
        _coupon(db, code="SAVE20", percent_off=20)
        grant = coupon_service.resolve(db, "SAVE20")
        client = self._client(db)
        assert grant is not None
        coupon_service.attach(db, client.id, grant)
        db.flush()
        assert client.coupon_id == grant.coupon_id
        assert client.coupon_attributed_at is not None

    def test_attach_is_first_touch(self, db):
        first = _coupon(db, code="FIRST", percent_off=20)
        _coupon(db, code="SECOND", percent_off=40)
        client = self._client(db)
        coupon_service.attach(db, client.id, coupon_service.resolve(db, "FIRST"))
        coupon_service.attach(db, client.id, coupon_service.resolve(db, "SECOND"))
        db.flush()
        assert client.coupon_id == first.id

    def test_a_recurring_discount_survives_for_a_later_plan_change(self, db):
        # The amount lives in the minted Razorpay plan, so a plan change that
        # could not see this would re-mint at full price.
        _coupon(db, code="SAVE20", percent_off=20)
        client = self._client(db)
        coupon_service.attach(db, client.id, coupon_service.resolve(db, "SAVE20"))
        db.flush()
        bps, meta = coupon_service.standing_discount_bps(db, client)
        assert bps == 2000
        assert meta is not None and meta["coupon_code"] == "SAVE20"

    def test_a_free_period_does_not_recur(self, db):
        # Spent once, at checkout, as a deferred start date. Re-applying it on a
        # plan change would hand out the free window a second time.
        _coupon(db, code="FREE3", percent_off=100, duration_months=3)
        client = self._client(db)
        coupon_service.attach(db, client.id, coupon_service.resolve(db, "FREE3"))
        db.flush()
        assert coupon_service.standing_discount_bps(db, client) == (0, None)

    def test_no_coupon_is_no_discount(self, db):
        client = self._client(db)
        assert coupon_service.standing_discount_bps(db, client) == (0, None)
