"""The day-0 welcome email, the one message every new signup receives.

It had shipped with its subject line's parentheses on the wrong words and with
all three of its quick-start links pointing at routes the rebuilt console does
not have. Neither was pinned by anything, so both survived every gate. These
tests pin the sentences a customer actually reads, and the guard that decides
whether the email is worth sending at all.

Pure-Python: the sender is called with ``send_email_async`` patched, so no
database and no transport are involved.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from unittest.mock import patch

import pytest

from app.services import email_service


def _send(**overrides):
    """Call the sender and return the (subject, html) it dispatched."""
    kwargs = {
        "name": "Ada",
        "trial_end": datetime(2026, 9, 11, tzinfo=UTC),
        "credits": 500,
        "duration_days": 14,
    }
    kwargs.update(overrides)
    with patch.object(email_service, "send_email_async") as send:
        email_service.send_trial_welcome_email("ada@example.com", **kwargs)
    assert send.call_count == 1
    args, _ = send.call_args
    return args[1], args[2]


def test_the_subject_is_a_sentence():
    """It shipped as ``Welcome to OyeChats (your 14-day trial is live``.

    An em-dash strip had put the opening paren in the envelope subject and the
    closing one in the rendered shell's copy of the same line, so the customer
    saw an unclosed bracket in their inbox. Both halves are asserted, because
    only fixing one leaves the other in front of a reader.
    """
    subject, html = _send()
    assert subject == "Welcome to OyeChats, your 14-day trial is live"
    assert subject in html
    for bracket in "()":
        assert bracket not in subject


def test_every_link_points_at_a_route_that_exists():
    """The three quick-start links all landed on Not Found.

    ``/knowledge`` and ``/chatbot`` are not routes in the rebuilt console and
    are not in its legacy-redirect table, so the day-0 email's "3-step path to
    your first chat" was three 404s. The real pages are per chatbot and this
    email has no chatbot id, so every step points at the list they all start
    from.
    """
    _, html = _send()
    paths = {
        re.sub(r"^https?://[^/]+", "", href)
        for href in re.findall(r'href="([^"]+)"', html)
        if href.startswith(email_service.APP_URL)
    }
    assert paths <= {"", "/", "/chatbots"}, f"unrouted links in the welcome email: {sorted(paths)}"
    assert "/chatbots" in paths


def test_the_numbers_are_the_ones_it_was_given():
    subject, html = _send(credits=500, duration_days=14)
    assert "14-day" in subject
    assert "500 credits" in html


@pytest.mark.parametrize(("credits", "duration"), [(0, 14), (500, 0), (0, 0)])
def test_a_zero_would_contradict_the_subscription_it_describes(credits: int, duration: int):
    """Why the callers guard on the numbers rather than on the plan row.

    The template asserts both figures. This test does not stop the sender from
    rendering them, it records what it renders, so the guard in
    ``auth_routes``/``oauth_routes`` has a reason a reader can check.
    """
    subject, html = _send(credits=credits, duration_days=duration)
    rendered = subject + html
    assert (f"{duration}-day" in rendered) or duration != 0
    assert (f"{credits:,} credits" in rendered) or credits != 0
