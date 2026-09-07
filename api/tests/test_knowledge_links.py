"""Contact-page detection from a bot's own crawled pages, and the Free pricing
pivot it unblocks.

A Free bot with no ``pricing_url`` is supposed to hand the visitor the
customer's public contact page instead of quoting a price. It sourced that page
from a ``contact`` Smart Link an admin had to add by hand, and nobody adds one
(0 of 18 bots on the development database), so the pivot never fired and the
knowledge base answered pricing questions instead. These tests pin the fix:
the page is found in the bot's own crawl.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.services import pricing_gate as pg
from app.services.knowledge_links import detect_contact_url
from app.services.rag_service import resolve_contact_url


class TestDetectContactUrl:
    def test_finds_a_contact_us_page(self):
        urls = [
            "https://www.cleanstart.com/",
            "https://www.cleanstart.com/about-us",
            "https://www.cleanstart.com/contact-us",
        ]
        assert detect_contact_url(urls) == "https://www.cleanstart.com/contact-us"

    def test_finds_a_bare_contact_page(self):
        assert detect_contact_url(["https://fynix.digital/contact"]) == "https://fynix.digital/contact"

    def test_returns_none_when_no_contact_page(self):
        assert detect_contact_url(["https://x.com/", "https://x.com/blogs", "https://x.com/about"]) is None

    def test_a_deep_page_merely_mentioning_contact_does_not_match(self):
        """Only a page whose WHOLE path is a contact slug counts. Handing a
        visitor a blog post when they wanted a human is worse than nothing."""
        urls = ["https://x.com/blogs/how-to-contact-support", "https://x.com/blog/contact-us-tips"]
        assert detect_contact_url(urls) is None

    def test_ignores_unusable_urls(self):
        """Anything ``normalize_url`` rejects can never reach a visitor's reply."""
        assert detect_contact_url(["javascript:alert(1)", "mailto:a@b.com", "/contact"]) is None

    def test_skips_junk_without_shadowing_a_real_match(self):
        assert detect_contact_url([None, 123, {}, "https://x.com/contact"]) == "https://x.com/contact"

    def test_is_deterministic_when_several_match(self):
        """A non-deterministic pick would swap the link a visitor is handed
        between two turns of one conversation."""
        urls = ["https://x.com/contact-us", "https://x.com/contact"]
        assert detect_contact_url(urls) == detect_contact_url(list(reversed(urls)))
        assert detect_contact_url(urls) == "https://x.com/contact"

    def test_returns_the_url_as_stored_not_normalized(self):
        """The visitor needs a clickable link, not the comparison form."""
        assert detect_contact_url(["https://www.x.com/contact/"]) == "https://www.x.com/contact/"

    def test_empty_input(self):
        assert detect_contact_url([]) is None
        assert detect_contact_url(None) is None


def _bot(*, answer_links=None, bot_id=1):
    return SimpleNamespace(id=bot_id, answer_links=answer_links)


class _FakeSession:
    """Stands in for the ORM session, returning canned source URLs."""

    def __init__(self, urls=None, raises=False):
        self._urls = urls or []
        self._raises = raises

    def execute(self, _stmt):
        if self._raises:
            raise RuntimeError("db down")
        urls = self._urls

        class _R:
            def scalars(self):
                return self

            def all(self):
                return urls

        return _R()


class TestResolveContactUrl:
    def test_smart_link_wins_over_the_crawled_page(self):
        """Explicit admin config must never be silently overridden."""
        bot = _bot(answer_links=[{"keyword": "contact", "url": "https://admin-chose.com/contact"}])
        session = _FakeSession(["https://crawled.com/contact-us"])
        assert resolve_contact_url(bot, session) == "https://admin-chose.com/contact"

    def test_falls_back_to_the_crawled_page(self):
        assert resolve_contact_url(_bot(), _FakeSession(["https://crawled.com/contact-us"])) == (
            "https://crawled.com/contact-us"
        )

    def test_falls_back_when_smart_links_hold_no_contact_entry(self):
        bot = _bot(answer_links=[{"keyword": "pricing", "url": "https://x.com/pricing"}])
        assert resolve_contact_url(bot, _FakeSession(["https://crawled.com/contact"])) == "https://crawled.com/contact"

    def test_returns_none_when_the_crawl_has_no_contact_page(self):
        assert resolve_contact_url(_bot(), _FakeSession(["https://crawled.com/about"])) is None

    def test_a_db_failure_never_breaks_the_turn(self):
        assert resolve_contact_url(_bot(), _FakeSession(raises=True)) is None

    def test_no_session_still_resolves_the_configured_half(self):
        bot = _bot(answer_links=[{"keyword": "contact", "url": "https://admin-chose.com/contact"}])
        assert resolve_contact_url(bot, None) == "https://admin-chose.com/contact"
        assert resolve_contact_url(_bot(), None) is None


class TestFreeBotHandsOverTheContactPage:
    """The behaviour this whole change exists to deliver.

    BEFORE: Free bot, no ``pricing_url``, no Smart Link -> the gate stood down
    and the knowledge base answered the pricing question, stale rate card and
    all.
    AFTER: the contact page from its own crawl gives the gate somewhere to send
    the visitor, so it escalates and hands that page over instead.
    """

    def _contact(self):
        return resolve_contact_url(_bot(), _FakeSession(["https://crawled.com/", "https://crawled.com/contact-us"]))

    def test_the_crawled_page_prevents_the_standdown(self):
        assert (
            pg.no_support_path_standdown(support_enabled=False, pricing_url=None, contact_url=self._contact()) is False
        )

    def test_the_gate_escalates_and_empties_the_chunks(self):
        """``chunks == []`` is the "regardless of the knowledge base"
        guarantee: the contact link is the WHOLE reply, never a link appended
        to a stale knowledge-base price."""
        stale = [SimpleNamespace(document_name="https://crawled.com/old-rates", content="Plans from $99/mo")]
        decision = pg.evaluate_pricing_gate(
            question="how much does it cost?",
            quote_active=False,
            pricing_url=None,
            chunks=stale,
            support_enabled=False,
            contact_url=self._contact(),
        )
        assert decision.fired is True
        assert decision.outcome == "escalate_no_url"
        assert decision.chunks == []

    def test_the_visitor_is_handed_the_crawled_page(self):
        pivot = pg.pricing_pivot(
            company_name="CleanStart",
            pricing_url=None,
            support_enabled=False,
            live_chat_enabled=False,
            contact_url=self._contact(),
        )
        assert "https://crawled.com/contact-us" in pivot.text
        # Free has no in-chat channel: a link is information, never a promise.
        assert pivot.suggest_handoff is False
        assert pivot.needs_message_card is False

    def test_a_paid_bot_is_unaffected_and_still_goes_to_the_team(self):
        pivot = pg.pricing_pivot(
            company_name="CleanStart",
            pricing_url=None,
            support_enabled=True,
            live_chat_enabled=True,
            contact_url=self._contact(),
        )
        assert pivot.suggest_handoff is True
        assert "https://crawled.com/contact-us" not in pivot.text
