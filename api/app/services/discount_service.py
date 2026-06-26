"""Provider-agnostic discount resolution.

Resolves a client's effective customer discount to basis points by reading
the referral code attached at signup. The result is then realised by the
provider layer:

  Razorpay → razorpay_service.resolve_discounted_plan()
             (creates / reuses a lower-amount Razorpay plan)
  Stripe   → billing_service._ensure_referral_coupon()
             (creates / reuses a Stripe coupon) — Phase 4

Nothing here imports razorpay or stripe; this module is safe to call on
any provider path.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.db.models import Client, ReferralCode


def resolve_customer_discount_bps(
    session: Session, client: Client
) -> tuple[int, dict | None]:
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
        "discount_bps": str(code.customer_discount_bps),
        "affiliate_commission_bps": str(code.affiliate_commission_bps),
    }
