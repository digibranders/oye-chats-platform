"""Integration tests for app.services.affiliate_service — real Postgres.

These tests run against a throwaway database (``<dbname>_afftest``) created
from the server pointed at by ``DB_URL``. A real database is required (not
mocks) because the behaviors under test live at the DB layer:

* the atomic first-touch attribution ``UPDATE ... WHERE referral_code_id
  IS NULL`` (plan §6),
* ``CITEXT`` case-insensitive uniqueness on ``referral_codes.code``,
* the format/range CHECK constraints.

In CI the pgvector service container provides the server; locally the dev
Postgres does. The whole module is skipped when no server is reachable.
"""

import os
from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa
from sqlalchemy import create_engine, make_url, select
from sqlalchemy.orm import Session

from app.db.models import Affiliate, AffiliateInvite, Base, Client, ReferralClick, ReferralCode
from app.services import affiliate_service as svc

# ── Throwaway-database fixtures ──────────────────────────────────────────────

_TEST_DB_SUFFIX = "_afftest"


def _server_url():
    raw = os.getenv("DB_URL")
    if not raw:
        return None
    return make_url(raw)


def _server_reachable(url) -> bool:
    try:
        engine = create_engine(url, connect_args={"connect_timeout": 2})
        with engine.connect():
            pass
        engine.dispose()
        return True
    except Exception:
        return False


_BASE_URL = _server_url()

pytestmark = pytest.mark.skipif(
    _BASE_URL is None or not _server_reachable(_BASE_URL),
    reason="affiliate integration tests need a reachable Postgres at DB_URL",
)


