"""Crawl auto-fill lock: ``_reconcile_manual_overrides``.

Company info (and brand tone) auto-fill from the website crawl. Once a customer
hand-edits one of those fields it must be *locked* so a re-crawl leaves it
alone; clearing the field and saving *unlocks* it so the next crawl re-fills it.
The lock state lives in ``Bot.manual_field_overrides`` and is reconciled from
each settings PATCH by comparing the submitted value against the stored one.
"""

from types import SimpleNamespace

from app.api.bot_routes import _reconcile_manual_overrides


def _bot(company_name=None, company_description=None, brand_tone=None, overrides=None):
    return SimpleNamespace(
        company_name=company_name,
        company_description=company_description,
        brand_tone=brand_tone,
        manual_field_overrides=list(overrides or []),
    )


def test_manual_edit_locks_field():
    """Changing an auto value to a new non-empty value locks it."""
    bot = _bot(company_name="Acme Inc")  # auto-filled, unlocked
    _reconcile_manual_overrides(bot, {"company_name": "Acme Corporation"})
    assert bot.manual_field_overrides == ["company_name"]


def test_typing_into_empty_field_locks_it():
    """A brand-new manual value (no prior crawl) locks the field."""
    bot = _bot(company_name=None)
    _reconcile_manual_overrides(bot, {"company_name": "Acme Inc"})
    assert bot.manual_field_overrides == ["company_name"]


def test_clearing_field_unlocks_it():
    """Clearing a locked field re-enables auto-fill on the next crawl."""
    bot = _bot(company_name="Acme Corporation", overrides=["company_name"])
    _reconcile_manual_overrides(bot, {"company_name": ""})
    assert bot.manual_field_overrides == []


def test_clearing_with_none_unlocks_it():
    """The admin app sends ``null`` for a cleared field. Treated as empty."""
    bot = _bot(company_name="Acme Corporation", overrides=["company_name"])
    _reconcile_manual_overrides(bot, {"company_name": None})
    assert bot.manual_field_overrides == []


def test_unchanged_value_does_not_lock():
    """Saving unrelated settings resubmits the same auto value verbatim; the
    field must stay unlocked so the crawl keeps refreshing it."""
    bot = _bot(company_name="Acme Inc")  # unlocked auto value
    _reconcile_manual_overrides(bot, {"company_name": "Acme Inc"})
    assert bot.manual_field_overrides == []


def test_unchanged_value_keeps_existing_lock():
    """Resubmitting a locked value unchanged must keep it locked."""
    bot = _bot(company_name="Acme Corporation", overrides=["company_name"])
    _reconcile_manual_overrides(bot, {"company_name": "Acme Corporation"})
    assert bot.manual_field_overrides == ["company_name"]


def test_whitespace_only_change_is_ignored():
    """Trailing whitespace is not a meaningful edit; the field stays unlocked."""
    bot = _bot(company_name="Acme Inc")
    _reconcile_manual_overrides(bot, {"company_name": "  Acme Inc  "})
    assert bot.manual_field_overrides == []


def test_all_three_fields_tracked_independently():
    bot = _bot(company_name="Acme", company_description="desc", brand_tone="formal")
    _reconcile_manual_overrides(
        bot,
        {"company_name": "Acme Corp", "company_description": "desc", "brand_tone": ""},
    )
    assert bot.manual_field_overrides == ["company_name"]


def test_fields_absent_from_patch_are_untouched():
    """A patch that omits an auto-fill field must not change its lock state."""
    bot = _bot(brand_tone="custom", overrides=["brand_tone"])
    # `system_prompt`, not `primary_color`: the colour used to be the example of
    # an untracked field here, and it is now tracked, so it no longer tests what
    # this is about.
    _reconcile_manual_overrides(bot, {"system_prompt": "You are helpful."})
    assert bot.manual_field_overrides == ["brand_tone"]


def test_non_tracked_field_never_locked():
    """Only the crawl-auto-filled fields are tracked.

    `bot_logo` is the notable exclusion (see `config.py`): the avatar records
    provenance in its own `bot_logo_source` column instead.
    """
    bot = _bot()
    _reconcile_manual_overrides(bot, {"system_prompt": "You are helpful."})
    assert bot.manual_field_overrides == []


class TestPrimaryColourIsTracked:
    """The brand colour is auto-filled by the crawl, so it needs the same lock.

    It was missing from ``_AUTO_FILL_FIELDS`` while the crawl wrote it anyway
    (``crawl_orchestrator`` sets ``primary_color`` from the extracted palette),
    which broke two things at once:

    * The crawler's own first guard, ``"primary_color" not in overrides``, could
      never fire. A customer's chosen colour survived a re-crawl only because of
      the SECOND guard -- "still the seeded default" -- which has a hole: pick
      the default hex deliberately and the next crawl repaints over you.
    * Nothing recorded that a human had chosen a colour, so the setup
      checklist's "Customise your chatbot" step read `primary_color != default`
      and struck itself through on a chatbot whose colour the CRAWL had set. The
      product did the work and then congratulated the customer for it -- the
      same defect that ``bot_logo_source`` was added to fix for the avatar.
    """

    def _bot(self, colour=None, overrides=None):
        return SimpleNamespace(
            company_name=None,
            company_description=None,
            brand_tone=None,
            primary_color=colour,
            manual_field_overrides=list(overrides or []),
        )

    def test_choosing_a_colour_locks_it(self):
        bot = self._bot(colour="#0c1e2e")  # crawl-derived, unlocked
        _reconcile_manual_overrides(bot, {"primary_color": "#ff6600"})
        assert bot.manual_field_overrides == ["primary_color"]

    def test_resubmitting_the_same_colour_locks_nothing(self):
        # Saving an unrelated field on the Experience page posts the whole form.
        # An unchanged colour is not a choice and must not lock.
        bot = self._bot(colour="#0c1e2e")
        _reconcile_manual_overrides(bot, {"primary_color": "#0c1e2e"})
        assert bot.manual_field_overrides == []

    def test_a_patch_without_the_colour_leaves_the_lock_alone(self):
        bot = self._bot(colour="#ff6600", overrides=["primary_color"])
        _reconcile_manual_overrides(bot, {"company_name": "Acme"})
        assert "primary_color" in bot.manual_field_overrides

    def test_clearing_the_colour_unlocks_it(self):
        # Same convention as the other tracked fields: emptying hands the field
        # back to the crawl.
        bot = self._bot(colour="#ff6600", overrides=["primary_color"])
        _reconcile_manual_overrides(bot, {"primary_color": ""})
        assert bot.manual_field_overrides == []

    def test_deliberately_picking_the_seeded_colour_still_locks(self):
        # The hole in the "still default" heuristic. Someone who looks at the
        # palette and decides the default violet is right has chosen, and a
        # re-crawl must not overrule them.
        bot = self._bot(colour="#0c1e2e", overrides=[])
        _reconcile_manual_overrides(bot, {"primary_color": "#a21caf"})
        assert bot.manual_field_overrides == ["primary_color"]
