"""Production error responses must not carry internal implementation detail.

These are regression tests for a class of leak, not for one handler. The rule
they pin down is the one from ``app.core.error_sanitizer``: a failure renders
twice — a generic sentence for the client, the full diagnostic for the log —
and the two never swap places.

The assertions are deliberately written as "this string must not appear
anywhere in the response body" rather than "this key equals that value". A
future handler that starts formatting the exception into a *different* field
still fails these tests, which is the point; the previous leak was not a wrong
value in a known key, it was raw framework output in a key nobody thought to
look at.
"""

import json

import pytest
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel
from slowapi.errors import RateLimitExceeded
from sqlalchemy.exc import IntegrityError

from app.core.error_sanitizer import (
    debug_hint,
    is_sensitive_field,
    loggable_validation_errors,
    new_error_id,
    public_error_body,
    public_validation_errors,
)
from app.core.middleware import (
    generic_exception_handler,
    rate_limit_exceeded_handler,
    validation_exception_handler,
)

# Fragments that must never reach a client. Each names a disclosure class from
# the audit: framework version, source location, filesystem layout, SQL/ORM
# internals, connection strings, credentials.
FORBIDDEN_FRAGMENTS = (
    "errors.pydantic.dev",
    "Traceback (most recent call last)",
    "/home/user/",
    "/usr/lib/python",
    "site-packages",
    "app/api/",
    "app/services/",
    '.py", line ',
    "sqlalchemy",
    "psycopg2",
    "SELECT ",
    "INSERT INTO",
    "duplicate key value violates",
    "postgresql://",
    "redis://",
)


def assert_no_internals(body_text: str) -> None:
    """Fail with the offending fragment named, not just 'assertion failed'."""
    lowered = body_text.lower()
    for fragment in FORBIDDEN_FRAGMENTS:
        assert fragment.lower() not in lowered, f"response leaked {fragment!r}: {body_text}"


# ── A miniature app that fails in each of the ways production can ────────────


class CredentialBody(BaseModel):
    email: str
    password: str
    age: int


@pytest.fixture()
def failing_app():
    """An app wired with the real handlers, exposing one route per failure mode."""
    app = FastAPI()
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, generic_exception_handler)
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

    router = APIRouter()

    @router.post("/login")
    def login(body: CredentialBody):  # pragma: no cover - never reached with bad input
        return {"ok": True}

    @router.get("/boom/db")
    def boom_db():
        raise IntegrityError(
            "INSERT INTO clients (email, hashed_password) VALUES (%(email)s, %(pw)s)",
            {"email": "a@b.com", "pw": "$2b$12$secrethash"},
            Exception('duplicate key value violates unique constraint "ix_clients_email"'),
        )

    @router.get("/boom/attr")
    def boom_attr():
        return {}["missing-key"]

    @router.get("/boom/os")
    def boom_os():
        with open("/etc/oyechats/secret-config.yaml") as fh:  # noqa: PTH123
            return fh.read()

    @router.get("/not-found")
    def not_found():
        raise HTTPException(status_code=404, detail="Resource not found.")

    app.include_router(router)
    return app


