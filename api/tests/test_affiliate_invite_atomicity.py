"""Affiliate invite acceptance transaction boundary — remediation H3 (real PG).

``accept_invite_for_existing_client`` marks an invite consumed even on the
already-an-affiliate branch. It must persist ONLY that mark — it must not
``session.commit()`` the caller's session, which would commit whatever other
pending work the request had staged. The mark is written in its own
transaction (on the same engine) so it survives the caller's rollback without
hijacking the caller's transaction boundary.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db.models import Affiliate, AffiliateInvite, Bot, Client
from app.services import affiliate_service as svc

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="affiliate invite atomicity tests need a reachable Postgres at DB_URL",
)


def test_already_affiliate_branch_does_not_commit_callers_pending_work(db):
    client = Client(name="a", email="aff@e.com", api_key="aff", hashed_password="h")
    db.add(client)
    db.flush()
    db.add(Affiliate(client_id=client.id))  # already an active affiliate
    raw = "tok_h3_abc"
    db.add(
        AffiliateInvite(
            email="aff@e.com",
            token_hash=svc._hash_token(raw),
            expires_at=datetime.now(UTC) + timedelta(days=7),
        )
    )
    db.commit()

    # The caller has UNRELATED pending work staged but not committed.
    db.add(Bot(client_id=client.id, bot_key="bot-h3-uncommitted", name="X", is_legacy_pooled=False))
    db.flush()

    with pytest.raises(svc.AlreadyAffiliate):
        svc.accept_invite_for_existing_client(db, raw, client)

    # The caller would roll back on the raised exception. The service must NOT
    # have committed the caller's pending bot.
    db.rollback()
    leaked = db.execute(select(Bot).where(Bot.bot_key == "bot-h3-uncommitted")).scalars().first()
    assert leaked is None

    # …but the invite WAS marked consumed (persisted in its own transaction).
    inv = (
        db.execute(select(AffiliateInvite).where(AffiliateInvite.token_hash == svc._hash_token(raw))).scalars().first()
    )
    assert inv is not None
    assert inv.accepted_at is not None
