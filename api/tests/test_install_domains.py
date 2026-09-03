"""Per-domain install records: the upsert, the cap, and the state collapse.

Three things here are load-bearing enough to pin. The upsert must not let a busy
site write a row per page view, or refresh a first-seen stamp into a duplicate
of last-seen. The cap must hold, because the hostname it stores arrives on the
``Origin`` header of an unauthenticated endpoint and is therefore
attacker-chosen. And the state collapse must never let one fetch of served HTML
overrule a real browser, or a customer whose snippet is injected by a tag
manager is told their working site is broken.
"""

from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

from app.api import bot_routes
from app.api.bot_routes import _domain_state
from app.services.install_probe import probe_targets

pytestmark_db = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _row(**over):
    base = {
        "observed_last_at": None,
        "probe_status": None,
    }
    base.update(over)
    return SimpleNamespace(**base)


class TestStateCollapse:
    def test_a_real_browser_beats_a_probe_that_saw_nothing(self):
        # The tag-manager case. Served HTML has no snippet, yet visitors load
        # the widget every day. Reporting 'missing' would send a customer with
        # the strongest possible evidence of a working install to debug it.
        assert _domain_state(_row(observed_last_at="2026-08-31", probe_status="missing")) == "live"

    def test_a_real_browser_beats_an_unreachable_probe(self):
        # A site behind Cloudflare bot protection refuses our fetch and serves
        # visitors perfectly.
        assert _domain_state(_row(observed_last_at="2026-08-31", probe_status="unreachable")) == "live"

    def test_a_probe_can_confirm_an_install_nobody_has_visited(self):
        # The state passive data cannot produce: correctly installed, zero
        # traffic. Before the probe this was indistinguishable from 'missing'.
        assert _domain_state(_row(probe_status="installed")) == "installed"

    def test_an_absent_snippet_is_missing(self):
        assert _domain_state(_row(probe_status="missing")) == "missing"

    def test_somebody_elses_chatbot_reads_as_missing_for_this_one(self):
        # 'foreign' is not its own state. The fact about THIS chatbot is that
        # its snippet is not on the page; what was found instead is carried
        # separately, so a page with both reads as live plus a note.
        assert _domain_state(_row(probe_status="foreign")) == "missing"

    def test_unreachable_is_not_missing(self):
        # Distinct on purpose. "We could not look" and "we looked and it is not
        # there" send the customer to completely different places.
        assert _domain_state(_row(probe_status="unreachable")) == "unreachable"

    def test_a_domain_nothing_has_happened_to_is_unchecked(self):
        assert _domain_state(_row()) == "unchecked"


class TestProbeTargets:
    def test_it_checks_the_allow_list_the_website_and_what_it_has_seen(self):
        bot = SimpleNamespace(allowed_domains=["acme.com"], website="https://shop.acme.com/pricing")
        assert probe_targets(bot, ["blog.acme.com"]) == ["acme.com", "shop.acme.com", "blog.acme.com"]

    def test_a_url_and_a_bare_host_converge_on_one_entry(self):
        # `website` holds a URL, `allowed_domains` holds a bare host. Fetching
        # the same domain twice would bill the customer's server for our
        # inability to normalise.
        bot = SimpleNamespace(allowed_domains=["acme.com"], website="https://acme.com/")
        assert probe_targets(bot, ["acme.com"]) == ["acme.com"]

    def test_wildcards_are_dropped_rather_than_fetched(self):
        # `*.acme.com` is not a hostname and cannot be enumerated. Probing it
        # would report a fault on a correct configuration.
        bot = SimpleNamespace(allowed_domains=["*.acme.com", "acme.com"], website=None)
        assert probe_targets(bot, []) == ["acme.com"]

    def test_a_chatbot_with_nothing_configured_has_nothing_to_check(self):
        bot = SimpleNamespace(allowed_domains=[], website=None)
        assert probe_targets(bot, []) == []

    def test_the_run_is_capped(self):
        from app.services.install_detection import MAX_DOMAINS_PER_RUN

        bot = SimpleNamespace(allowed_domains=[f"d{i}.com" for i in range(80)], website=None)
        assert len(probe_targets(bot, [])) == MAX_DOMAINS_PER_RUN


