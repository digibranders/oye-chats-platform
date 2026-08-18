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
    _reconcile_manual_overrides(bot, {"primary_color": "#000000"})
    assert bot.manual_field_overrides == ["brand_tone"]


def test_non_tracked_field_never_locked():
    """Only company_name/description/brand_tone are tracked."""
    bot = _bot()
    _reconcile_manual_overrides(bot, {"system_prompt": "You are helpful."})
    assert bot.manual_field_overrides == []