@pytest.fixture()
def prod_client(failing_app, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    # ``raise_server_exceptions=False`` makes TestClient behave like a real
    # server: the handler's response is returned instead of the exception being
    # re-raised into the test. Without it these tests would assert on nothing.
    return TestClient(failing_app, raise_server_exceptions=False)


# ── Unhandled server failures ────────────────────────────────────────────────


@pytest.mark.parametrize("path", ["/boom/db", "/boom/attr", "/boom/os"])
def test_unhandled_exceptions_return_generic_500(prod_client, path):
    """Whatever broke, the client is told the same three words."""
    resp = prod_client.get(path)
    assert resp.status_code == 500
    body = resp.json()
    assert body["detail"] == "Internal server error"
    assert_no_internals(resp.text)


def test_db_failure_hides_sql_parameters_and_constraint_names(prod_client):
    """The single highest-value leak: an ORM error prints the statement, its
    bound parameters (here a bcrypt hash) and the violated index name."""
    resp = prod_client.get("/boom/db")
    assert resp.status_code == 500
    assert "$2b$12$secrethash" not in resp.text
    assert "ix_clients_email" not in resp.text
    assert "a@b.com" not in resp.text


def test_filesystem_error_hides_the_path(prod_client):
    """A FileNotFoundError names an absolute path, which maps the deployment."""
    resp = prod_client.get("/boom/os")
    assert resp.status_code == 500
    assert "/etc/oyechats" not in resp.text


def test_500_carries_a_correlation_id_in_body_and_header(prod_client):
    """Generic is only affordable because the operator can still find the trace."""
    resp = prod_client.get("/boom/attr")
    error_id = resp.json()["error_id"]
    assert error_id and len(error_id) == 12
    assert resp.headers["X-Error-Id"] == error_id


def test_error_ids_are_unique_per_occurrence(prod_client):
    first = prod_client.get("/boom/attr").json()["error_id"]
    second = prod_client.get("/boom/attr").json()["error_id"]
    assert first != second


def test_production_500_has_no_debug_field(prod_client):
    assert "debug" not in prod_client.get("/boom/attr").json()


def test_development_500_includes_a_debug_hint(failing_app, monkeypatch):
    """Prod and dev behaviour differ on purpose — and only here."""
    monkeypatch.setenv("APP_ENV", "development")
    client = TestClient(failing_app, raise_server_exceptions=False)
    body = client.get("/boom/attr").json()
    assert body["detail"] == "Internal server error"
    assert "KeyError" in body["debug"]


@pytest.mark.parametrize("app_env", ["", "prod", "Production", "PRODUCTION", "staging", "  ", "productionn"])
def test_debug_hint_fails_closed_on_unrecognised_env(monkeypatch, app_env):
    """A typo in APP_ENV must not switch exception text back on.

    Every value here is "not production" by the letter of an ``!= 'production'``
    comparison, which is how the naive spelling of this check turns a one-word
    deploy-config mistake into a fleet-wide disclosure with no other symptom.
    The switch is an allow-list of debug environments instead, so all of these
    get the production behaviour.
    """
    monkeypatch.setenv("APP_ENV", app_env)
    assert debug_hint(ValueError("secret detail")) is None


@pytest.mark.parametrize("app_env", ["development", "dev", "local", "testing", "test", "DEVELOPMENT"])
def test_debug_hint_is_available_in_debug_environments(monkeypatch, app_env):
    """The allow-list must not be so tight that local debugging loses the hint."""
    monkeypatch.setenv("APP_ENV", app_env)
    hint = debug_hint(ValueError("secret detail"))
    assert hint.startswith("ValueError")
    assert "Traceback" not in hint


def test_debug_hint_present_when_app_env_is_unset(monkeypatch):
    """Unset resolves to ``development`` — the same default ``app.config`` uses
    — so a developer who never set the variable still gets hints."""
    monkeypatch.delenv("APP_ENV", raising=False)
    assert debug_hint(ValueError("boom")) is not None


def test_debug_hint_is_none_in_production(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    assert debug_hint(ValueError("secret detail")) is None


def test_debug_hint_is_length_bounded(monkeypatch):
    """A provider exception can embed a whole serialised request; a dev-mode
    hint must not become an unbounded copy of it."""
    monkeypatch.setenv("APP_ENV", "development")
    hint = debug_hint(ValueError("x" * 5000))
    assert len(hint) < 400


# ── Validation (422) ─────────────────────────────────────────────────────────


def test_validation_error_does_not_echo_submitted_values(prod_client):
    """The leak that mattered: a type error on one field returned the whole
    submitted body, credentials included."""
    resp = prod_client.post("/login", json={"email": [], "password": "hunter2", "age": "abc"})
    assert resp.status_code == 422
    assert "hunter2" not in resp.text
    for entry in resp.json()["detail"]:
        assert "input" not in entry


def test_validation_error_does_not_leak_pydantic_version(prod_client):
    """``url`` pins the exact Pydantic minor version on a service that switches
    its OpenAPI schema off in production to deny precisely this."""
    resp = prod_client.post("/login", json={"email": 1, "password": 2, "age": "x"})
    assert_no_internals(resp.text)
    for entry in resp.json()["detail"]:
        assert "url" not in entry


def test_validation_error_keeps_the_field_and_message(prod_client):
    """Sanitising must not cost the caller the ability to fix their request —
    ``loc``/``msg`` are what the dashboard renders."""
    resp = prod_client.post("/login", json={"email": "a@b.com", "password": "x", "age": "abc"})
    entries = resp.json()["detail"]
    assert any("age" in entry["loc"] and entry["msg"] for entry in entries)


def test_validation_error_status_is_422(prod_client):
    resp = prod_client.post("/login", json={"email": "a@b.com"})
    assert resp.status_code == 422


def test_malformed_json_body_is_rejected_without_internals(prod_client):
    """Not a validation error but a parse error — a different code path."""
    resp = prod_client.post(
        "/login",
        content=b'{"email": "a@b.com", "password": ',
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422
    assert_no_internals(resp.text)


def test_public_validation_errors_strips_the_unsafe_keys():
    raw = [
        {
            "type": "string_type",
            "loc": ("body", "password"),
            "msg": "Input should be a valid string",
            "input": "hunter2",
            "url": "https://errors.pydantic.dev/2.12/v/string_type",
            "ctx": {"pattern": "^secret-internal-regex$"},
        }
    ]
    (safe,) = public_validation_errors(raw)
    assert safe == {"loc": ["body", "password"], "type": "string_type", "msg": "Input should be a valid string"}


def test_public_validation_errors_survives_unexpected_shapes():
    """This runs on the error path of every request; it must not raise."""
    assert public_validation_errors([None, "junk", {}]) == [{"msg": "Invalid value."}]


# ── Server-side observability is preserved ───────────────────────────────────


def test_log_keeps_the_failing_value_for_non_secret_fields():
    """Sanitising the *response* must not blind the operator. The log still
    carries what was actually sent, for fields that are not credentials."""
    raw = [{"type": "int_parsing", "loc": ("body", "age"), "msg": "bad int", "input": "abc"}]
    (logged,) = loggable_validation_errors(raw)
    assert logged["input"] == "'abc'"


@pytest.mark.parametrize(
    "field",
    ["password", "new_password", "api_key", "razorpay_signature", "otp", "code", "access_token", "hashed_password"],
)
def test_log_redacts_credential_fields(field):
    raw = [{"type": "string_type", "loc": ("body", field), "msg": "bad", "input": "s3cr3t-value"}]
    (logged,) = loggable_validation_errors(raw)
    assert logged["input"] == "[redacted]", f"{field} was not redacted"


def test_log_truncates_oversized_values():
    raw = [{"type": "string_type", "loc": ("body", "bio"), "msg": "bad", "input": "y" * 10_000}]
    (logged,) = loggable_validation_errors(raw)
    assert len(logged["input"]) < 200


def test_unhandled_exception_is_logged_with_traceback_and_id(prod_client, caplog):
    """'Do not silently swallow' — the generic response is paired with a full
    server-side record, keyed by the id the client was given."""
    with caplog.at_level("ERROR"):
        resp = prod_client.get("/boom/db")

    error_id = resp.json()["error_id"]
    record = next(r for r in caplog.records if error_id in r.getMessage())
    assert record.exc_info is not None, "traceback was not captured server-side"
    assert "IntegrityError" in record.getMessage()


def test_validation_failure_is_logged_below_error(prod_client, caplog):
    """A 422 is the caller's mistake. Logging it at ERROR buried real 500s."""
    with caplog.at_level("WARNING"):
        prod_client.post("/login", json={"email": [], "password": "hunter2", "age": 1})

    validation_records = [r for r in caplog.records if "Validation rejected" in r.getMessage()]
    assert validation_records, "validation failure was not logged at all"
    assert all(r.levelname == "WARNING" for r in validation_records)
    assert all("hunter2" not in r.getMessage() for r in validation_records)


# ── Status-code semantics ────────────────────────────────────────────────────


def test_http_exception_detail_is_passed_through_unchanged(prod_client):
    """Route-authored details are already client-safe and must keep working —
    the hardening targets machine-generated text, not deliberate copy."""
    resp = prod_client.get("/not-found")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Resource not found."


@pytest.fixture()
def limited_client():
    """A real SlowAPI-limited app — the stock handler's behaviour is what is
    under test, so faking the limiter would test the fake."""
    from slowapi import Limiter
    from slowapi.middleware import SlowAPIMiddleware
    from slowapi.util import get_remote_address

    limiter = Limiter(key_func=get_remote_address, storage_uri="memory://")
    app = FastAPI()
    app.state.limiter = limiter
    app.add_middleware(SlowAPIMiddleware)
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

    @app.get("/limited")
    @limiter.limit("1/minute")
    def limited(request: Request):
        return {"ok": True}

    limiter.reset()
    return TestClient(app, raise_server_exceptions=False)


def test_rate_limit_body_is_generic_and_keeps_retry_after(limited_client):
    """429 must not publish the exact configured window in the body; the timing
    a well-behaved client needs moves to Retry-After."""
    assert limited_client.get("/limited").status_code == 200
    resp = limited_client.get("/limited")

    assert resp.status_code == 429
    assert "1 per 1 minute" not in resp.text
    assert resp.json()["detail"].startswith("Too many requests")
    # SlowAPI sends no Retry-After of its own (``headers_enabled`` defaults
    # off), so a 429 here used to carry no backoff signal at all.
    assert int(resp.headers["Retry-After"]) >= 1
    assert resp.json()["retry_after_seconds"] >= 1
    # Body and Content-Length must agree — the handler rewrites the body, so
    # copying the upstream length header would truncate the response.
    assert json.loads(resp.content)["error"] == "Rate limit exceeded"


# ── Sanitizer unit behaviour ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name,expected",
    [
        ("password", True),
        ("hashed_password", True),
        ("X-API-Key", True),
        ("razorpay_signature", True),
        ("otp", True),
        ("code", True),
        ("email", False),
        ("age", False),
        ("website", False),
        (0, False),
        (None, False),
    ],
)
def test_is_sensitive_field(name, expected):
    assert is_sensitive_field(name) is expected


def test_new_error_id_is_opaque_and_random():
    ids = {new_error_id() for _ in range(200)}
    assert len(ids) == 200
    assert all(len(i) == 12 and int(i, 16) >= 0 for i in ids)


def test_public_error_body_omits_debug_in_production(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    body = public_error_body("Nope.", error_id="abc123abc123", exc=ValueError("internal"))
    assert body == {"detail": "Nope.", "error_id": "abc123abc123"}


# ── The real application, not a stand-in ─────────────────────────────────────
#
# Everything above exercises the handlers in isolation. These few pin the wiring:
# a handler that is correct but not registered protects nothing.


@pytest.fixture()
def real_app_client(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    from app.main import app

    return TestClient(app, raise_server_exceptions=False)


def test_real_app_422_carries_no_pydantic_metadata(real_app_client):
    """End-to-end through the app's own router and handler registration."""
    resp = real_app_client.post("/auth/login", json={"email": [], "password": "hunter2", "extra": {"a": 1}})
    assert resp.status_code == 422
    assert "hunter2" not in resp.text
    assert_no_internals(resp.text)
    for entry in resp.json()["detail"]:
        assert set(entry) <= {"loc", "type", "msg"}


def test_real_app_root_does_not_advertise_disabled_docs(monkeypatch):
    """``_docs_urls`` withholds the schema in production; the root banner must
    not undo that by pointing at the route anyway.

    ``APP_ENV`` is read into ``app.main`` at import and the docs routes are
    mounted from it once, so the *mounting* can only be asserted at the
    ``_docs_urls`` level (``tests/test_docs_gating.py``). What is testable here
    — and what regressed — is that the banner asks the same function rather
    than hardcoding the path.
    """
    import app.main as main_module

    monkeypatch.setattr(main_module, "APP_ENV", "production")
    assert main_module.read_root() == {"message": "RAG Backend is running"}

    monkeypatch.setattr(main_module, "APP_ENV", "development")
    assert main_module.read_root()["docs_url"] == "/docs"


def test_files_route_rejects_traversal_without_echoing_input(real_app_client):
    resp = real_app_client.get("/files/../../etc/passwd")
    assert resp.status_code in (400, 403, 404)
    assert "etc/passwd" not in resp.text


def test_files_route_404_does_not_reflect_the_requested_key(monkeypatch):
    """An unauthenticated 404 that echoes its input is a namespace oracle — and
    reflects arbitrary attacker text into a response body."""
    monkeypatch.setenv("APP_ENV", "production")
    from botocore.exceptions import ClientError

    import app.main as main_module

    def _raise_no_such_key(_key):
        raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "The key does not exist"}}, "GetObject")

    monkeypatch.setattr("app.services.r2_service.get_object", _raise_no_such_key)
    client = TestClient(main_module.app, raise_server_exceptions=False)

    probe = "logos/probe-<script>alert(1)</script>.png"
    resp = client.get(f"/files/{probe}")
    assert resp.status_code == 404
    assert "probe-" not in resp.text
    assert "script" not in resp.text.lower()
    assert resp.json()["detail"] == "File not found."
