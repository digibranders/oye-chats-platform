"""Provider-agnostic discount resolution.

Resolves a client's effective customer discount to basis points by reading
the referral code attached at signup. The result is then realised by the
provider layer:

  Razorpay → razorpay_service.resolve_discounted_plan()
             (creates / reuses a lower-amount Razorpay plan)

Nothing here imports razorpay; this module is safe to call on
any provider path.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.db.models import Client, ReferralCode


def resolve_customer_discount_bps(session: Session, client: Client) -> tuple[int, dict | None]:
    """Return (discount_bps, audit_meta) for the client's referral code.

    Returns (0, None) when:
    - The client has no referral code attached.
    - The code row no longer exists (deleted after attribution).
    - The code is deactivated.
    - The code carries no customer discount (customer_discount_bps == 0).

    ``audit_meta`` is a string-valued dict suitable for snapshotting into
    a ReferralConversion row. All values are strings so they're safe to
    store in JSONB notes without further coercion.
    """
    code_id = getattr(client, "referral_code_id", None)
    if not code_id:
        return 0, None

    code = session.get(ReferralCode, code_id)
    if code is None or not code.active or not code.customer_discount_bps:
        return 0, None

    return int(code.customer_discount_bps), {
        "referral_code_id": str(code.id),
        "referral_code": code.code,
        "affiliate_id": str(code.affiliate_id),
        "discount_bps": str(code.customer_discount_bps),
        "affiliate_commission_bps": str(code.affiliate_commission_bps),
    }


def resolve_referral_conversion_snapshot(session: Session, client: Client) -> dict | None:
    """Return a snapshot of the client's active referral attribution, or None.

    Unlike :func:`resolve_customer_discount_bps`, this does NOT gate on a
    non-zero customer discount: a COMMISSION-ONLY code (``customer_discount_bps
    == 0`` — the affiliate still earns a pool cut, the customer just gets no
    discount) is a real referral conversion and must be recorded, otherwise the
    super-admin referral-conversions view systematically undercounts (finding
    MED-2). Returns ``None`` only when there is no active attributed code (no
    attribution, the code was deleted, or it's deactivated).

    Values are strings so they can be snapshotted without further coercion,
    mirroring ``resolve_customer_discount_bps``'s ``audit_meta`` shape.
    """
    code_id = getattr(client, "referral_code_id", None)
    if not code_id:
        return None

    code = session.get(ReferralCode, code_id)
    if code is None or not code.active:
        return None

    return {
        "referral_code_id": str(code.id),
        "referral_code": code.code,
        "affiliate_id": str(code.affiliate_id),
        "discount_bps": str(code.customer_discount_bps or 0),
        "affiliate_commission_bps": str(code.affiliate_commission_bps or 0),
    }
