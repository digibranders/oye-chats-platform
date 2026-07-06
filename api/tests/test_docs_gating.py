"""Interactive API docs must be disabled in production (audit F22).

/docs, /redoc and /openapi.json expose the full API schema (every route, params,
auth headers) — a recon aid for attackers. They stay on in dev/testing and are
turned off when APP_ENV=production.
"""

from app.main import _docs_urls


def test_docs_disabled_in_production():
    urls = _docs_urls("production")
    assert urls == {"docs_url": None, "redoc_url": None, "openapi_url": None}


def test_docs_enabled_outside_production():
    for env in ("development", "testing", "staging"):
        urls = _docs_urls(env)
        assert urls["docs_url"] == "/docs"
        assert urls["redoc_url"] == "/redoc"
        assert urls["openapi_url"] == "/openapi.json"
