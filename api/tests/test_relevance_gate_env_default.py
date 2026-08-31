"""The gate's default must survive an empty-but-present env var.

``deploy-api.yml`` writes ``RELEVANCE_GATE_ENABLED=${VAR}`` unconditionally, so
an unset repo variable lands in ``api/.env`` as a bare ``RELEVANCE_GATE_ENABLED=``.
systemd's ``EnvironmentFile=`` sets that to ``""``, and ``os.getenv(name, default)``
returns the empty string rather than the default — so the code default could
never apply in production and scope enforcement ran off.
"""

import importlib
import os

import pytest

import app.services.relevance_gate as relevance_gate


@pytest.fixture
def reload_gate(monkeypatch):
    def _reload(value):
        if value is None:
            monkeypatch.delenv("RELEVANCE_GATE_ENABLED", raising=False)
        else:
            monkeypatch.setenv("RELEVANCE_GATE_ENABLED", value)
        return importlib.reload(relevance_gate).RELEVANCE_GATE_ENABLED

    yield _reload
    # Restore the module to whatever the ambient environment implies so later
    # tests in the same session see the real constant.
    importlib.reload(relevance_gate)


def test_empty_env_var_falls_back_to_enabled(reload_gate):
    """The production failure mode: key present, value empty."""
    assert reload_gate("") is True


def test_absent_env_var_is_enabled(reload_gate):
    assert reload_gate(None) is True


def test_explicit_false_still_disables(reload_gate):
    for value in ("false", "0", "no", "FALSE"):
        assert reload_gate(value) is False, value


def test_explicit_true_enables(reload_gate):
    for value in ("true", "1", "yes", "TRUE"):
        assert reload_gate(value) is True, value


def test_deploy_workflow_never_emits_a_bare_empty_value():
    """Guard the other half of the bug, in the deploy script itself."""
    root = os.path.join(os.path.dirname(__file__), "..", "..")
    workflow = os.path.join(root, ".github", "workflows", "deploy-api.yml")
    with open(workflow) as fh:
        body = fh.read()
    assert "RELEVANCE_GATE_ENABLED=${RELEVANCE_GATE_ENABLED}" not in body
    assert "RELEVANCE_GATE_ENABLED=${RELEVANCE_GATE_ENABLED:-true}" in body
