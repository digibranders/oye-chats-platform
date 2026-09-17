"""The developer handoff email names every CSP directive the widget needs.

It listed only `script-src` and `connect-src`. The widget's stylesheet loads
from the script's origin, so a site with a `style-src` policy loaded the widget
and then showed nothing: the app waits for that stylesheet before rendering.
"""

from unittest.mock import patch

from app.services import email_service

SNIPPET = '<script async src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-abc123"></script>'


def _render() -> str:
    with patch.object(email_service, "send_email_async") as send:
        email_service.send_install_invite_email(
            to_email="dev@acme.test",
            bot_name="Acme Bot",
            snippet=SNIPPET,
            script_origin="https://cdn.oyechats.com",
            api_origin="https://api.oyechats.com",
            requester_name="Eva",
            reply_to="eva@acme.test",
        )
    send.assert_called_once()
    (_to, _subject, html_body), _options = send.call_args
    return html_body


def test_it_names_script_style_and_connect_sources():
    html_body = _render()

    assert "script-src https://cdn.oyechats.com" in html_body
    assert "style-src https://cdn.oyechats.com" in html_body
    assert "connect-src https://api.oyechats.com" in html_body
