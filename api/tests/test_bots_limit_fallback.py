"""The Free fallback must carry a `bots` limit.

Not because losing the key would open the creation gate — it fails CLOSED.
`limit_for` answers 0 for a missing key, so `within_limit("bots", n)` becomes
`n < 0`, false for every n, and `bot_routes._plan_bots_limit_allows` simply
never widens the per-bot-billing default. A plan-less account keeps the one
free agent `can_client_add_new_bot` grants it and buys every later agent
through per-bot checkout, exactly as a `bots: 1` plan does.

What the key really guards is this constant's job: standing in for the seeded
Free plan whenever no plan row resolves. Drop it and `/me/entitlements` ships a
`limits` dict with no agent quota, so the dashboard's mirror of the gate
(`app/src/features/agents/agentLimit.ts`) reads 0 and stops telling the user
what their plan includes — and the fallback no longer matches the plan it
claims to mirror.
"""

from __future__ import annotations

from app.services.plan_entitlements_service import _FREE_FALLBACK_LIMITS


def test_free_fallback_caps_bots_at_one():
    assert _FREE_FALLBACK_LIMITS["bots"] == 1
