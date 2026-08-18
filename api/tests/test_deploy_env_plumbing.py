"""The deploy workflow's `.env` block and its `envs:` allow-list must agree.

`deploy-api.yml` rewrites `api/.env` in full on every deploy, so the droplet's
configuration is entirely what that block writes, a hand-edit on the box
survives only until the next push. The block interpolates shell variables that
`appleboy/ssh-action` only forwards if they are named in its `envs:` list. Miss
the list and the variable is simply empty inside the remote script: the deploy
goes green, the `.env` line is written as `FOO=`, and the feature is off (or
worse, the credential is blank) with nothing anywhere saying so.

That is not hypothetical, it is how `CRAWL_FAVICON_AVATAR_ENABLED` shipped
unreachable: defined in `config.py`, read by the crawl orchestrator, and never
passed to production at all.

This test only checks plumbing, not values. Whether a flag should be on is a
deployment decision; whether the deploy can express that decision at all is
what breaks silently.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

_WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "deploy-api.yml"

# `VAPID_PRIVATE_KEY` is forwarded as a secret but never interpolated into a
# `.env` line: the script writes it to `api/vapid_private_key.pem` and puts the
# computed *path* into `.env` instead, so the key material never lands in a
# world-readable env file. `VAPID_PRIVATE_KEY_FILE_PATH` is therefore assigned
# inside the remote script rather than forwarded into it.
_LOCALLY_ASSIGNED = {"VAPID_PRIVATE_KEY_FILE_PATH"}
_FORWARDED_BUT_NOT_IN_ENV_FILE = {"VAPID_PRIVATE_KEY"}


@pytest.fixture(scope="module")
def workflow() -> str:
    if not _WORKFLOW.exists():
        pytest.skip(f"{_WORKFLOW} not present (checkout without .github)")
    return _WORKFLOW.read_text()


def _allow_list(text: str) -> set[str]:
    match = re.search(r"^\s*envs:\s*(\S+)\s*$", text, re.M)
    assert match, "deploy-api.yml no longer has an `envs:` allow-list"
    return {name.strip() for name in match.group(1).split(",") if name.strip()}


def _env_file_references(text: str) -> set[str]:
    """Every `${VAR}` / `${VAR:-default}` interpolated into a `"KEY=..."` line.

    Deliberately does not require the closing quote right after `}`, a line
    like `"CORS_ORIGINS=${CORS_ORIGINS},https://x"` is perfectly ordinary, and
    anchoring on it would silently drop that variable from the comparison and
    fail the reverse check with a misleading message.
    """
    return set(re.findall(r'"\w+=[^"]*?\$\{(\w+)(?::-[^}]*)?\}', text))


def test_every_variable_the_env_file_uses_crosses_the_ssh_boundary(workflow):
    missing = _env_file_references(workflow) - _allow_list(workflow) - _LOCALLY_ASSIGNED
    assert not missing, (
        f"written into api/.env but absent from `envs:`, so they arrive empty on the droplet: {sorted(missing)}"
    )


def test_nothing_is_forwarded_that_the_env_file_never_uses(workflow):
    """The other direction, so the allow-list doesn't accumulate dead names
    that read as "this is wired up" when nothing consumes them."""
    unused = _allow_list(workflow) - _env_file_references(workflow) - _FORWARDED_BUT_NOT_IN_ENV_FILE
    assert not unused, f"forwarded to the droplet but never written to api/.env: {sorted(unused)}"


def test_the_favicon_avatar_flag_is_deployable_and_defaults_off(workflow):
    """The flag this whole plumbing exercise was for. It must be reachable from
    a GitHub Actions variable AND stay off when that variable is unset.

    An unset variable interpolates to the empty string. `config.py`'s `_env`
    already treats an empty value as absent and falls back to "false", so the
    `:-false` here is the second of two independent defaults, not the only
    one, but it is the one that keeps `api/.env` on the droplet readable as
    a statement of intent rather than a blank."""
    assert "CRAWL_FAVICON_AVATAR_ENABLED: ${{ vars.CRAWL_FAVICON_AVATAR_ENABLED }}" in workflow
    assert "CRAWL_FAVICON_AVATAR_ENABLED" in _allow_list(workflow)
    assert '"CRAWL_FAVICON_AVATAR_ENABLED=${CRAWL_FAVICON_AVATAR_ENABLED:-false}"' in workflow


def test_the_flag_is_still_shipped_off_in_code():
    """The same decision from the other side. Takes no `workflow` fixture on
    purpose. This holds in a checkout with no `.github` at all, and skipping
    it along with the workflow tests would lose the only assertion that the
    code default itself has not been flipped."""
    from app.config import CRAWL_FAVICON_AVATAR_ENABLED

    if os.getenv("CRAWL_FAVICON_AVATAR_ENABLED"):
        pytest.skip("explicitly overridden in this environment")
    assert CRAWL_FAVICON_AVATAR_ENABLED is False