@pytest.fixture(scope="module")
def pg_engine():
    """Create a dedicated test database, build the schema, drop it afterwards."""
    test_db = f"{_BASE_URL.database}{_TEST_DB_SUFFIX}"

    admin = create_engine(_BASE_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{test_db}"'))
        conn.execute(sa.text(f'CREATE DATABASE "{test_db}"'))

    engine = create_engine(_BASE_URL.set(database=test_db))
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE EXTENSION IF NOT EXISTS citext"))
        conn.execute(sa.text("CREATE EXTENSION IF NOT EXISTS vector"))
    Base.metadata.create_all(engine)

    yield engine

    engine.dispose()
    with admin.connect() as conn:
        conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{test_db}" WITH (FORCE)'))
    admin.dispose()


@pytest.fixture()
def db(pg_engine):
    """A clean session per test. Affiliate-adjacent tables are emptied up front."""
    session = Session(pg_engine)
    # Delete in FK order. clients.referral_code_id is ON DELETE SET NULL, so
    # codes can go before clients.
    for table in (ReferralClick, ReferralCode, Affiliate, AffiliateInvite, Client):
        session.execute(sa.delete(table))
    session.commit()
    yield session
    session.rollback()
    session.close()


# ── Row factories ────────────────────────────────────────────────────────────

_seq = iter(range(1, 10_000))


def make_client(db: Session, email: str | None = None) -> Client:
    n = next(_seq)
    client = Client(
        name=f"Test Client {n}",
        email=email or f"client{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"test-api-key-{n}",
    )
    db.add(client)
    db.commit()
    return client


def make_affiliate(
    db: Session,
    client: Client | None = None,
    *,
    max_active_codes: int = 10,
    commission_bps: int = 0,
    deactivated: bool = False,
) -> Affiliate:
    client = client or make_client(db)
    affiliate = Affiliate(
        client_id=client.id,
        max_active_codes=max_active_codes,
        commission_bps=commission_bps,
        deactivated_at=datetime.now(UTC) if deactivated else None,
    )
    db.add(affiliate)
    db.commit()
    return affiliate


def make_code(db: Session, affiliate: Affiliate, code: str, *, active: bool = True) -> ReferralCode:
    row = ReferralCode(affiliate_id=affiliate.id, code=code, active=active)
    db.add(row)
    db.commit()
    return row


# ── validate_code ────────────────────────────────────────────────────────────


class TestValidateCode:
    def test_active_code_found(self, db):
        affiliate = make_affiliate(db)
        make_code(db, affiliate, "SAVE20")
        row = svc.validate_code(db, "SAVE20")
        assert row is not None
        assert row.affiliate_id == affiliate.id

    def test_lookup_is_case_insensitive(self, db):
        make_code(db, make_affiliate(db), "SAVE20")
        assert svc.validate_code(db, "save20") is not None
        assert svc.validate_code(db, "SaVe20") is not None

    def test_inactive_code_not_found(self, db):
        make_code(db, make_affiliate(db), "SAVE20", active=False)
        assert svc.validate_code(db, "SAVE20") is None

    def test_unknown_code_not_found(self, db):
        assert svc.validate_code(db, "NOPE99") is None

    def test_empty_code_not_found(self, db):
        assert svc.validate_code(db, "") is None


# ── record_click ─────────────────────────────────────────────────────────────


class TestRecordClick:
    def test_click_written_with_hashed_ip_and_ua(self, db):
        code = make_code(db, make_affiliate(db), "SAVE20")
        ok = svc.record_click(db, "SAVE20", ip="203.0.113.7", user_agent="Mozilla/5.0", referrer="https://x.com")
        db.commit()
        assert ok is True

        click = db.execute(select(ReferralClick)).scalar_one()
        assert click.code_id == code.id
        # sha256 hex digests — raw values must never land in the table.
        assert len(click.ip_hash) == 64 and "203.0.113.7" not in click.ip_hash
        assert len(click.ua_hash) == 64 and "Mozilla" not in click.ua_hash
        assert click.referrer == "https://x.com"

    def test_referrer_trimmed_to_500_chars(self, db):
        make_code(db, make_affiliate(db), "SAVE20")
        svc.record_click(db, "SAVE20", ip=None, user_agent=None, referrer="r" * 900)
        db.commit()
        click = db.execute(select(ReferralClick)).scalar_one()
        assert len(click.referrer) == 500
        assert click.ip_hash is None
        assert click.ua_hash is None

    def test_invalid_code_writes_nothing(self, db):
        assert svc.record_click(db, "NOPE99", ip="1.2.3.4", user_agent="UA", referrer=None) is False
        db.commit()
        assert db.scalar(select(sa.func.count(ReferralClick.id))) == 0

    def test_inactive_code_writes_nothing(self, db):
        make_code(db, make_affiliate(db), "SAVE20", active=False)
        assert svc.record_click(db, "SAVE20", ip="1.2.3.4", user_agent="UA", referrer=None) is False


# ── attribute_signup (plan §6 — the race-sensitive path) ─────────────────────


class TestAttributeSignup:
    def test_happy_path_sets_both_columns(self, db):
        code = make_code(db, make_affiliate(db), "SAVE20")
        prospect = make_client(db)

        assert svc.attribute_signup(db, prospect.id, "SAVE20") is True
        db.commit()
        db.refresh(prospect)
        assert prospect.referral_code_id == code.id
        assert prospect.referral_attributed_at is not None

    def test_first_touch_wins_second_attribution_is_noop(self, db):
        first = make_code(db, make_affiliate(db), "FIRST1")
        make_code(db, make_affiliate(db), "SECOND1")
        prospect = make_client(db)

        assert svc.attribute_signup(db, prospect.id, "FIRST1") is True
        db.commit()
        # Second attempt with a different (valid!) code must lose the
        # WHERE referral_code_id IS NULL condition → 0 rows → False.
        assert svc.attribute_signup(db, prospect.id, "SECOND1") is False
        db.commit()
        db.refresh(prospect)
        assert prospect.referral_code_id == first.id

    def test_invalid_code_is_silent_noop(self, db):
        prospect = make_client(db)
        assert svc.attribute_signup(db, prospect.id, "NOPE99") is False
        db.refresh(prospect)
        assert prospect.referral_code_id is None

    def test_inactive_code_is_silent_noop(self, db):
        make_code(db, make_affiliate(db), "SAVE20", active=False)
        prospect = make_client(db)
        assert svc.attribute_signup(db, prospect.id, "SAVE20") is False

    def test_self_referral_blocked(self, db):
        owner = make_client(db)
        affiliate = make_affiliate(db, owner)
        make_code(db, affiliate, "MYCODE1")

        assert svc.attribute_signup(db, owner.id, "MYCODE1") is False
        db.refresh(owner)
        assert owner.referral_code_id is None

    def test_empty_code_is_noop(self, db):
        prospect = make_client(db)
        assert svc.attribute_signup(db, prospect.id, None) is False
        assert svc.attribute_signup(db, prospect.id, "") is False


# ── create_code ──────────────────────────────────────────────────────────────


class TestCreateCode:
    def test_happy_path(self, db):
        affiliate = make_affiliate(db)
        row = svc.create_code(db, affiliate, "SAVE20", label="  Twitter launch  ")
        db.commit()
        assert row.id is not None
        assert row.active is True
        assert row.label == "Twitter launch"

    @pytest.mark.parametrize("bad", ["AB", "x" * 21, "BAD CODE", "naïve", "semi;colon", ""])
    def test_format_violations_rejected(self, db, bad):
        affiliate = make_affiliate(db)
        with pytest.raises(svc.InvalidCodeFormat):
            svc.create_code(db, affiliate, bad)

    def test_duplicate_rejected_case_insensitively(self, db):
        affiliate = make_affiliate(db)
        svc.create_code(db, affiliate, "SAVE20")
        db.commit()
        other = make_affiliate(db)
        with pytest.raises(svc.CodeAlreadyExists):
            svc.create_code(db, other, "save20")

    def test_active_code_cap_enforced(self, db):
        affiliate = make_affiliate(db, max_active_codes=2)
        svc.create_code(db, affiliate, "CODE-1")
        svc.create_code(db, affiliate, "CODE-2")
        db.commit()
        with pytest.raises(svc.CodeLimitReached):
            svc.create_code(db, affiliate, "CODE-3")

    def test_deactivated_codes_do_not_count_toward_cap(self, db):
        affiliate = make_affiliate(db, max_active_codes=2)
        svc.create_code(db, affiliate, "CODE-1")
        make_code(db, affiliate, "CODE-2", active=False)
        db.commit()
        row = svc.create_code(db, affiliate, "CODE-3")
        assert row.active is True

    def test_split_must_fit_affiliate_pool(self, db):
        affiliate = make_affiliate(db, commission_bps=2000)  # 20% pool
        with pytest.raises(svc.CommissionSplitExceedsPool):
            svc.create_code(db, affiliate, "OVER1", affiliate_commission_bps=1500, customer_discount_bps=1000)
        row = svc.create_code(db, affiliate, "FITS1", affiliate_commission_bps=1500, customer_discount_bps=500)
        assert row.affiliate_commission_bps == 1500

    @pytest.mark.parametrize("reserved", ["FREE", "OYECHATS", "ADMIN", "TEST", "OFFER", "SALE", "DISCOUNT", "SUPPORT"])
    def test_reserved_codes_rejected(self, db, reserved):
        affiliate = make_affiliate(db)
        with pytest.raises(svc.InvalidCodeFormat):
            svc.create_code(db, affiliate, reserved)

    def test_reserved_codes_case_insensitive(self, db):
        affiliate = make_affiliate(db)
        with pytest.raises(svc.InvalidCodeFormat):
            svc.create_code(db, affiliate, "free")
        with pytest.raises(svc.InvalidCodeFormat):
            svc.create_code(db, affiliate, "Admin")

    def test_non_reserved_code_is_allowed(self, db):
        affiliate = make_affiliate(db)
        row = svc.create_code(db, affiliate, "JOHN10")
        assert row.code == "JOHN10"


# ── update_code ──────────────────────────────────────────────────────────────


class TestUpdateCode:
    def test_deactivate_then_reactivate(self, db):
        affiliate = make_affiliate(db)
        row = svc.create_code(db, affiliate, "SAVE20")
        db.commit()

        svc.update_code(db, affiliate, row.id, active=False)
        db.commit()
        assert row.active is False
        assert row.deactivated_at is not None

        svc.update_code(db, affiliate, row.id, active=True)
        db.commit()
        assert row.active is True
        assert row.deactivated_at is None

    def test_reactivation_respects_cap(self, db):
        affiliate = make_affiliate(db, max_active_codes=1)
        dormant = make_code(db, affiliate, "OLD-CODE", active=False)
        svc.create_code(db, affiliate, "NEW-CODE")
        db.commit()
        with pytest.raises(svc.CodeLimitReached):
            svc.update_code(db, affiliate, dormant.id, active=True)

    def test_rename_to_existing_code_rejected(self, db):
        affiliate = make_affiliate(db)
        svc.create_code(db, affiliate, "TAKEN1")
        row = svc.create_code(db, affiliate, "MINE-1")
        db.commit()
        with pytest.raises(svc.CodeAlreadyExists):
            svc.update_code(db, affiliate, row.id, code="taken1")

    def test_cannot_touch_another_affiliates_code(self, db):
        theirs = svc.create_code(db, make_affiliate(db), "THEIRS")
        db.commit()
        me = make_affiliate(db)
        with pytest.raises(svc.CodeNotFound):
            svc.update_code(db, me, theirs.id, label="hijack")

    @pytest.mark.parametrize("reserved", ["FREE", "admin", "Test"])
    def test_rename_to_reserved_code_rejected(self, db, reserved):
        affiliate = make_affiliate(db)
        row = svc.create_code(db, affiliate, "MYCODE1")
        db.commit()
        with pytest.raises(svc.InvalidCodeFormat):
            svc.update_code(db, affiliate, row.id, code=reserved)


# ── invite_affiliate / accept_invite (program cap + magic-link lifecycle) ────


class TestInviteLifecycle:
    def test_program_capped_at_five_active_affiliates(self, db):
        superadmin = make_client(db)
        for _ in range(svc.MAX_ACTIVE_AFFILIATES):
            make_affiliate(db)
        with pytest.raises(svc.AffiliateLimitReached):
            svc.invite_affiliate(db, email="sixth@example.com", invited_by_client_id=superadmin.id)

    def test_deactivated_affiliates_free_up_cap_slots(self, db):
        superadmin = make_client(db)
        for _ in range(svc.MAX_ACTIVE_AFFILIATES - 1):
            make_affiliate(db)
        make_affiliate(db, deactivated=True)
        result = svc.invite_affiliate(db, email="fits@example.com", invited_by_client_id=superadmin.id)
        assert result["kind"] == "pending_invite"

    def test_existing_client_becomes_affiliate_instantly(self, db):
        superadmin = make_client(db)
        customer = make_client(db, email="customer@example.com")
        result = svc.invite_affiliate(db, email="Customer@Example.com", invited_by_client_id=superadmin.id)
        db.commit()
        assert result["kind"] == "instant"
        assert result["affiliate"].client_id == customer.id

    def test_already_active_affiliate_rejected(self, db):
        superadmin = make_client(db)
        customer = make_client(db, email="customer@example.com")
        make_affiliate(db, customer)
        with pytest.raises(svc.AlreadyAffiliate):
            svc.invite_affiliate(db, email="customer@example.com", invited_by_client_id=superadmin.id)

    def test_duplicate_pending_invite_rejected(self, db):
        superadmin = make_client(db)
        svc.invite_affiliate(db, email="new@example.com", invited_by_client_id=superadmin.id)
        db.commit()
        with pytest.raises(svc.InviteAlreadyPending):
            svc.invite_affiliate(db, email="new@example.com", invited_by_client_id=superadmin.id)

    def test_accept_invite_creates_client_and_affiliate(self, db):
        superadmin = make_client(db)
        result = svc.invite_affiliate(db, email="new@example.com", invited_by_client_id=superadmin.id)
        db.commit()

        client, affiliate = svc.accept_invite(
            db,
            result["raw_token"],
            name="New Affiliate",
            password_hash="$2b$12$notarealhash",
            api_key="accepted-api-key-1",
        )
        db.commit()
        assert client.email == "new@example.com"
        assert affiliate.client_id == client.id
        assert result["invite"].accepted_at is not None

        # The token is one-shot.
        with pytest.raises(svc.InviteAlreadyUsed):
            svc.lookup_invite_by_token(db, result["raw_token"])

    def test_expired_invite_rejected(self, db):
        superadmin = make_client(db)
        result = svc.invite_affiliate(db, email="slow@example.com", invited_by_client_id=superadmin.id)
        result["invite"].expires_at = datetime.now(UTC) - timedelta(days=1)
        db.commit()
        with pytest.raises(svc.InviteExpired):
            svc.lookup_invite_by_token(db, result["raw_token"])

    def test_revoked_invite_rejected(self, db):
        superadmin = make_client(db)
        result = svc.invite_affiliate(db, email="revoked@example.com", invited_by_client_id=superadmin.id)
        db.commit()
        svc.revoke_invite(db, result["invite"].id)
        db.commit()
        with pytest.raises(svc.InviteAlreadyUsed):
            svc.lookup_invite_by_token(db, result["raw_token"])


# ── no-stacking guard ─────────────────────────────────────────────────────────


class TestNoStackingGuard:
    """The checkout no-stacking guard prevents combining referral + coupon."""

    def test_raises_when_both_referral_and_coupon(self):
        from types import SimpleNamespace

        from fastapi import HTTPException

        from app.api.subscription_routes import _assert_no_stacking

        client = SimpleNamespace(referral_code_id=7)
        with pytest.raises(HTTPException) as exc_info:
            _assert_no_stacking(client, "SUMMER10")
        assert exc_info.value.status_code == 400

    def test_passes_when_only_referral_code(self):
        from types import SimpleNamespace

        from app.api.subscription_routes import _assert_no_stacking

        client = SimpleNamespace(referral_code_id=7)
        _assert_no_stacking(client, None)  # no raise

    def test_passes_when_only_coupon(self):
        from types import SimpleNamespace

        from app.api.subscription_routes import _assert_no_stacking

        client = SimpleNamespace(referral_code_id=None)
        _assert_no_stacking(client, "SUMMER10")  # no raise

    def test_passes_when_neither(self):
        from types import SimpleNamespace

        from app.api.subscription_routes import _assert_no_stacking

        client = SimpleNamespace(referral_code_id=None)
        _assert_no_stacking(client, None)  # no raise
