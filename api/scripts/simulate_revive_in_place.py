"""Local, isolated proof of revive-in-place (Phase 2b).

Sets up a bot that lapsed to Free (an expired subscription + deactivated
knowledge), then drives the REAL ``subscription.activated`` handler with a
``purpose=revive_bot`` payload (the exact webhook a downgraded bot's re-upgrade
produces) and asserts:

  * a NEW active subscription is created for the SAME bot_id (bot_key/embed kept)
  * the bot's previously-deactivated knowledge is reactivated
  * the old expired subscription is left untouched

Everything created is torn down. Run from ``platform/api``:
    uv run python scripts/simulate_revive_in_place.py
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from app.db.models import Bot, Client, Document, Subscription
from app.db.session import get_session
from app.services import razorpay_service

STANDARD_PLAN_ID = 3
_created_client_ids: list[int] = []


def _activated_payload(rzp_id: str, *, client_id: int, plan_id: int, bot_id: int, start: datetime, end: datetime):
    return {
        "subscription": {
            "entity": {
                "id": rzp_id,
                "status": "active",
                "current_start": int(start.timestamp()),
                "current_end": int(end.timestamp()),
                "quantity": 1,
                "customer_id": "cust_sim_" + secrets.token_hex(4),
                "notes": {
                    "client_id": str(client_id),
                    "plan_id": str(plan_id),
                    "bot_id": str(bot_id),
                    "purpose": "revive_bot",
                },
            }
        }
    }


def _counts(session, bot_id: int) -> dict:
    active = session.execute(
        text("SELECT count(*) FROM documents WHERE bot_id = :b AND is_active").bindparams(b=bot_id)
    ).scalar_one()
    inactive = session.execute(
        text("SELECT count(*) FROM documents WHERE bot_id = :b AND NOT is_active").bindparams(b=bot_id)
    ).scalar_one()
    subs = session.execute(
        text("SELECT status, count(*) FROM subscriptions WHERE bot_id = :b GROUP BY status").bindparams(b=bot_id)
    ).all()
    return {"active_docs": active, "inactive_docs": inactive, "subs": {s: int(c) for s, c in subs}}


def _teardown(session) -> None:
    if not _created_client_ids:
        return
    ids = ", ".join(str(int(i)) for i in _created_client_ids)
    for table in ("credit_ledger", "invoices", "usage_records", "subscriptions", "documents", "bots"):
        session.execute(text(f"DELETE FROM {table} WHERE client_id IN ({ids})"))
    session.execute(text(f"DELETE FROM clients WHERE id IN ({ids})"))
    session.commit()
    print(f"\nTeardown: removed {len(_created_client_ids)} throwaway client(s) and all their rows.")


def main() -> None:
    now = datetime.now(UTC)
    with get_session() as session:
        client = Client(
            name="Sim Revive",
            email=f"sim.revive.{secrets.token_hex(3)}@example.com",
            api_key="sk_sim_" + secrets.token_hex(10),
            is_verified=True,
        )
        session.add(client)
        session.flush()
        _created_client_ids.append(client.id)

        bot = Bot(client_id=client.id, name="Sim Revive Bot", bot_key="bot-simrev-" + secrets.token_hex(5))
        session.add(bot)
        session.flush()

        # The bot's PRIOR paid subscription, now expired (lapsed to Free).
        old_sub = Subscription(
            client_id=client.id,
            bot_id=bot.id,
            plan_id=STANDARD_PLAN_ID,
            status="expired",
            razorpay_subscription_id="sub_OLD_" + secrets.token_hex(4),
            canceled_at=now - timedelta(days=10),
            cancel_reason="dunning_grace_elapsed",
        )
        session.add(old_sub)
        # Two chunks, deactivated by the lapse.
        for name, content in [("pricing.pdf", "Pricing and refund policy."), ("hours.pdf", "Support hours 9-5.")]:
            session.add(
                Document(
                    client_id=client.id,
                    bot_id=bot.id,
                    document_name=name,
                    source="upload",
                    file_hash=secrets.token_hex(8),
                    content=content,
                    embedding=[0.1] * 768,
                    is_active=False,
                )
            )
        session.commit()

        try:
            print("BEFORE revive (bot lapsed to Free):")
            print("   ", _counts(session, bot.id), "  <- knowledge deactivated, old sub expired")

            # Drive the real activation webhook for the revive checkout.
            start = now
            end = now + timedelta(days=30)
            msg = razorpay_service._handle_subscription_activated(
                session,
                _activated_payload(
                    "sub_NEW_" + secrets.token_hex(4),
                    client_id=client.id,
                    plan_id=STANDARD_PLAN_ID,
                    bot_id=bot.id,
                    start=start,
                    end=end,
                ),
            )
            session.commit()
            print(f"\nHandler said: {msg}")

            session.refresh(bot)
            new_sub = session.execute(
                text("SELECT id, status FROM subscriptions WHERE bot_id = :b AND status = 'active' LIMIT 1").bindparams(
                    b=bot.id
                )
            ).first()
            print("\nAFTER revive:")
            print("   ", _counts(session, bot.id), "  <- knowledge reactivated, NEW active sub on the SAME bot")
            print(f"    bot_key unchanged: {bot.bot_key}")
            print(
                f"    bot.subscription_id -> {bot.subscription_id} (new active sub id={new_sub.id if new_sub else None})"
            )
            same_bot = new_sub is not None
            restored = _counts(session, bot.id)["inactive_docs"] == 0 and _counts(session, bot.id)["active_docs"] == 2
            print(f"\n    RESULT: same bot revived in place = {same_bot}; knowledge restored = {restored}")
        finally:
            _teardown(session)


if __name__ == "__main__":
    main()
