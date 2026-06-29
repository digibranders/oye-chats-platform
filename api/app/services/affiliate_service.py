"""Affiliate program v1 — service layer (money-free).

This module owns every read/write on ``affiliates``, ``referral_codes``, and
``referral_clicks``, plus the atomic first-touch attribution UPDATE on
``clients``. Routes are thin wrappers around the functions exported here;
they do not touch the ORM directly so the same logic is reusable from
background workers, scripts, and tests.

v1 scope is intentionally limited to the referral-code mechanic — no
commission %, no customer discount, no payouts. Those land in v2 (see
``platform/docs/affiliate-program.md``).
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models import Affiliate, AffiliateInvite, Client, Plan, ReferralClick, ReferralCode, Subscription

logger = logging.getLogger(__name__)

# ─── Constants ──────────────────────────────────────────────────────────

# v1 program cap — 5 hand-picked affiliates. Enforced at the service layer
# (not in the DB) so raising it later does not need a migration.
MAX_ACTIVE_AFFILIATES = 5

# Default per-affiliate cap on simultaneously-active codes. Each affiliate
# row can override via ``affiliates.max_active_codes``.
DEFAULT_MAX_ACTIVE_CODES = 10

# Mirror of the DB-level CHECK constraint. Validating here gives a clean
# 400 with a human-readable message instead of an IntegrityError from PG.
CODE_REGEX = re.compile(r"^[A-Za-z0-9_-]{3,20}$")

# Magic-link invite TTL — long enough that a busy founder still finds the
# email after a weekend, short enough that a leaked invite link doesn't sit
# accepting indefinitely.
INVITE_TTL_DAYS = 14

# Bytes of entropy in the raw token. ``token_urlsafe(32)`` returns ~43 chars
# of URL-safe base64; well over the 128-bit guess-resistance threshold.
INVITE_TOKEN_BYTES = 32

# Hard ceiling on commission_bps. 10000 bps = 100% — we never allow a
# negative commission or one that exceeds the gross. Both ends of the
# range are also enforced at the DB layer via a CHECK constraint.
MAX_COMMISSION_BPS = 10000

# Codes that look like they belong to OyeChats itself or are too generic to
# be owned by any single affiliate.
_RESERVED_CODES: frozenset[str] = frozenset(
    {
        "OYECHATS",
        "FREE",
        "SALE",
        "DISCOUNT",
        "ADMIN",
        "SUPPORT",
        "TEST",
        "OFFER",
    }
)


def _assert_not_reserved(code: str) -> None:
    if code.strip().upper() in _RESERVED_CODES:
        raise InvalidCodeFormat(f"'{code}' is a reserved code and cannot be used.")


# Re-export the canonical implementations from ``app.core.money`` so any
# existing import (``from app.services.affiliate_service import pct_to_bps``)
# keeps working without dragging the old behaviour around. Centralising
# means an admin's ``12.345%`` becomes the SAME bps value here, in the
# billing-service Stripe coupon flow, and in the audit metadata — fixing
# the "quote vs invoice differ by 1 bps" gap surfaced by the audit.
from app.core.money import bps_to_pct, pct_to_bps  # noqa: E402,F401

# ─── Exceptions ─────────────────────────────────────────────────────────


class AffiliateProgramError(Exception):
    """Base class for all v1 affiliate-program failures."""


class AffiliateLimitReached(AffiliateProgramError):
    """Raised when the 5-seat cap on active affiliates is already taken."""


class CodeLimitReached(AffiliateProgramError):
    """Raised when an affiliate is at their ``max_active_codes`` ceiling."""


class InvalidCodeFormat(AffiliateProgramError):
    """Raised when a proposed code does not match ``CODE_REGEX``."""


class CodeAlreadyExists(AffiliateProgramError):
    """Raised when a proposed code collides with an existing one (case-insensitive)."""


class ClientNotFound(AffiliateProgramError):
    """Raised when an invite targets an email that has no Client account."""


class AlreadyAffiliate(AffiliateProgramError):
    """Raised when an invite targets a client that is already an affiliate."""


class NotAffiliate(AffiliateProgramError):
    """Raised when a code mutation is attempted by a non-affiliate principal."""


class CodeNotFound(AffiliateProgramError):
    """Raised when a code id does not exist or is not owned by the caller."""


class InviteNotFound(AffiliateProgramError):
    """Raised when an invite token does not match any row."""


class InviteExpired(AffiliateProgramError):
    """Raised when an invite token is past its expires_at."""


class InviteAlreadyUsed(AffiliateProgramError):
    """Raised when an invite token has already been accepted or revoked."""


class InviteAlreadyPending(AffiliateProgramError):
    """Raised when a new invite is requested for an email that already has a pending one."""


class InviteEmailMismatch(AffiliateProgramError):
    """Raised when an existing-client tries to redeem a token addressed to a
    different email. Keeps invites bound to the email they were sent to so
    one person can't redeem another's invite by pasting the URL while signed
    into their own account."""


class CommissionSplitExceedsPool(AffiliateProgramError):
    """Raised when a code's (affiliate + customer) split exceeds the affiliate's pool.

    The pool is ``affiliates.commission_bps`` (set by the super-admin). A
    single code cannot promise more than the affiliate is entitled to.
    """


# ─── Hashing helpers (privacy) ──────────────────────────────────────────


def _daily_salt() -> str:
    """Return a per-day salt for IP/UA hashing.

    Combines a server-side secret (``AFFILIATE_HASH_SALT`` env var) with the
    current UTC date. Cross-day correlation of the same visitor requires
    knowledge of the secret, which the application never exposes.
    """
    base = os.getenv("AFFILIATE_HASH_SALT", "oyechats-affiliate-default-salt")
    day = datetime.now(UTC).strftime("%Y-%m-%d")
    return f"{base}|{day}"


def _hash_value(value: str | None, salt: str) -> str | None:
    """SHA-256 a value with the given salt; ``None`` in → ``None`` out."""
    if not value:
        return None
    return hashlib.sha256(f"{value}|{salt}".encode()).hexdigest()


# ─── Code lookup & validation (public, no auth) ─────────────────────────


def validate_code(session: Session, code: str) -> ReferralCode | None:
    """Look up an active referral code by name.

    Returns the ``ReferralCode`` ORM row when the code exists and is active,
    or ``None`` otherwise. Lookup is case-insensitive (``code`` column is
    ``CITEXT``). Callers must not log the code on a miss — that would help
    enumeration attempts.
    """
    if not code:
        return None
    return session.execute(
        select(ReferralCode).where(
            ReferralCode.code == code,
            ReferralCode.active.is_(True),
        )
    ).scalar_one_or_none()


def record_click(
    session: Session,
    code: str,
    *,
    ip: str | None,
    user_agent: str | None,
    referrer: str | None,
) -> bool:
    """Append a click row for ``code`` if the code is valid + active.

    IP and User-Agent are hashed with a per-day rotating salt before
    insertion — raw values never reach the DB. ``referrer`` is trimmed to
    500 chars to bound storage. Returns ``True`` if a row was written.
    Invalid codes return ``False`` silently (no error) so the public
    endpoint cannot be probed for valid-code enumeration via timing.
    """
    code_row = validate_code(session, code)
    if not code_row:
        return False

    salt = _daily_salt()
    session.add(
        ReferralClick(
            code_id=code_row.id,
            ip_hash=_hash_value(ip, salt),
            ua_hash=_hash_value(user_agent, salt),
            referrer=(referrer or "")[:500] or None,
        )
    )
    return True


# ─── Attribution (called from the register endpoint) ────────────────────


def attribute_signup(session: Session, client_id: int, code: str | None) -> bool:
    """Attribute a freshly-created client to a referral code (first-touch wins).

    The attribution is performed as a single atomic ``UPDATE WHERE
    referral_code_id IS NULL`` — if two concurrent registrations race on
    the same client (which should never happen, but belt-and-suspenders),
    exactly one wins and the other is a no-op. Re-attribution is also
    impossible: once ``clients.referral_code_id`` is non-null, this
    function returns ``False``.

    Failure modes (invalid code, inactive code, self-referral, race-loss)
    are all silent ``False`` returns. Signup must never fail because of a
    referral problem.
    """
    if not code or not client_id:
        return False

    code_row = validate_code(session, code)
    if not code_row:
        logger.info("referral_attribute_skip_invalid_code", extra={"code": code, "client_id": client_id})
        return False

    # Self-referral block: an affiliate cannot earn from their own signup.
    # The check happens here (not at code creation) because v1 ships before
    # we have a multi-account / aliasing story — this is the cheapest guard.
    affiliate = session.get(Affiliate, code_row.affiliate_id)
    if affiliate is None:
        # Dangling code → defensive; should be impossible via FK RESTRICT.
        return False
    if affiliate.client_id == client_id:
        logger.warning(
            "referral_self_referral_blocked",
            extra={"client_id": client_id, "code": code},
        )
        return False

    # Atomic first-touch: only set ``referral_code_id`` if it is currently
    # NULL. If a second call arrives (different code, race, retry), the
    # WHERE clause is false → 0 rows updated → no-op.
    result = session.execute(
        update(Client)
        .where(
            Client.id == client_id,
            Client.referral_code_id.is_(None),
        )
        .values(
            referral_code_id=code_row.id,
            referral_attributed_at=func.now(),
        )
    )
    attributed = result.rowcount == 1
    if attributed:
        logger.info(
            "referral_attributed",
            extra={"client_id": client_id, "code_id": code_row.id, "code": code},
        )
    return attributed


# ─── Code CRUD (affiliate-scoped) ───────────────────────────────────────


def _validate_split(
    affiliate: Affiliate,
    affiliate_commission_bps: int,
    customer_discount_bps: int,
) -> None:
    """Ensure (my-commission + friend-reward) ≤ affiliate's pool.

    Both halves must independently be ≥ 0 and ≤ 100% — that's also a DB
    CHECK, but failing here gives a clean error message. The pool check
    is application-only because Postgres CHECK can't reach across tables.
    """
    if affiliate_commission_bps < 0 or customer_discount_bps < 0:
        raise CommissionSplitExceedsPool("Commission and reward must each be ≥ 0%.")
    if affiliate_commission_bps > MAX_COMMISSION_BPS or customer_discount_bps > MAX_COMMISSION_BPS:
        raise CommissionSplitExceedsPool("Commission and reward must each be ≤ 100%.")
    total = affiliate_commission_bps + customer_discount_bps
    pool = affiliate.commission_bps or 0
    if total > pool:
        # Convert to human percent for the error message.
        my_pct = bps_to_pct(affiliate_commission_bps)
        rw_pct = bps_to_pct(customer_discount_bps)
        pool_pct = bps_to_pct(pool)
        raise CommissionSplitExceedsPool(
            f"Split exceeds your pool: my {my_pct}% + reward {rw_pct}% = "
            f"{bps_to_pct(total)}% > {pool_pct}% available. "
            "Either lower the split or ask your account manager to raise your pool."
        )


def count_active_codes(session: Session, affiliate_id: int) -> int:
    """Return the number of currently-active codes for the affiliate."""
    return (
        session.scalar(
            select(func.count(ReferralCode.id)).where(
                ReferralCode.affiliate_id == affiliate_id,
                ReferralCode.active.is_(True),
            )
        )
        or 0
    )


def create_code(
    session: Session,
    affiliate: Affiliate,
    code: str,
    label: str | None = None,
    *,
    affiliate_commission_bps: int = 0,
    customer_discount_bps: int = 0,
) -> ReferralCode:
    """Create a referral code for the given affiliate.

    The ``affiliate_commission_bps`` + ``customer_discount_bps`` pair defines
    the per-code split — what the affiliate keeps vs. what the referred
    customer gets. Their sum must not exceed the affiliate's pool
    (``affiliates.commission_bps``, set by the super-admin).

    Raises:
      InvalidCodeFormat            — code does not match the regex
      CodeAlreadyExists            — global unique constraint hit (case-insensitive)
      CodeLimitReached             — affiliate is at their ``max_active_codes`` ceiling
      CommissionSplitExceedsPool   — split goes over the affiliate's pool
    """
    code = (code or "").strip()
    if not CODE_REGEX.match(code):
        raise InvalidCodeFormat("Code must be 3–20 characters of letters, digits, '_' or '-'.")
    _assert_not_reserved(code)

    _validate_split(affiliate, affiliate_commission_bps, customer_discount_bps)

    active = count_active_codes(session, affiliate.id)
    if active >= affiliate.max_active_codes:
        raise CodeLimitReached(
            f"You have {active} active codes (limit: {affiliate.max_active_codes}). "
            "Deactivate one before creating another."
        )

    row = ReferralCode(
        affiliate_id=affiliate.id,
        code=code,
        label=(label or "").strip() or None,
        active=True,
        affiliate_commission_bps=affiliate_commission_bps,
        customer_discount_bps=customer_discount_bps,
    )
    session.add(row)
    try:
        session.flush()
    except IntegrityError as e:
        session.rollback()
        # Either the unique-on-code or the format CHECK fired; we already
        # validated format, so collision is the likely cause.
        raise CodeAlreadyExists(f"Code '{code}' is already in use.") from e
    return row


def update_code(
    session: Session,
    affiliate: Affiliate,
    code_id: int,
    *,
    code: str | None = None,
    label: str | None = None,
    active: bool | None = None,
    affiliate_commission_bps: int | None = None,
    customer_discount_bps: int | None = None,
) -> ReferralCode:
    """Update mutable fields on a code.

    Renaming a code (``code`` arg) is allowed but destructive in effect: the
    old URL (``?ref=OLDNAME``) immediately stops validating. Existing
    referred clients keep their attribution (they FK to the row by ``id``,
    not by the string), and historical clicks survive intact — only the
    inbound URL string changes. The frontend surfaces a warning before the
    PATCH so affiliates don't accidentally break links they've already shared.

    The ``affiliate_commission_bps`` + ``customer_discount_bps`` pair edits
    the per-code split. If one is provided and the other is None, the
    untouched side keeps its current value; both are then re-validated
    together against the affiliate's pool.

    Setting ``active=False`` deactivates the code (existing referrals keep
    earning; new signups are rejected). Setting ``active=True`` on a
    previously-deactivated code re-activates it, subject to the affiliate's
    ``max_active_codes`` cap.
    """
    row = session.get(ReferralCode, code_id)
    if row is None or row.affiliate_id != affiliate.id:
        raise CodeNotFound("Code not found.")

    # ── Commission split (optional, validated as a pair) ────────────────
    if affiliate_commission_bps is not None or customer_discount_bps is not None:
        next_my = affiliate_commission_bps if affiliate_commission_bps is not None else row.affiliate_commission_bps
        next_reward = customer_discount_bps if customer_discount_bps is not None else row.customer_discount_bps
        _validate_split(affiliate, next_my, next_reward)
        row.affiliate_commission_bps = next_my
        row.customer_discount_bps = next_reward

    # ── Rename the code string (optional) ───────────────────────────────
    if code is not None:
        cleaned_code = code.strip()
        # No-op if the new value is identical (CITEXT comparison handles
        # case differences). Bail before touching the DB so a redundant
        # save doesn't trigger uniqueness checks.
        if cleaned_code.lower() != str(row.code).lower():
            if not CODE_REGEX.match(cleaned_code):
                raise InvalidCodeFormat("Code must be 3–20 characters of letters, digits, '_' or '-'.")
            _assert_not_reserved(cleaned_code)
            row.code = cleaned_code
            try:
                session.flush()
            except IntegrityError as e:
                session.rollback()
                # Re-fetch the row since rollback may have invalidated it.
                raise CodeAlreadyExists(f"Code '{cleaned_code}' is already in use.") from e

    if label is not None:
        # Empty string clears the label.
        cleaned = label.strip()
        row.label = cleaned or None

    if active is not None and active != row.active:
        if active:
            # Re-activate: re-check the cap.
            current = count_active_codes(session, affiliate.id)
            if current >= affiliate.max_active_codes:
                raise CodeLimitReached(
                    f"Re-activating this code would exceed your {affiliate.max_active_codes}-code limit."
                )
            row.active = True
            row.deactivated_at = None
        else:
            row.active = False
            row.deactivated_at = func.now()
    return row


def list_codes_with_stats(session: Session, affiliate_id: int) -> list[dict]:
    """Return per-code analytics for the affiliate dashboard.

    Each row carries: ``id``, ``code``, ``label``, ``active``, ``clicks``,
    ``signups``, ``conversion_pct``, ``created_at``, ``deactivated_at``.
    Conversion is computed as ``signups / clicks * 100``, ``None`` when
    ``clicks == 0``.
    """
    # Two correlated subqueries — cheap because both columns are indexed
    # and there are O(5) affiliates × O(10) codes worst case in v1.
    click_count = (
        select(func.count(ReferralClick.id))
        .where(ReferralClick.code_id == ReferralCode.id)
        .correlate(ReferralCode)
        .scalar_subquery()
    )
    signup_count = (
        select(func.count(Client.id))
        .where(Client.referral_code_id == ReferralCode.id)
        .correlate(ReferralCode)
        .scalar_subquery()
    )

    stmt = (
        select(
            ReferralCode.id,
            ReferralCode.code,
            ReferralCode.label,
            ReferralCode.active,
            ReferralCode.affiliate_commission_bps,
            ReferralCode.customer_discount_bps,
            ReferralCode.created_at,
            ReferralCode.deactivated_at,
            click_count.label("clicks"),
            signup_count.label("signups"),
        )
        .where(ReferralCode.affiliate_id == affiliate_id)
        .order_by(ReferralCode.active.desc(), ReferralCode.created_at.desc())
    )

    rows = session.execute(stmt).all()
    out = []
    for r in rows:
        clicks = int(r.clicks or 0)
        signups = int(r.signups or 0)
        conv = (signups / clicks * 100) if clicks > 0 else None
        out.append(
            {
                "id": r.id,
                "code": str(r.code),
                "label": r.label,
                "active": bool(r.active),
                "affiliate_commission_bps": int(r.affiliate_commission_bps or 0),
                "customer_discount_bps": int(r.customer_discount_bps or 0),
                "affiliate_commission_pct": bps_to_pct(int(r.affiliate_commission_bps or 0)),
                "customer_discount_pct": bps_to_pct(int(r.customer_discount_bps or 0)),
                "clicks": clicks,
                "signups": signups,
                "conversion_pct": round(conv, 1) if conv is not None else None,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "deactivated_at": r.deactivated_at.isoformat() if r.deactivated_at else None,
            }
        )
    return out


def get_code_with_owner(session: Session, code_id: int) -> tuple[ReferralCode, Affiliate] | None:
    """Return ``(code, owning_affiliate)`` or ``None`` if the code doesn't exist.

    Used by the referrals-list endpoints to (a) authorise the caller against
    the code's owner and (b) compute the platform commission slice (which
    depends on the affiliate's overall pool, not the per-code split).
    """
    code = session.get(ReferralCode, code_id)
    if code is None:
        return None
    aff = session.get(Affiliate, code.affiliate_id)
    if aff is None:
        return None
    return code, aff


def list_code_referrals(
    session: Session,
    code_id: int,
    *,
    include_platform: bool,
) -> dict:
    """Return the per-customer referral list for a single code.

    Output shape — surfaced verbatim to both the affiliate and the super
    admin so the UI can render the same modal in both contexts::

        {
          "code": "STEVE20",
          "breakdown": {
            "pool_pct": 25.0,                 # affiliate.commission_bps
            "affiliate_pct": 15.0,            # code.affiliate_commission_bps
            "customer_discount_pct": 10.0,    # code.customer_discount_bps
            "platform_pct": 75.0,             # ONLY when include_platform=True
                                              #   (100 - pool − code_unused)
            "code_unused_pool_pct": 0.0       # pool − affiliate − customer
          },
          "referrals": [
            { "client_id": 10, "email": "g***@***.com", "name": "Gaurav",
              "attributed_at": "2026-06-10T07:21:04+00:00" },
            ...
          ]
        }

    ``include_platform`` is True only for the super-admin route — the
    affiliate must never see the platform's revenue cut. Email is masked
    when ``include_platform=False`` to protect customer privacy on the
    affiliate side.

    Referrals are ordered by ``attributed_at`` DESC so the most recent
    signup shows first. There's no pagination yet because the v1 invite
    cap caps each affiliate at 10 active codes × low signup volume;
    add a ``limit`` kwarg here if that assumption breaks.
    """
    pair = get_code_with_owner(session, code_id)
    if pair is None:
        raise CodeNotFound(f"Code {code_id} not found")
    code, aff = pair

    pool_bps = int(aff.commission_bps or 0)
    aff_bps = int(code.affiliate_commission_bps or 0)
    cust_bps = int(code.customer_discount_bps or 0)
    code_unused = max(0, pool_bps - aff_bps - cust_bps)

    breakdown: dict[str, float | None] = {
        "pool_pct": bps_to_pct(pool_bps),
        "affiliate_pct": bps_to_pct(aff_bps),
        "customer_discount_pct": bps_to_pct(cust_bps),
        "code_unused_pool_pct": bps_to_pct(code_unused),
    }
    if include_platform:
        # The platform's slice of a single referred-customer dollar:
        # the affiliate's per-code commission + the customer's discount
        # are paid out of the affiliate's pool; everything else stays
        # with OyeChats. The "code unused pool" is leeway the affiliate
        # didn't allocate (e.g. pool=25, code=15+5 → 5pp unused) — it's
        # still in the pool budget, so it doesn't accrue to the platform.
        platform_bps = max(0, MAX_COMMISSION_BPS - pool_bps)
        breakdown["platform_pct"] = bps_to_pct(platform_bps)

    referrals_stmt = (
        select(
            Client.id,
            Client.name,
            Client.email,
            Client.referral_attributed_at,
        )
        .where(Client.referral_code_id == code_id)
        .order_by(Client.referral_attributed_at.desc().nulls_last())
    )
    rows = session.execute(referrals_stmt).all()

    def _mask_email(email: str | None) -> str:
        if not email or "@" not in email:
            return "—"
        local, _, domain = email.partition("@")
        # Keep one char of local + the TLD; hide the rest. ``a@b.co`` →
        # ``a***@***.co``; ``stevejson@gmail.com`` → ``s***@***.com``.
        local_head = local[0] if local else ""
        tld = domain.rsplit(".", 1)[-1] if "." in domain else domain
        return f"{local_head}***@***.{tld}"

    # ── Per-customer pricing distribution ──
    #
    # For each referred customer we look up their CURRENT active subscription
    # (if any) and compute how each $ of their monthly bill is split. The
    # breakdown follows the same model as the percentage one above:
    #
    #     customer pays full plan_price × (1 - customer_discount_pct/100)
    #     affiliate earns  full_plan_price × affiliate_commission_pct/100
    #     platform keeps   full_plan_price × platform_pct/100   (super admin only)
    #     customer saved   full_plan_price × customer_discount_pct/100
    #
    # ``full_plan_price`` is sourced from the customer's plan row at the
    # current billing cycle. Free / no-sub / no-price customers fall to all
    # zeroes — no contribution to the aggregate either way.
    #
    # We batch the plan + subscription lookups in two queries so a 100-
    # referral code stays a constant-time fetch.
    client_ids = [int(r.id) for r in rows]

    # Map client_id → (plan_price_cents, currency, plan_slug)
    subs_by_client: dict[int, tuple[int, str, str]] = {}
    if client_ids:
        sub_rows = session.execute(
            select(
                Subscription.client_id,
                Subscription.billing_cycle,
                Plan.monthly_price_cents,
                Plan.annual_price_cents,
                Plan.currency,
                Plan.slug,
            )
            .join(Plan, Plan.id == Subscription.plan_id)
            .where(
                Subscription.client_id.in_(client_ids),
                Subscription.status.in_(("active", "trialing")),
            )
        ).all()
        for sub_row in sub_rows:
            # Annual subs are billed once a year for `annual_price_cents`;
            # we report the *monthly equivalent* on the per-customer card so
            # the affiliate sees apples-to-apples earnings per referral.
            cycle = (sub_row.billing_cycle or "monthly").lower()
            if cycle == "annual" and sub_row.annual_price_cents:
                monthly_equiv = sub_row.annual_price_cents // 12
            else:
                monthly_equiv = int(sub_row.monthly_price_cents or 0)
            subs_by_client[int(sub_row.client_id)] = (
                monthly_equiv,
                str(sub_row.currency or "USD"),
                str(sub_row.slug or ""),
            )

    aff_share = aff_bps / MAX_COMMISSION_BPS
    cust_share = cust_bps / MAX_COMMISSION_BPS
    platform_share = max(0.0, 1.0 - pool_bps / MAX_COMMISSION_BPS) if include_platform else 0.0

    # Aggregate totals — sum across every referred customer's monthly-equiv
    # contribution. Surfaced at the top of the modal so the affiliate can
    # see "your codes are pulling in ~$X/mo at full price" at a glance.
    total_full_cents = 0
    total_aff_cents = 0
    total_cust_saved_cents = 0
    total_platform_cents = 0
    total_paying = 0
    distribution_currency: str | None = None

    referrals: list[dict] = []
    for r in rows:
        client_id = int(r.id)
        sub_info = subs_by_client.get(client_id)
        if sub_info:
            full_cents, currency, plan_slug = sub_info
        else:
            full_cents, currency, plan_slug = 0, "USD", "free"

        # Currency consistency: if the customer set has more than one
        # currency we surface that in the aggregate (the modal renders a
        # plain symbol per-row anyway). Pick the first non-empty currency
        # for the aggregate label; flag the mismatch on the response so
        # the UI doesn't pretend an inconsistent set is one currency.
        if full_cents > 0:
            distribution_currency = distribution_currency or currency

        aff_cents = int(full_cents * aff_share)
        cust_saved_cents = int(full_cents * cust_share)
        platform_cents = int(full_cents * platform_share) if include_platform else 0
        paid_cents = full_cents - cust_saved_cents

        if full_cents > 0:
            total_full_cents += full_cents
            total_aff_cents += aff_cents
            total_cust_saved_cents += cust_saved_cents
            total_platform_cents += platform_cents
            total_paying += 1

        per_customer: dict[str, int | str | None] = {
            "plan_slug": plan_slug,
            "currency": currency,
            "full_price_cents": full_cents,
            "paid_cents": paid_cents,
            "affiliate_earns_cents": aff_cents,
            "customer_saved_cents": cust_saved_cents,
        }
        if include_platform:
            per_customer["platform_cents"] = platform_cents

        referrals.append(
            {
                "client_id": client_id,
                "name": r.name or None,
                "email": r.email if include_platform else _mask_email(r.email),
                "attributed_at": r.referral_attributed_at.isoformat() if r.referral_attributed_at else None,
                "pricing": per_customer,
            }
        )

    distribution: dict[str, int | str | None] = {
        # ``currency`` is the dominant currency in the referral set. When
        # the set is empty (no paying referrals yet) we report None so the
        # UI can render "—" instead of pretending it's USD.
        "currency": distribution_currency,
        "paying_referrals": total_paying,
        "monthly_total_cents": total_full_cents,
        "monthly_affiliate_cents": total_aff_cents,
        "monthly_customer_saved_cents": total_cust_saved_cents,
    }
    if include_platform:
        distribution["monthly_platform_cents"] = total_platform_cents

    return {
        "code": str(code.code),
        "breakdown": breakdown,
        "distribution": distribution,
        "referrals": referrals,
    }


def get_affiliate_stats(session: Session, affiliate_id: int) -> dict:
    """Aggregate metrics for the affiliate dashboard header card."""
    total_clicks = (
        session.scalar(
            select(func.count(ReferralClick.id))
            .join(ReferralCode, ReferralCode.id == ReferralClick.code_id)
            .where(ReferralCode.affiliate_id == affiliate_id)
        )
        or 0
    )
    total_signups = (
        session.scalar(
            select(func.count(Client.id))
            .join(ReferralCode, ReferralCode.id == Client.referral_code_id)
            .where(ReferralCode.affiliate_id == affiliate_id)
        )
        or 0
    )
    active_codes = count_active_codes(session, affiliate_id)
    aff = session.get(Affiliate, affiliate_id)
    return {
        "total_clicks": int(total_clicks),
        "total_signups": int(total_signups),
        "active_codes": active_codes,
        "max_active_codes": aff.max_active_codes if aff else DEFAULT_MAX_ACTIVE_CODES,
        "conversion_pct": (round(total_signups / total_clicks * 100, 1) if total_clicks > 0 else None),
    }


# ─── Super-admin operations ─────────────────────────────────────────────


def count_active_affiliates(session: Session) -> int:
    return session.scalar(select(func.count(Affiliate.id)).where(Affiliate.deactivated_at.is_(None))) or 0


def _hash_token(raw: str) -> str:
    """SHA-256 the raw token; we never persist raw values."""
    return hashlib.sha256(raw.encode()).hexdigest()


def _generate_invite_token() -> tuple[str, str]:
    """Return ``(raw_token, token_hash)``. Raw token is emailed once."""
    raw = secrets.token_urlsafe(INVITE_TOKEN_BYTES)
    return raw, _hash_token(raw)


def invite_affiliate(
    session: Session,
    *,
    email: str,
    invited_by_client_id: int,
    max_active_codes: int = DEFAULT_MAX_ACTIVE_CODES,
    commission_bps: int = 0,
) -> dict:
    """Invite a customer or stranger to the affiliate program.

    Two paths, selected automatically based on whether the email matches an
    existing Client:

    * **Existing Client** → creates (or reactivates) an ``Affiliate`` row
      immediately. The recipient gets a welcome email pointing at
      ``/affiliate``. Returns
      ``{"kind": "instant", "affiliate": Affiliate}``.
    * **No Client yet**   → creates an ``AffiliateInvite`` row with a
      one-time token. The raw token is returned to the caller (route
      handler) so it can be embedded in the magic-link email. Returns
      ``{"kind": "pending_invite", "invite": AffiliateInvite,
         "raw_token": str}``.

    The route handler decides which email template to fire, keeping this
    function side-effect-free w.r.t. external services (good for tests).

    Raises:
      AffiliateLimitReached — 5 active affiliates already exist
      AlreadyAffiliate      — client already has an active affiliate row
      InviteAlreadyPending  — a pending invite already exists for the email
    """
    if count_active_affiliates(session) >= MAX_ACTIVE_AFFILIATES:
        raise AffiliateLimitReached(
            f"Active affiliates are capped at {MAX_ACTIVE_AFFILIATES}. "
            "Deactivate an existing affiliate before inviting another."
        )

    if max_active_codes <= 0:
        max_active_codes = DEFAULT_MAX_ACTIVE_CODES

    # Clamp commission to the valid range. Negative or >100% would fail at
    # the DB CHECK anyway, but a clean exception beats an IntegrityError.
    if commission_bps < 0 or commission_bps > MAX_COMMISSION_BPS:
        raise AffiliateProgramError("Commission must be between 0% and 100%.")

    email_norm = (email or "").strip().lower()
    if not email_norm:
        # No client_id means we treat this exactly like the "no email" case.
        raise ClientNotFound("Email is required.")

    client = session.execute(select(Client).where(Client.email == email_norm)).scalar_one_or_none()

    # ── Path 1: existing customer → create/reactivate Affiliate row ─────
    if client is not None:
        existing = session.execute(select(Affiliate).where(Affiliate.client_id == client.id)).scalar_one_or_none()

        if existing is not None:
            if existing.deactivated_at is None:
                raise AlreadyAffiliate(f"{email_norm} is already an active affiliate.")
            # Reactivate previously-deactivated affiliate.
            existing.deactivated_at = None
            existing.invited_by = invited_by_client_id
            existing.max_active_codes = max_active_codes
            existing.commission_bps = commission_bps
            return {"kind": "instant", "affiliate": existing, "reactivated": True}

        row = Affiliate(
            client_id=client.id,
            invited_by=invited_by_client_id,
            max_active_codes=max_active_codes,
            commission_bps=commission_bps,
        )
        session.add(row)
        session.flush()
        return {"kind": "instant", "affiliate": row, "reactivated": False}

    # ── Path 2: stranger → create magic-link invite ─────────────────────
    # Block duplicate pending invites for the same email. Revoking the
    # prior invite first is the only way to resend with a fresh token.
    pending = session.execute(
        select(AffiliateInvite).where(
            AffiliateInvite.email == email_norm,
            AffiliateInvite.accepted_at.is_(None),
            AffiliateInvite.revoked_at.is_(None),
        )
    ).scalar_one_or_none()
    if pending is not None and pending.expires_at > datetime.now(UTC):
        raise InviteAlreadyPending(
            f"A pending invite already exists for {email_norm}. Revoke it first if you need to send a new one."
        )

    raw_token, token_hash = _generate_invite_token()
    invite = AffiliateInvite(
        email=email_norm,
        token_hash=token_hash,
        max_active_codes=max_active_codes,
        invited_by=invited_by_client_id,
        expires_at=datetime.now(UTC) + timedelta(days=INVITE_TTL_DAYS),
    )
    session.add(invite)
    session.flush()
    return {"kind": "pending_invite", "invite": invite, "raw_token": raw_token}


# ─── Magic-link invite lifecycle (used by /affiliate-invites/* endpoints) ────


def lookup_invite_by_token(session: Session, raw_token: str) -> AffiliateInvite:
    """Resolve a raw invite token to the AffiliateInvite row.

    Raises ``InviteNotFound`` if no row matches, ``InviteAlreadyUsed`` if
    the row was already accepted or revoked, or ``InviteExpired`` if past
    ``expires_at``. These three errors are deliberately separate so the
    UI can show distinct messages — "this link is invalid", "already
    accepted", or "expired, ask for a new one".
    """
    if not raw_token:
        raise InviteNotFound("Invalid invite link.")
    invite = session.execute(
        select(AffiliateInvite).where(AffiliateInvite.token_hash == _hash_token(raw_token))
    ).scalar_one_or_none()
    if invite is None:
        raise InviteNotFound("Invalid invite link.")
    if invite.accepted_at is not None:
        raise InviteAlreadyUsed("This invite has already been accepted.")
    if invite.revoked_at is not None:
        raise InviteAlreadyUsed("This invite has been revoked.")
    if invite.expires_at <= datetime.now(UTC):
        raise InviteExpired("This invite has expired. Ask the super admin to send a fresh one.")
    return invite


def accept_invite(
    session: Session,
    raw_token: str,
    *,
    name: str,
    password_hash: str,
    api_key: str,
    company_name: str | None = None,
    website: str | None = None,
) -> tuple[Client, Affiliate]:
    """Accept a magic-link invite — atomically create Client + Affiliate.

    The caller (route handler) is responsible for hashing the password and
    generating the api_key so this function stays free of crypto imports.

    Raises:
      InviteNotFound / InviteExpired / InviteAlreadyUsed — see lookup_invite_by_token
      AffiliateLimitReached — 5 active affiliates already exist by the
                              time the invite is accepted
    """
    invite = lookup_invite_by_token(session, raw_token)

    # Re-check the cap at accept-time. The invite was created when there
    # was room, but acceptance could happen days later after the program
    # filled up. Surface clearly rather than silently breaking the cap.
    if count_active_affiliates(session) >= MAX_ACTIVE_AFFILIATES:
        raise AffiliateLimitReached(
            f"Active affiliates are capped at {MAX_ACTIVE_AFFILIATES}. "
            "The program filled up before you accepted — contact support."
        )

    # Defensive: someone could have signed up with this email between
    # invite-creation and accept. Reject so we don't create a duplicate
    # Client row.
    existing_client = session.execute(select(Client).where(Client.email == invite.email)).scalar_one_or_none()
    if existing_client is not None:
        raise AlreadyAffiliate(
            "An account with this email already exists. Sign in instead, then ask "
            "support to enroll you in the affiliate program."
        )

    client = Client(
        name=name.strip(),
        email=invite.email,
        hashed_password=password_hash,
        api_key=api_key,
        company_name=(company_name or "").strip() or None,
        website=(website or "").strip() or None,
        is_superadmin=False,
    )
    session.add(client)
    session.flush()  # populate client.id

    affiliate = Affiliate(
        client_id=client.id,
        invited_by=invite.invited_by,
        max_active_codes=invite.max_active_codes,
    )
    session.add(affiliate)
    invite.accepted_at = datetime.now(UTC)
    session.flush()
    logger.info(
        "affiliate_invite_accepted",
        extra={"invite_id": invite.id, "client_id": client.id, "affiliate_id": affiliate.id},
    )
    return client, affiliate


def accept_invite_for_existing_client(
    session: Session,
    raw_token: str,
    client: Client,
) -> Affiliate:
    """Accept a magic-link invite for a CURRENTLY-LOGGED-IN client.

    Separate from ``accept_invite`` because the existing-client path doesn't
    create a new Client row — it just creates the Affiliate row tied to the
    one the caller is already authenticated as. The auth check happens at
    the route layer; this function trusts ``client`` is who they claim.

    The token's target email MUST match the client's email. We enforce this
    to prevent a logged-in attacker from redeeming someone else's invite by
    pasting their token. Returns 403 (via ``AffiliateProgramError`` subclass)
    on mismatch — separate from the not-found case so the UI can render
    "this invite is for X@example.com — sign in with that email instead".

    Raises:
      InviteNotFound / InviteExpired / InviteAlreadyUsed (token-state errors)
      InviteEmailMismatch (client doesn't own the invited email)
      AlreadyAffiliate (client is already an active affiliate)
      AffiliateLimitReached (5-affiliate cap hit between invite and accept)
    """
    invite = lookup_invite_by_token(session, raw_token)

    # Token-vs-caller email check — case-insensitive to mirror how email
    # comparison happens elsewhere in the auth layer.
    if (invite.email or "").strip().lower() != (client.email or "").strip().lower():
        raise InviteEmailMismatch(
            f"This invite was sent to {invite.email}. Sign in with that account, or contact sales to update the invite."
        )

    # Already enrolled? Treat as a soft success — the link was probably
    # clicked twice. Surfacing this distinctly lets the UI deep-link to the
    # dashboard with a "you're already a Partner" toast instead of an error.
    existing = session.execute(select(Affiliate).where(Affiliate.client_id == client.id)).scalars().first()
    if existing is not None and existing.deactivated_at is None:
        # Mark the invite consumed even though we didn't create a new row,
        # so a third click hits InviteAlreadyUsed. The mutation must be
        # COMMITTED before we raise — the outer session context-manager
        # rolls back on exception, so a plain assignment + raise would
        # silently lose the write and the invite would stay pending until
        # expiry, defeating the comment's promise.
        if invite.accepted_at is None:
            invite.accepted_at = datetime.now(UTC)
            session.commit()
        raise AlreadyAffiliate(f"{client.email} is already an active affiliate.")

    # Re-check the cap at accept-time.
    if count_active_affiliates(session) >= MAX_ACTIVE_AFFILIATES:
        raise AffiliateLimitReached(
            f"Active affiliates are capped at {MAX_ACTIVE_AFFILIATES}. "
            "The program filled up before you accepted — contact support."
        )

    affiliate = Affiliate(
        client_id=client.id,
        invited_by=invite.invited_by,
        max_active_codes=invite.max_active_codes,
    )
    session.add(affiliate)
    invite.accepted_at = datetime.now(UTC)
    session.flush()
    logger.info(
        "affiliate_invite_accepted_for_existing",
        extra={"invite_id": invite.id, "client_id": client.id, "affiliate_id": affiliate.id},
    )
    return affiliate


def revoke_invite(session: Session, invite_id: int) -> AffiliateInvite:
    """Mark a pending invite as revoked. Idempotent; already-revoked invites no-op."""
    invite = session.get(AffiliateInvite, invite_id)
    if invite is None:
        raise InviteNotFound("Invite not found.")
    if invite.accepted_at is not None:
        raise InviteAlreadyUsed("Cannot revoke an accepted invite.")
    if invite.revoked_at is None:
        invite.revoked_at = datetime.now(UTC)
    return invite


def list_pending_invites(session: Session) -> list[dict]:
    """Pending invites for the super-admin UI list. Excludes expired ones."""
    now = datetime.now(UTC)
    rows = (
        session.execute(
            select(AffiliateInvite)
            .where(
                AffiliateInvite.accepted_at.is_(None),
                AffiliateInvite.revoked_at.is_(None),
                AffiliateInvite.expires_at > now,
            )
            .order_by(AffiliateInvite.created_at.desc())
        )
        .scalars()
        .all()
    )
    return [
        {
            "id": r.id,
            "email": r.email,
            "max_active_codes": r.max_active_codes,
            "invited_by": r.invited_by,
            "expires_at": r.expires_at.isoformat() if r.expires_at else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


def list_affiliates(session: Session, *, include_deactivated: bool = True) -> list[dict]:
    """Return all affiliates with high-level stats (super-admin view)."""
    stmt = select(Affiliate).order_by(
        Affiliate.deactivated_at.is_(None).desc(),
        Affiliate.created_at.desc(),
    )
    if not include_deactivated:
        stmt = stmt.where(Affiliate.deactivated_at.is_(None))

    affiliates = session.execute(stmt).scalars().all()
    out = []
    for aff in affiliates:
        client = session.get(Client, aff.client_id)
        stats = get_affiliate_stats(session, aff.id)
        out.append(
            {
                "id": aff.id,
                "client_id": aff.client_id,
                "client_email": client.email if client else None,
                "client_name": client.name if client else None,
                "max_active_codes": aff.max_active_codes,
                "commission_bps": aff.commission_bps,
                "commission_pct": bps_to_pct(aff.commission_bps),
                "invited_by": aff.invited_by,
                "created_at": aff.created_at.isoformat() if aff.created_at else None,
                "deactivated_at": (aff.deactivated_at.isoformat() if aff.deactivated_at else None),
                "active": aff.deactivated_at is None,
                **stats,
            }
        )
    return out


def get_affiliate_detail(session: Session, affiliate_id: int) -> dict:
    """Per-affiliate detail bundle for the super-admin drill-down view."""
    aff = session.get(Affiliate, affiliate_id)
    if aff is None:
        raise NotAffiliate("Affiliate not found.")
    client = session.get(Client, aff.client_id)
    return {
        "id": aff.id,
        "client_id": aff.client_id,
        "client_email": client.email if client else None,
        "client_name": client.name if client else None,
        "max_active_codes": aff.max_active_codes,
        "commission_bps": aff.commission_bps,
        "commission_pct": bps_to_pct(aff.commission_bps),
        "invited_by": aff.invited_by,
        "active": aff.deactivated_at is None,
        "created_at": aff.created_at.isoformat() if aff.created_at else None,
        "deactivated_at": aff.deactivated_at.isoformat() if aff.deactivated_at else None,
        "codes": list_codes_with_stats(session, aff.id),
        "stats": get_affiliate_stats(session, aff.id),
    }


def update_affiliate(
    session: Session,
    affiliate_id: int,
    *,
    max_active_codes: int | None = None,
    commission_bps: int | None = None,
    deactivate: bool | None = None,
) -> Affiliate:
    """Super-admin override of an affiliate's caps, commission, + active status.

    Deactivating an affiliate also deactivates every still-active code they
    own, but leaves their referred clients' ``referral_code_id`` intact so
    historical attribution is never lost.

    ``commission_bps`` is in basis points (0–10000). The route layer
    accepts whole-percent input from the super-admin UI and converts via
    ``pct_to_bps`` before calling here.
    """
    aff = session.get(Affiliate, affiliate_id)
    if aff is None:
        raise NotAffiliate("Affiliate not found.")

    if max_active_codes is not None:
        if max_active_codes <= 0:
            raise AffiliateProgramError("max_active_codes must be positive.")
        aff.max_active_codes = max_active_codes

    if commission_bps is not None:
        if commission_bps < 0 or commission_bps > MAX_COMMISSION_BPS:
            raise AffiliateProgramError("Commission must be between 0% and 100%.")
        # Reducing the pool to below the total committed by an existing
        # code would leave that code paying out more than the affiliate
        # is allowed to earn — silently honouring it is how programs lose
        # money. We refuse the reduction and list the conflicting codes
        # so the admin can deactivate or shrink them first.
        current_pool = int(aff.commission_bps or 0)
        if commission_bps < current_pool:
            conflicting = (
                session.execute(
                    select(ReferralCode).where(
                        ReferralCode.affiliate_id == aff.id,
                        ReferralCode.active.is_(True),
                        (ReferralCode.affiliate_commission_bps + ReferralCode.customer_discount_bps) > commission_bps,
                    )
                )
                .scalars()
                .all()
            )
            if conflicting:
                names = ", ".join(c.code for c in conflicting[:5])
                more = "" if len(conflicting) <= 5 else f" (and {len(conflicting) - 5} more)"
                new_pct = bps_to_pct(commission_bps)
                raise CommissionSplitExceedsPool(
                    f"Cannot reduce pool to {new_pct}% — {len(conflicting)} active code(s) "
                    f"already commit a higher split: {names}{more}. "
                    "Deactivate or shrink those codes first, then retry the pool change."
                )
        aff.commission_bps = commission_bps

    if deactivate is True and aff.deactivated_at is None:
        aff.deactivated_at = func.now()
        # Cascade: deactivate every active code under this affiliate.
        session.execute(
            update(ReferralCode)
            .where(
                ReferralCode.affiliate_id == aff.id,
                ReferralCode.active.is_(True),
            )
            .values(active=False, deactivated_at=func.now())
        )
    elif deactivate is False and aff.deactivated_at is not None:
        # Reactivate the affiliate but do NOT auto-reactivate their codes —
        # that's an explicit per-code action so they can pick which to bring back.
        if count_active_affiliates(session) >= MAX_ACTIVE_AFFILIATES:
            raise AffiliateLimitReached("Cannot reactivate — the 5-seat active-affiliate cap is full.")
        aff.deactivated_at = None

    return aff


def delete_affiliate(session: Session, affiliate_id: int) -> None:
    """Hard-delete an affiliate, all their codes, and the entire click history.

    Cascading cleanup order matters because the FK from ``referral_codes`` to
    ``affiliates`` is ``ON DELETE RESTRICT`` (intentional — we never want
    accidental loss). We explicitly delete codes first; their child
    ``referral_clicks`` rows cascade automatically via that FK
    (``ON DELETE CASCADE``), and any ``clients`` rows that point at one of
    those codes get their ``referral_code_id`` set to NULL automatically
    (``ON DELETE SET NULL``).

    Effect on referred clients:
      - They are NOT deleted — the customer relationship survives.
      - Their ``referral_code_id`` becomes NULL, so historical attribution
        is irreversibly lost from their row. This is the deliberate
        trade-off for a clean removal.

    Raises:
      NotAffiliate — when ``affiliate_id`` doesn't exist
    """
    aff = session.get(Affiliate, affiliate_id)
    if aff is None:
        raise NotAffiliate("Affiliate not found.")

    # Wipe codes (cascade fans out to clicks; nulls out clients).
    session.execute(delete(ReferralCode).where(ReferralCode.affiliate_id == affiliate_id))
    session.delete(aff)
    logger.info(
        "affiliate_deleted",
        extra={"affiliate_id": affiliate_id, "client_id": aff.client_id},
    )
