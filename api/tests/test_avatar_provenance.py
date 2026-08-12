"""`bots.bot_logo_source` — who last set the agent's avatar.

`bot_logo IS NULL` cannot distinguish an agent nobody has touched from one
whose owner deliberately removed the picture. Both are an empty slot, so the
crawl's favicon step read a deletion as an invitation and re-derived the avatar
the customer had just deleted — and there was no way to say no, because
`avatar_type` stays `upload` either way and the removal was recorded nowhere.

The stamp is what closes that. Every customer write to the avatar marks the
field theirs, INCLUDING clearing it, and derivation only runs while the stamp
is NULL.
"""

from __future__ import annotations

import os

import pytest

from app.db.models import Bot, Client
from app.db.repository import AVATAR_SOURCE_DERIVED, AVATAR_SOURCE_MANUAL, stamp_manual_avatar

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _bot(db, bot_id: int, **overrides) -> Bot:
    db.add(Client(id=bot_id, email=f"prov{bot_id}@example.com", name="C", api_key=f"provkey{bot_id}"))
    db.flush()
    bot = Bot(id=bot_id, client_id=bot_id, bot_key=f"bot-prov{bot_id}", name="B", is_active=True, **overrides)
    db.add(bot)
    db.commit()
    return bot


class TestTheStampItself:
    def test_a_fresh_agent_has_no_stamp(self, db):
        """NULL is a real state — "nobody has ever set this" — and it is the
        only state in which the crawl may derive an avatar."""
        assert _bot(db, 8300).bot_logo_source is None

    def test_uploading_an_avatar_stamps_it_manual(self, db):
        bot = _bot(db, 8301)
        stamp_manual_avatar(bot, {"bot_logo": "logos/mine.png", "launcher_logo": "logos/mine.png"})
        assert bot.bot_logo_source == AVATAR_SOURCE_MANUAL

    def test_REMOVING_an_avatar_also_stamps_it_manual(self, db):
        """The case the column exists for. Clearing leaves exactly the row
        state of an agent that never had one, so if this did not stamp, the
        next crawl would put the picture straight back.

        Starts from `derived` on purpose — a customer deleting the avatar the
        crawl gave them is the exact scenario, and seeding `manual` here would
        let a stamp that never runs pass the assertion."""
        bot = _bot(db, 8302, bot_logo="logos/favicon.png", bot_logo_source=AVATAR_SOURCE_DERIVED)
        stamp_manual_avatar(bot, {"bot_logo": None, "launcher_logo": None})
        assert bot.bot_logo_source == AVATAR_SOURCE_MANUAL

    def test_a_derived_avatar_is_claimed_the_moment_the_customer_edits_it(self, db):
        """Replacing a derived avatar makes it theirs — it must not keep
        claiming to have come from their website."""
        bot = _bot(db, 8303, bot_logo="logos/favicon.png", bot_logo_source=AVATAR_SOURCE_DERIVED)
        stamp_manual_avatar(bot, {"bot_logo": "logos/mine.png"})
        assert bot.bot_logo_source == AVATAR_SOURCE_MANUAL

    def test_a_patch_that_does_not_mention_the_avatar_leaves_the_stamp_alone(self, db):
        """These settings patches carry the whole appearance form. Changing a
        colour must not silently claim the avatar and disable derivation."""
        bot = _bot(db, 8304)
        stamp_manual_avatar(bot, {"primary_color": "#059669", "launcher_name": "Hi"})
        assert bot.bot_logo_source is None

    def test_launcher_logo_alone_counts_too(self, db):
        """Both settings routes mirror one field onto the other, so a patch can
        legitimately arrive carrying only `launcher_logo`."""
        bot = _bot(db, 8305)
        stamp_manual_avatar(bot, {"launcher_logo": "logos/mine.png"})
        assert bot.bot_logo_source == AVATAR_SOURCE_MANUAL

    def test_clearing_via_launcher_logo_alone_stamps_too(self, db):
        """The falsy-value trap: a removal sends None, so a stamp written as
        `if update_data.get(...)` would skip precisely the case this exists
        for. Membership is the test, not truthiness."""
        bot = _bot(db, 8310, bot_logo="logos/favicon.png", bot_logo_source=AVATAR_SOURCE_DERIVED)
        stamp_manual_avatar(bot, {"launcher_logo": None})
        assert bot.bot_logo_source == AVATAR_SOURCE_MANUAL


class TestBothSettingsRoutesStamp:
    """Two live routes write these columns, and an avatar removed through
    either one has to stick. Called directly rather than over HTTP: the
    autouse `patch_sessionlocal` fixture already points `get_session()` at the
    test database, so these hit the real handler and the real row.
    """

    def test_the_primary_bot_patch_stamps_a_removal(self, db):
        from app.api.bot_routes import UpdateBotRequest, update_bot

        bot = _bot(db, 8306, bot_logo="logos/favicon.png", bot_logo_source=AVATAR_SOURCE_DERIVED)

        update_bot(
            bot.id,
            UpdateBotRequest(bot_logo=None),
            auth={"type": "client", "client_id": bot.client_id, "entity": None},
        )

        db.expire_all()
        row = db.get(Bot, 8306)
        assert row.bot_logo is None
        assert row.bot_logo_source == AVATAR_SOURCE_MANUAL

    def test_the_primary_bot_patch_claims_a_derived_avatar_on_upload(self, db):
        from app.api.bot_routes import UpdateBotRequest, update_bot

        bot = _bot(db, 8308, bot_logo="logos/favicon.png", bot_logo_source=AVATAR_SOURCE_DERIVED)

        update_bot(
            bot.id,
            UpdateBotRequest(bot_logo="logos/mine.png"),
            auth={"type": "client", "client_id": bot.client_id, "entity": None},
        )

        db.expire_all()
        assert db.get(Bot, 8308).bot_logo_source == AVATAR_SOURCE_MANUAL

    def test_a_colour_only_patch_leaves_the_avatar_unclaimed(self, db):
        """Otherwise saving the appearance form once would permanently disable
        derivation for an agent whose avatar nobody has touched."""
        from app.api.bot_routes import UpdateBotRequest, update_bot

        bot = _bot(db, 8309)

        update_bot(
            bot.id,
            UpdateBotRequest(primary_color="#059669"),
            auth={"type": "client", "client_id": bot.client_id, "entity": None},
        )

        db.expire_all()
        assert db.get(Bot, 8309).bot_logo_source is None

    def test_the_legacy_client_settings_patch_stamps_a_removal(self, db):
        from app.api.client_routes import update_client_settings
        from app.schemas.client import ClientSettingsUpdate

        bot = _bot(db, 8307, bot_logo="logos/favicon.png", bot_logo_source=AVATAR_SOURCE_DERIVED)

        update_client_settings(
            ClientSettingsUpdate(bot_logo=None),
            bot_id=bot.id,
            client=db.get(Client, bot.client_id),
        )

        db.expire_all()
        row = db.get(Bot, 8307)
        assert row.bot_logo is None
        assert row.bot_logo_source == AVATAR_SOURCE_MANUAL