@pytestmark_db
class TestTheRegistry:
    def _bot(self, db):
        from app.db.models import Bot, Client

        client = Client(name="T", email="dom@example.com", api_key="k-dom", hashed_password="h")
        db.add(client)
        db.flush()
        bot = Bot(client_id=client.id, name="Support", bot_key="bot-dom-1")
        db.add(bot)
        db.flush()
        db.commit()
        return bot

    def test_repeat_bootstraps_from_one_domain_write_one_row(self, db):
        from app.db.models import BotDomainInstall
        from app.services.install_registry import record_observed_domain

        bot = self._bot(db)
        for _ in range(5):
            record_observed_domain(db, bot.id, "acme.com")
        db.commit()

        rows = db.query(BotDomainInstall).filter_by(bot_id=bot.id).all()
        assert len(rows) == 1

    def test_first_seen_is_not_refreshed_by_later_bootstraps(self, db):
        from app.db.models import BotDomainInstall
        from app.services.install_registry import record_observed_domain

        bot = self._bot(db)
        record_observed_domain(db, bot.id, "acme.com")
        db.commit()
        first = db.query(BotDomainInstall).filter_by(bot_id=bot.id).one().observed_first_at

        record_observed_domain(db, bot.id, "acme.com")
        db.commit()
        db.expire_all()
        row = db.query(BotDomainInstall).filter_by(bot_id=bot.id).one()

        # An upsert that also refreshed first-seen would make the column a
        # second copy of last-seen, and "installed since March" would silently
        # become "installed 20 minutes ago".
        assert row.observed_first_at == first
        assert row.observed_last_at >= first

    def test_two_domains_are_two_rows(self, db):
        from app.db.models import BotDomainInstall
        from app.services.install_registry import record_observed_domain

        bot = self._bot(db)
        record_observed_domain(db, bot.id, "acme.com")
        record_observed_domain(db, bot.id, "shop.acme.com")
        db.commit()

        # The whole point. The old single column held whichever of these called
        # most recently and discarded the other.
        assert db.query(BotDomainInstall).filter_by(bot_id=bot.id).count() == 2

    def test_a_forged_origin_flood_cannot_grow_the_table_without_bound(self, db):
        from app.db.models import BotDomainInstall
        from app.services.install_registry import MAX_OBSERVED_DOMAINS_PER_BOT, record_observed_domain

        bot = self._bot(db)
        for i in range(MAX_OBSERVED_DOMAINS_PER_BOT + 25):
            record_observed_domain(db, bot.id, f"forged-{i}.example")
        db.commit()

        assert db.query(BotDomainInstall).filter_by(bot_id=bot.id).count() == MAX_OBSERVED_DOMAINS_PER_BOT

    def test_at_the_cap_a_known_domain_still_stays_live(self, db):
        from app.db.models import BotDomainInstall
        from app.services.install_registry import MAX_OBSERVED_DOMAINS_PER_BOT, record_observed_domain

        bot = self._bot(db)
        record_observed_domain(db, bot.id, "real.com")
        db.commit()
        before = db.query(BotDomainInstall).filter_by(bot_id=bot.id, hostname="real.com").one().observed_last_at

        for i in range(MAX_OBSERVED_DOMAINS_PER_BOT + 5):
            record_observed_domain(db, bot.id, f"junk-{i}.example")
        db.commit()
        # A customer with a genuinely full list must not have the next forged
        # origin freeze the liveness of their real domains.
        record_observed_domain(db, bot.id, "real.com")
        db.commit()
        db.expire_all()

        after = db.query(BotDomainInstall).filter_by(bot_id=bot.id, hostname="real.com").one().observed_last_at
        assert after >= before

    def test_a_probe_never_stamps_the_observation_columns(self, db):
        from app.db.models import BotDomainInstall
        from app.services.install_registry import record_probe_result

        bot = self._bot(db)
        record_probe_result(db, bot.id, hostname="acme.com", status="installed", bot_key="bot-dom-1")
        db.commit()

        row = db.query(BotDomainInstall).filter_by(bot_id=bot.id).one()
        assert row.probe_status == "installed"
        # Observation means a real visitor loaded the widget. Letting our own
        # fetch write it would make the product's strongest signal
        # indistinguishable from it checking its own homework.
        assert row.observed_first_at is None
        assert row.observed_last_at is None

    def test_a_probe_and_an_observation_share_one_row(self, db):
        from app.db.models import BotDomainInstall
        from app.services.install_registry import record_observed_domain, record_probe_result

        bot = self._bot(db)
        record_observed_domain(db, bot.id, "acme.com")
        record_probe_result(db, bot.id, hostname="acme.com", status="missing")
        db.commit()

        row = db.query(BotDomainInstall).filter_by(bot_id=bot.id).one()
        assert row.observed_last_at is not None
        assert row.probe_status == "missing"


