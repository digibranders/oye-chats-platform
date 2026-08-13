"""The Free fallback must carry a `bots` limit.

The creation gate keys off `limit_for("bots")`. If the fallback ever loses this
key the gate silently becomes UNLIMITED for any account with no plan row.
"""

from __future__ import annotations

from app.services.plan_entitlements_service import _FREE_FALLBACK_LIMITS


def test_free_fallback_caps_bots_at_one():
    assert _FREE_FALLBACK_LIMITS["bots"] == 1
