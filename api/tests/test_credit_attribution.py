"""`attributed_bot_id` — which bot spent the credits, independent of scope.

`bot_id` is the SCOPE key (NULL = shared client pool) and balance maths keys
off it. This column is for reporting only and must never affect a balance.
"""

from __future__ import annotations

from app.db.models import CreditLedger


def test_ledger_has_attributed_bot_id_column():
    assert hasattr(CreditLedger, "attributed_bot_id")


def test_attributed_bot_id_is_nullable_and_indexed():
    col = CreditLedger.__table__.columns["attributed_bot_id"]
    assert col.nullable is True
    assert col.index is True