class TestOwnDomainsAreNotCustomerInstalls:
    """``counts_as_install``, and the single rule behind it.

    Our marketing site runs the widget, so its snippet probes as installed and
    its heartbeat is refused, deliberately: our own traffic must never tick a
    customer's setup step. The card then said "no visitor has opened the
    chatbot here yet" forever, which is how this got reported as a bug against
    a mechanism that was working exactly as designed.

    The rule lives in one function so the two callers cannot drift. A payload
    that claimed a host counts while the heartbeat refused it would reproduce
    the same false fault by a different route.
    """

    @staticmethod
    def _request(host: str = "api.oyechats.com"):
        return SimpleNamespace(base_url=f"https://{host}/", headers={})

    @pytest.fixture(autouse=True)
    def _our_hosts(self, monkeypatch):
        # The env under test has no APP_URL/MARKETING_URL, so the set would be
        # just localhost. Pin it to its production shape instead.
        monkeypatch.setattr(
            bot_routes,
            "_INTERNAL_WIDGET_HOSTS",
            {"www.oyechats.com", "app.oyechats.com", "localhost", "127.0.0.1"},
        )

    def test_our_marketing_site_is_ours(self):
        assert bot_routes._is_internal_widget_host("www.oyechats.com", self._request()) is True

    def test_the_dashboard_is_ours(self):
        assert bot_routes._is_internal_widget_host("app.oyechats.com", self._request()) is True

    def test_the_api_serving_the_request_is_ours(self):
        # The hosted demo and preview pages are served by the API itself, so a
        # widget embedded there reports the API host as its origin. Excluded
        # whatever the URL config resolves to, which is why the request has to
        # be a parameter.
        assert bot_routes._is_internal_widget_host("api.oyechats.com", self._request()) is True

    def test_a_customer_domain_is_not_ours(self):
        assert bot_routes._is_internal_widget_host("acme.com", self._request()) is False

    def test_a_subdomain_of_ours_that_we_do_not_own_still_counts(self):
        # Customer chatbots run on `*.oyechats.com` subdomains we hand out.
        # Those are real installs and two of them are stamped in production.
        assert bot_routes._is_internal_widget_host("cleanstart.oyechats.com", self._request()) is False

    def test_the_heartbeat_and_the_payload_agree(self):
        # Both sides of the rule, driven through their real entry points. If
        # these ever disagree the UI reports a fault that does not exist.
        for host, external in (("www.oyechats.com", False), ("acme.com", True)):
            request = SimpleNamespace(base_url="https://api.oyechats.com/", headers={"origin": f"https://{host}"})
            assert (bot_routes._external_install_hostname(request) is not None) is external
            assert (not bot_routes._is_internal_widget_host(host, request)) is external
