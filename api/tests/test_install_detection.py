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


class TestFindsAClientInjectedInstall:
    """The install a framework renders from JavaScript.

    Next.js `<Script>` never emits a literal `<script src>`: the tag goes into
    the RSC flight payload and the browser adds it on load. The widget works
    perfectly for a visitor, and the scanner used to call the page 'missing'.

    Not hypothetical. oyechats.com installs its own widget this way, so the
    product's own front page reported "Snippet not found" while the widget was
    live on it, and every customer on a modern framework saw the same.
    """

    #: The shape Next.js actually serves, escaping and all.
    FLIGHT = (
        'e:["$","$L1f",null,{\\"src\\":\\"https://cdn.oyechats.com/oyechats-widget.js\\",'
        f'\\"data-bot-key\\":\\"{BOT}\\",\\"strategy\\":\\"lazyOnload\\"}}]'
    )

    def test_a_next_js_flight_payload_counts(self):
        assert _verdict(f"<body><script>self.__next_f.push([1,'{self.FLIGHT}'])</script></body>") == "installed"

    def test_it_is_reported_as_client_injected(self):
        # The reader is told HOW it was found, because "in your JavaScript" and
        # "in your HTML" are different facts: only the second means a crawler
        # that does not run JavaScript can see the widget too.
        scan = scan_html(f"<body><script>self.__next_f.push([1,'{self.FLIGHT}'])</script></body>")
        assert scan.client_injected is True

    def test_a_literal_script_tag_is_not_flagged_as_client_injected(self):
        assert scan_html(f"<body>{CANONICAL}</body>").client_injected is False

    def test_someone_elses_client_injected_widget_is_still_foreign(self):
        assert _verdict(f"<script>{self.FLIGHT}</script>", bot_key=OTHER) == "foreign"


class TestTheFallbackCannotBeTrippedByDocumentation:
    """Both halves are required, and this is why.

    The fallback reads a page that has no script tag, so it has weaker evidence
    than the parser above and needs a tighter rule: the loader FILENAME and a
    REAL key. Our own marketing page prints an install sample, and a checker
    that read its own docs as an install would be worse than useless.
    """

    def test_the_marketing_pages_own_install_sample(self):
        # Verbatim from oyechats.com: a different filename (`widget.js`), and a
        # placeholder where the key goes. It must match neither half.
        sample = "&lt;script src=&quot;cdn.oyechats.com/widget.js&quot; data-bot-key=&quot;…&quot;&gt;"
        assert _verdict(f"<div>{sample}</div>") == "missing"

    def test_the_filename_with_no_key_behind_it(self):
        # A blog post or a docs page naming the file. A mention, not an install.
        html = "<p>Add <code>oyechats-widget.js</code> to your site.</p>"
        assert _verdict(html) == "missing"

    def test_a_placeholder_key_is_not_a_key(self):
        html = (
            '<code>&lt;script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="YOUR_BOT_KEY"&gt;</code>'
        )
        assert _verdict(html) == "missing"

    def test_a_key_of_the_wrong_shape_is_not_a_key(self):
        # `bot-` plus twelve hex is what bot_routes mints. Anything else is
        # somebody writing about the format, not carrying a key.
        html = '<p>oyechats-widget.js with data-bot-key="bot-XXXXXXXXXXXX"</p>'
        assert _verdict(html) == "missing"
