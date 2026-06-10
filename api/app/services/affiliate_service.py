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

from app.db.models import Affiliate, AffiliateInvite, Client, ReferralClick, ReferralCode

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


def pct_to_bps(pct: int | float | None) -> int | None:
    """Convert a human percentage (0–100, possibly decimal) to basis points.

    Returns ``None`` if input is ``None`` (caller wants to skip the update).
    Raises ``ValueError`` on out-of-range input — surfaced as a 400 at the
    route layer. We round half-up to the nearest bps so 12.345% → 1234 bps.
    """
    if pct is None:
        return None
    if pct < 0 or pct > 100:
        raise ValueError("Commission percentage must be between 0 and 100.")
    return int(round(float(pct) * 100))


def bps_to_pct(bps: int | None) -> float | None:
    """Convert basis points back to a human percentage (one decimal)."""
    if bps is None:
        return None
    return round(bps / 100, 2)


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
