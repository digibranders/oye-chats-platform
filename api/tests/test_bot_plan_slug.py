"""`Bot.plan_slug` — the per-agent plan the admin UI gates on.

Billing attaches to the Bot, so one workspace holds a Professional agent and a
Free agent at the same time. The admin dashboard's per-agent feature gates
(Advanced → Lead enrichment, the Leads Visitor-Intelligence panel) need THIS
agent's answer, and account-level entitlements deliberately report the
highest-priced plan across the workspace.

The frontend used to infer the per-agent slug from the credit-balance payload,
which lists only agents holding their own ledger — a Free agent has none, so it
was absent and silently fell back to the account slug, rendering paid controls
on exactly the agent the fallback existed to protect. Serving the slug from the
same `get_bot_entitlements` the server's own gates use removes the inference.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from app.api.bot_routes import bot_plan, bot_plan_slug


def _entitlements(slug, name="Professional"):
    return MagicMock(plan_slug=slug, plan_name=name)


class TestBotPlanSlug:
    def test_returns_the_agents_own_plan(self):
        with patch(
            "app.services.plan_entitlements_service.get_bot_entitlements",
            return_value=_entitlements("professional"),
        ):
            assert bot_plan_slug(1, MagicMock()) == "professional"

    def test_lowercases_so_slug_comparisons_hold(self):
        """Gates compare against literal `'professional'`; a stored
        `'Professional'` must not read as a different plan."""
        with patch(
            "app.services.plan_entitlements_service.get_bot_entitlements",
            return_value=_entitlements("Professional"),
        ):
            assert bot_plan_slug(1, MagicMock()) == "professional"

    def test_a_lookup_failure_reads_as_free(self):
        """Fail closed. A resolution error that read as a paid tier would open
        every per-agent gate in the dashboard at once."""
        with patch(
            "app.services.plan_entitlements_service.get_bot_entitlements",
            side_effect=RuntimeError("entitlements down"),
        ):
            assert bot_plan_slug(1, MagicMock()) == "free"

    def test_a_non_string_slug_reads_as_free(self):
        """`or "free"` alone would pass a stub or a bad row straight through to
        the response, where no slug comparison can ever match it."""
        with patch(
            "app.services.plan_entitlements_service.get_bot_entitlements",
            return_value=_entitlements(MagicMock()),
        ):
            assert bot_plan_slug(1, MagicMock()) == "free"

    def test_a_missing_slug_reads_as_free(self):
        with patch(
            "app.services.plan_entitlements_service.get_bot_entitlements",
            return_value=_entitlements(None),
        ):
            assert bot_plan_slug(1, MagicMock()) == "free"


class TestBotPlanName:
    """The chip and the switch come from one call, so they cannot disagree.

    `useSelectedBotPlan` derived the display name from the credit-balance
    payload — the same source that omits Free agents — so a Free agent sat
    under a "Professional" chip while its controls were (correctly) locked.
    """

    def test_returns_the_agents_own_plan_name(self):
        with patch(
            "app.services.plan_entitlements_service.get_bot_entitlements",
            return_value=_entitlements("professional", "Professional"),
        ):
            assert bot_plan(1, MagicMock()) == ("professional", "Professional")

    def test_a_lookup_failure_reads_as_free(self):
        with patch(
            "app.services.plan_entitlements_service.get_bot_entitlements",
            side_effect=RuntimeError("entitlements down"),
        ):
            assert bot_plan(1, MagicMock()) == ("free", "Free")

    def test_a_non_string_name_reads_as_free(self):
        with patch(
            "app.services.plan_entitlements_service.get_bot_entitlements",
            return_value=_entitlements("professional", MagicMock()),
        ):
            assert bot_plan(1, MagicMock()) == ("professional", "Free")
