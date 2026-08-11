"""The public URLs that reach a customer must not default to localhost.

`API_BASE_URL` defaulted to ``http://localhost:8000`` while its two siblings,
`MARKETING_URL` and `APP_URL`, defaulted to real production hosts. It is also
the only one of the three that lands in a stranger's inbox: the unsubscribe
link in a manual follow-up is built from it in
``lead_routes.send_manual_follow_up``.

The deploy workflow never passed it either, so production silently used the
default and every follow-up email shipped an unsubscribe pointing at
``http://localhost:8000`` — dead for the recipient. An unsubscribe that cannot
be actioned is a compliance problem, not a cosmetic one, and nothing failed
loudly enough to notice: the email sent, the link rendered, the token was even
valid.
"""

from __future__ import annotations

import importlib
import os
from unittest.mock import patch

import pytest

from app.config import (
    DEFAULT_API_BASE_URL,
    DEFAULT_APP_URL,
    DEFAULT_MARKETING_URL,
)

# The DEFAULTS, not the resolved values. Simulating "unset" by reloading
# `app.config` cannot work — `load_dotenv()` repopulates from `api/.env` on
# every import — and that gap is exactly how a localhost default survived to
# production without a single test noticing.
PUBLIC_URL_DEFAULTS = {
    "API_BASE_URL": DEFAULT_API_BASE_URL,
    "APP_URL": DEFAULT_APP_URL,
    "MARKETING_URL": DEFAULT_MARKETING_URL,
}


@pytest.mark.parametrize(("name", "default"), sorted(PUBLIC_URL_DEFAULTS.items()))
def test_no_public_url_defaults_to_localhost(name, default):
    """With nothing set — which is exactly what production had — none of these
    may resolve to a host only the server itself can reach."""
    assert "localhost" not in default, f"{name} defaults to a link no recipient can open"
    assert "127.0.0.1" not in default
    assert default.startswith("https://"), f"{name} must be https — it is emailed to strangers"


@pytest.mark.parametrize(("name", "default"), sorted(PUBLIC_URL_DEFAULTS.items()))
def test_the_default_carries_no_trailing_slash(name, default):
    """Each is concatenated with a path that already starts with '/'."""
    assert not default.endswith("/")


def test_an_explicit_value_still_wins_and_is_normalised():
    """Local development overrides these in `api/.env`; a trailing slash there
    must not produce a doubled separator in an emailed link."""
    with patch.dict(os.environ, {"API_BASE_URL": "http://localhost:8000/"}):
        import app.config

        reloaded = importlib.reload(app.config)
        try:
            assert reloaded.API_BASE_URL == "http://localhost:8000"
        finally:
            importlib.reload(app.config)


def test_the_unsubscribe_link_is_built_from_the_api_root():
    """`send_manual_follow_up` is the one caller that emails this value out."""
    import inspect

    from app.api import lead_routes

    source = inspect.getsource(lead_routes.send_manual_follow_up)
    assert "API_BASE_URL" in source and "/leads/unsubscribe" in source
