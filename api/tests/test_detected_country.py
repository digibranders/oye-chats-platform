"""The signup form's country prefill (``GET /auth/detect-country``).

The endpoint already existed and its docstring says the register page "calls
this on load to preselect the visitor's country" -- but nothing called it and
nothing tested it, so the field it was written for never shipped. These are its
first tests.

Deliberately a PREFILL and nothing more. ``subscription_routes.get_billing_geo``
documents at length why an IP signal must never become a stored
``billing_country`` on its own: the charge gate refuses to resolve on it and
409s ``billing_country_required`` instead, because a VPN or a corporate egress
picking INR over USD is a live money bug.

What makes signup different is not the signal, it is the human. The detected
value is rendered into a visible, editable field, and it only reaches
``billing_country`` because someone looked at it and pressed the button. That is
a confirmation, which is exactly what the charge gate wants. Save it silently
with no field on screen and it would be the money bug again.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import auth_routes


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(auth_routes.router)
    return TestClient(app)


def test_it_needs_no_authentication():
    # It runs on the signup screen, where nobody has an API key yet.
    res = _client().get("/auth/detect-country")
    assert res.status_code == 200, res.text
    assert "country" in res.json()


def test_it_reads_the_cdn_country_header():
    res = _client().get("/auth/detect-country", headers={"CF-IPCountry": "IN"})
    assert res.json()["country"] == "IN"


def test_a_foreign_visitor_gets_their_own_country():
    res = _client().get("/auth/detect-country", headers={"CF-IPCountry": "US"})
    assert res.json()["country"] == "US"


def test_an_unresolvable_request_returns_null_rather_than_guessing():
    # Local dev, a stripped proxy, or a header we do not trust. The form then
    # renders an empty picker and the person chooses, which is better than
    # defaulting someone into the wrong tax rail.
    res = _client().get("/auth/detect-country")
    assert res.json()["country"] is None


def test_it_never_leaks_anything_but_the_country():
    # No IP, no city, no headers echoed back. This endpoint is unauthenticated,
    # so its response is the smallest thing that answers the question.
    res = _client().get("/auth/detect-country", headers={"CF-IPCountry": "IN"})
    assert set(res.json()) == {"country"}
