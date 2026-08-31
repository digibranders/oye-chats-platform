"""The scanner that decides whether a customer is told their site is broken.

Every false 'missing' here sends someone with a working chatbot to debug a
working website, and every false 'installed' ticks their setup step for a page
that has nothing on it. Both are worse than saying nothing, so the parsing rules
get pinned individually.
"""

from __future__ import annotations

from app.services.install_detection import scan_html

BOT = "bot-6a427d4529b9"
OTHER = "bot-000000000000"

CANONICAL = f'<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="{BOT}"></script>'


def _verdict(html: str, bot_key: str = BOT) -> str:
    return scan_html(html).verdict_for(bot_key)


class TestFindsARealInstall:
    def test_the_canonical_snippet(self):
        assert _verdict(f"<body>{CANONICAL}</body>") == "installed"

    def test_attributes_in_the_other_order(self):
        html = f'<script data-bot-key="{BOT}" src="https://cdn.oyechats.com/oyechats-widget.js"></script>'
        assert _verdict(html) == "installed"

    def test_single_quotes(self):
        html = f"<script src='https://cdn.oyechats.com/oyechats-widget.js' data-bot-key='{BOT}'></script>"
        assert _verdict(html) == "installed"

    def test_async_and_defer_do_not_hide_it(self):
        html = f'<script async defer src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="{BOT}"></script>'
        assert _verdict(html) == "installed"

    def test_a_self_hosted_copy_still_counts(self):
        # The check matches the loader FILENAME, not our CDN hostname, so a
        # customer serving the loader from their own domain — or a developer
        # testing against `vite preview` — is not reported as uninstalled.
        html = f'<script src="https://assets.acme.com/js/oyechats-widget.js" data-bot-key="{BOT}"></script>'
        assert _verdict(html) == "installed"

    def test_a_cache_busting_query_string_still_counts(self):
        html = f'<script src="https://cdn.oyechats.com/oyechats-widget.js?v=3" data-bot-key="{BOT}"></script>'
        assert _verdict(html) == "installed"

    def test_the_consent_gated_install_that_sets_the_global(self):
        # No data-bot-key on the tag; the key goes on `window` instead, which
        # widget/src/loader.js reads. A legitimate GDPR install.
        html = (
            "<script>window.OYECHATS_ASYNC_INIT=true;"
            f'window.OYECHATS_BOT_KEY="{BOT}";</script>'
            '<script src="https://cdn.oyechats.com/oyechats-widget.js"></script>'
        )
        assert _verdict(html) == "installed"

    def test_the_attribution_anchor_beside_it_changes_nothing(self):
        html = f'{CANONICAL}<a href="https://www.oyechats.com/?ref={BOT}" rel="nofollow">Powered by OyeChats</a>'
        assert _verdict(html) == "installed"


class TestReportsAnAbsentSnippet:
    def test_an_ordinary_page(self):
        assert _verdict("<html><body><h1>Acme</h1></body></html>") == "missing"

    def test_an_empty_response(self):
        assert _verdict("") == "missing"

    def test_merely_mentioning_us_is_not_an_install(self):
        # A blog post about the product, or a footer link. Neither loads a
        # widget, and calling either one installed would tick the setup step
        # for a page that has no chatbot on it.
        html = f'<p>We use OyeChats for support.</p><a href="https://www.oyechats.com">OyeChats</a><!-- {BOT} -->'
        assert _verdict(html) == "missing"

    def test_the_global_alone_is_not_an_install(self):
        # The variable is set but no loader ever arrives, so nothing runs. This
        # is exactly the half-finished paste the check exists to catch.
        assert _verdict(f'<script>window.OYECHATS_BOT_KEY="{BOT}";</script>') == "missing"

    def test_a_different_vendors_widget_is_not_ours(self):
        html = '<script src="https://widget.intercom.io/widget/abc123"></script>'
        assert _verdict(html) == "missing"


class TestSpotsSomebodyElsesChatbot:
    def test_a_different_key_is_foreign_not_missing(self):
        # The whole reason this needs an active probe: a widget carrying
        # another key never contacts us on this bot's behalf, so passive data
        # cannot see it at all.
        html = f'<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="{OTHER}"></script>'
        scan = scan_html(html)
        assert scan.verdict_for(BOT) == "foreign"
        assert scan.bot_keys == (OTHER,)

    def test_a_loader_with_no_key_at_all_is_foreign_not_installed(self):
        # A broken paste: the script is there, the key is not. We cannot prove
        # it is ours, and 'installed' would be a claim we have not earned.
        html = '<script src="https://cdn.oyechats.com/oyechats-widget.js"></script>'
        assert _verdict(html) == "foreign"

    def test_our_own_key_wins_when_two_chatbots_share_a_page(self):
        # Valid setup: different chatbots on different sections. The customer's
        # own install works, so reporting 'foreign' would be a false alarm on a
        # correct configuration.
        html = f'<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="{OTHER}"></script>{CANONICAL}'
        scan = scan_html(html)
        assert scan.verdict_for(BOT) == "installed"
        assert scan.verdict_for(OTHER) == "installed"
        assert set(scan.bot_keys) == {BOT, OTHER}

    def test_the_same_key_twice_is_reported_once(self):
        assert scan_html(CANONICAL + CANONICAL).bot_keys == (BOT,)
