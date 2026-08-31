"""The publisher and the subscriber must agree about the backplane.

nginx routes ``/ws/`` to ``oyechats-ws.service`` (single worker, which pins
``WS_BACKPLANE_ENABLED=true``) while ``oyechats-api.service`` runs
``WEB_CONCURRENCY=2``. The API process is the PUBLISHER: ``/operators/handoff``
runs there, and its socket maps are empty because it holds no sockets.

With the flag false on the API side, ``ws_backplane._enabled()`` short-circuits
and every publish no-ops fail-open, so a handoff never reaches an operator
holding a socket on the WS process. The symptom is the one commit 0e233fa was
written to fix: "Waiting (0)" beside a sidebar badge of 1, with no exception
and no log.

``config.py``'s own rule — "enable it BEFORE adding workers, never after" — is
what makes the default correct now: the workers were added.
"""

import importlib
import os

import pytest

import app.config as config


@pytest.fixture
def reload_flag(monkeypatch):
    def _reload(value):
        if value is None:
            monkeypatch.delenv("WS_BACKPLANE_ENABLED", raising=False)
        else:
            monkeypatch.setenv("WS_BACKPLANE_ENABLED", value)
        return importlib.reload(config).WS_BACKPLANE_ENABLED

    yield _reload
    importlib.reload(config)


def test_absent_env_var_enables_the_publisher(reload_flag):
    assert reload_flag(None) is True


def test_empty_env_var_enables_the_publisher(reload_flag):
    """The deploy writes this key unconditionally, so unset arrives as "".

    getenv(name, default) returns the empty string, never the default — the
    same trap that silently disabled RELEVANCE_GATE_ENABLED in production.
    """
    assert reload_flag("") is True


def test_explicit_false_still_disables(reload_flag):
    for value in ("false", "0", "no", "FALSE"):
        assert reload_flag(value) is False, value


def test_the_ws_unit_and_the_api_default_agree():
    """Both sides of the split must resolve true, or frames vanish one way."""
    root = os.path.join(os.path.dirname(__file__), "..")
    with open(os.path.join(root, "systemd", "oyechats-ws.service")) as fh:
        unit = fh.read()
    assert "WS_BACKPLANE_ENABLED=true" in unit, (
        "the WebSocket unit no longer pins the backplane on; if that is "
        "deliberate, the API-side default has to move with it"
    )
    assert reload_default() is True


def reload_default() -> bool:
    """The flag as it resolves with nothing in the environment."""
    saved = os.environ.pop("WS_BACKPLANE_ENABLED", None)
    try:
        return importlib.reload(config).WS_BACKPLANE_ENABLED
    finally:
        if saved is not None:
            os.environ["WS_BACKPLANE_ENABLED"] = saved
        importlib.reload(config)


def test_the_deploy_never_writes_a_false_default():
    """The workflow's :-default is the other half of the same switch."""
    root = os.path.join(os.path.dirname(__file__), "..", "..")
    with open(os.path.join(root, ".github", "workflows", "deploy-api.yml")) as fh:
        body = fh.read()
    assert "WS_BACKPLANE_ENABLED=${WS_BACKPLANE_ENABLED:-false}" not in body
    assert "WS_BACKPLANE_ENABLED=${WS_BACKPLANE_ENABLED:-true}" in body
