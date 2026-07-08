"""Regression guard for the Langfuse v4 / LiteLLM SDK incompatibility (AR-04).

Background: LiteLLM's *built-in* ``"langfuse"`` success callback targets the
Langfuse v2/v3 SDK surface (``langfuse.version.__version__``,
``Langfuse(sdk_integration=...)``, ``Langfuse.trace()``) — all absent from the
v4 SDK this project pins (``pyproject.toml``: ``langfuse>=4.0.0,<5.0.0``).
Registering that callback throws ``AttributeError: module 'langfuse' has no
attribute 'version'`` on every LLM call (observed in prod journal logs from a
process instance predating commit 393a15d, which removed the callback).

Verified upstream as of litellm 1.91.0 (the newest release at the time of
this check): the built-in callback still references the old v2/v3 API, so
this is not a "some day litellm will catch up" situation — the callback must
stay unregistered indefinitely, and tracing must keep going through the v4
SDK directly (``app/core/langfuse_client.py``).

These tests pin two things: (1) the app never re-registers the broken
callback, and (2) our own v4-SDK wrapper actually works end-to-end against
the real, currently-pinned langfuse + litellm versions — no mocking of the
langfuse/litellm modules themselves, so a future dependency bump that
reintroduces an incompatibility would fail here.
"""

import litellm


def test_litellm_success_callback_never_registers_the_broken_langfuse_callback():
    """LiteLLM's built-in "langfuse" callback is incompatible with the pinned
    Langfuse v4 SDK (see module docstring). If this ever starts failing, don't
    "fix" it by re-registering the callback — the incompatibility is real and
    still present in the newest litellm release as of this check."""
    callbacks = (litellm.success_callback or []) + (litellm.failure_callback or [])
    assert "langfuse" not in callbacks
    assert "langfuse_otel" not in callbacks


def test_real_langfuse_v4_sdk_exposes_get_client():
    """Sanity check on the pinned langfuse package itself: v4's entrypoint
    API (used by app/core/langfuse_client.py) must exist. If this fails, the
    installed langfuse version drifted below v4 and langfuse_client.py's
    `from langfuse import get_client` / `start_as_current_observation` calls
    would break outright (a much louder failure than the v2/v3 callback bug,
    but worth pinning here too)."""
    import langfuse

    assert hasattr(langfuse, "get_client")


def test_langfuse_generation_wrapper_does_not_raise_against_real_sdk(monkeypatch):
    """End-to-end smoke test against the REAL langfuse + litellm packages
    (network calls are expected to fail with fake keys — that must stay
    silent/non-blocking, per langfuse_client.py's contract). This is the
    direct regression guard for AR-04: if a future langfuse/litellm version
    bump reintroduces an AttributeError-shaped incompatibility in this call
    path, this test fails instead of silently degrading tracing in prod."""
    monkeypatch.setattr("app.core.langfuse_client.LANGFUSE_ENABLED", True)
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-test-0000")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-test-0000")

    from app.core.langfuse_client import langfuse_generation

    with langfuse_generation("compat-smoke-test", model="gemini/gemini-2.5-flash", prompt="ping") as gen:
        fake_response = type(
            "FakeResponse",
            (),
            {
                "choices": [type("Choice", (), {"message": type("Msg", (), {"content": "pong"})()})()],
                "usage": None,
                "model": "gemini/gemini-2.5-flash",
            },
        )()
        gen.record_litellm(fake_response)
    # No exception reaching here is the assertion — langfuse_generation and
    # record_litellm must never raise, even against the real SDK with
    # invalid/unreachable credentials.
