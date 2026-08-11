"""Everything `/bot/settings` publishes must survive the Redis cache.

`get_current_bot` serves a cache HIT by rebuilding a detached `Bot` from a
dict (`_bot_from_cache_dict`), and that rebuild starts from a bare `Bot()`.
SQLAlchemy's `default=True` is an INSERT-time default, NOT an attribute
default, so any column `_bot_to_cache_dict` forgets comes back as `None` —
and `bool(None)` is `False`.

That is not a stale value that a TTL eventually corrects. It is permanently
wrong on every cache hit, and it fails in the most misleading direction: a
boolean that means "this customer enabled a paid feature" reads as disabled.

`email_verification_enabled` shipped omitted, and `company_lookup_enabled`
was then added the same way. The class matters more than the two fields, so
the last test here compares the serialized keys against what the settings
endpoint actually reads, and fails for the NEXT one somebody forgets.
"""

from __future__ import annotations

import inspect
import re

from app.api import auth, bot_routes
from app.db.models import Bot


def _bot(**overrides) -> Bot:
    bot = Bot(
        id=1,
        client_id=1,
        bot_key="bot-cache1",
        name="Cache Bot",
        is_active=True,
        email_verification_enabled=True,
        company_lookup_enabled=True,
    )
    for key, value in overrides.items():
        setattr(bot, key, value)
    return bot


def test_a_bare_bot_has_no_attribute_default():
    """The premise. If this ever stops being true the bug class disappears —
    but today an unserialized boolean column is None, not its column default."""
    assert Bot().company_lookup_enabled is None
    assert Bot().email_verification_enabled is None


def test_the_enrichment_toggles_survive_a_cache_round_trip():
    restored = auth._bot_from_cache_dict(auth._bot_to_cache_dict(_bot()))

    assert restored.email_verification_enabled is True
    assert restored.company_lookup_enabled is True


def test_a_toggle_turned_off_also_survives():
    """Both directions: an omitted field happens to look like OFF, so a test
    that only checks the ON case would pass on a half-broken serializer."""
    restored = auth._bot_from_cache_dict(
        auth._bot_to_cache_dict(_bot(email_verification_enabled=False, company_lookup_enabled=False))
    )

    assert restored.email_verification_enabled is False
    assert restored.company_lookup_enabled is False


def test_every_bot_field_the_settings_endpoint_publishes_is_cached():
    """The general guard.

    Reads the source of the public bot-settings handler, extracts every
    `bot.<attr>` it touches, and asserts each one is serialized. Adding a
    field to that response without adding it to the cache dict fails here
    instead of silently publishing `false` on every cache hit.
    """
    source = inspect.getsource(bot_routes.get_bot_settings_public)
    read_by_endpoint = set(re.findall(r"\bbot\.([a-z_][a-z0-9_]*)\b", source))
    cache_src = inspect.getsource(auth._bot_to_cache_dict)
    # Two access forms are in use — `bot.x` and `getattr(bot, "x", default)`.
    # Matching only the first made this test cry wolf about a field that was
    # cached all along.
    cached = set(re.findall(r'"([a-z_][a-z0-9_]*)":\s*[^,\n]*\bbot\.', cache_src))
    cached |= set(re.findall(r'getattr\(\s*bot\s*,\s*"([a-z_][a-z0-9_]*)"', cache_src))

    # Only real mapped columns — the handler also calls helpers off `bot`.
    columns = {c.key for c in Bot.__table__.columns}
    missing = (read_by_endpoint & columns) - cached

    assert not missing, (
        f"/bot/settings reads {sorted(missing)} off the Bot, but _bot_to_cache_dict does not "
        "serialize them. On a Redis cache hit these come back as None — a boolean reads as "
        "False, so a customer's enabled feature is published as disabled, permanently."
    )


def test_datetime_fields_round_trip_as_datetimes_not_strings():
    """`cache_set` JSON-dumps with `default=str`, so an un-encoded datetime
    silently comes back as a string. `created_at` was already handled
    explicitly; `widget_installed_at` is the second one and needs the same."""
    from datetime import UTC, datetime

    stamped = datetime(2026, 7, 1, 12, 0, tzinfo=UTC)
    restored = auth._bot_from_cache_dict(auth._bot_to_cache_dict(_bot(created_at=stamped, widget_installed_at=stamped)))

    assert isinstance(restored.created_at, datetime)
    assert isinstance(restored.widget_installed_at, datetime)
    assert restored.widget_installed_at == stamped


def test_an_uninstalled_widget_stays_none_through_the_cache():
    """The install-stamp branch in `get_bot_settings_public` keys on `is None`.
    If a cache hit turned that into the string "None" the branch would stop
    firing for a genuinely uninstalled widget — the opposite failure."""
    restored = auth._bot_from_cache_dict(auth._bot_to_cache_dict(_bot(widget_installed_at=None)))
    assert restored.widget_installed_at is None
