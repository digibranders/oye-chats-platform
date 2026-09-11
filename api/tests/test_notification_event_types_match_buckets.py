"""Every notification email lookup names a bucket a customer can save.

``bot.notification_emails`` is validated by ``NotificationEmailRouting`` in
``bot_routes``: ``extra="forbid"``, one list per event. The lookup side is a bare
string, ``get_notification_recipients(bot, "<event>")``, and nothing tied the
two together. ``POST /operators/handoff`` asked for ``"handoff_requested"`` (the
webhook and audit name) while the bucket is ``handoff_request``. The per-event
lookup found nothing, the resolver fell back to the default list, and the
customer's handoff recipients were ignored. Nothing errored and nothing logged:
the mail still went somewhere, just not where the customer had routed it.

This test reads every call site under ``app/`` and holds its event type to the
schema, so the next misspelling fails here instead of in a customer's inbox.
"""

from __future__ import annotations

import ast
import pathlib
from dataclasses import dataclass

import pytest

from app.api.bot_routes import NotificationEmailRouting

_APP = pathlib.Path(__file__).resolve().parents[1] / "app"
_RESOLVER = "get_notification_recipients"

#: Event types looked up on purpose without a bucket of their own, so the
#: resolver always sends them to the default list. Listing one here is a product
#: decision: the customer has no way to route that mail separately.
_DEFAULT_ONLY_EVENT_TYPES = frozenset({"quote"})

#: Read by the resolver itself as the fallback, never passed in by a caller.
_FALLBACK_BUCKET = "default"


@dataclass(frozen=True)
class _CallSite:
    path: str
    line: int
    #: The literal event type, or ``None`` when the argument is not a string literal.
    event_type: str | None

    def __str__(self) -> str:
        return f"{self.path}:{self.line}"


def _event_type_argument(call: ast.Call) -> ast.expr | None:
    for keyword in call.keywords:
        if keyword.arg == "event_type":
            return keyword.value
    return call.args[1] if len(call.args) >= 2 else None


def _called_name(call: ast.Call) -> str | None:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def _call_sites() -> list[_CallSite]:
    sites: list[_CallSite] = []
    for path in sorted(_APP.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or _called_name(node) != _RESOLVER:
                continue
            argument = _event_type_argument(node)
            is_literal = isinstance(argument, ast.Constant) and isinstance(argument.value, str)
            sites.append(
                _CallSite(
                    path=str(path.relative_to(_APP.parent)),
                    line=node.lineno,
                    event_type=argument.value if is_literal else None,
                )
            )
    return sites


_SITES = _call_sites()
_BUCKETS = frozenset(NotificationEmailRouting.model_fields)


def test_the_call_sites_are_still_there_to_check():
    """A guard on the guard. If the scan stops matching, the parametrized test
    below runs on an empty list and protects nothing."""
    assert len(_SITES) >= 5
    assert any(site.path == "app/api/operator_routes.py" for site in _SITES)


@pytest.mark.parametrize("site", _SITES, ids=str)
def test_a_lookup_names_a_bucket_the_customer_can_save(site: _CallSite):
    assert site.event_type is not None, (
        f"{site} passes a non-literal event type to {_RESOLVER}. Use a string literal so this test can check it."
    )
    assert site.event_type in _BUCKETS | _DEFAULT_ONLY_EVENT_TYPES, (
        f"{site} looks up {site.event_type!r}, which is not a NotificationEmailRouting field "
        f"({sorted(_BUCKETS)}). A customer can never save that bucket, so the lookup always falls back "
        "to the default list and any per-event list they did save is ignored."
    )


def test_every_bucket_a_customer_can_save_is_looked_up():
    """The other direction: a bucket nothing reads saves cleanly and routes no mail."""
    looked_up = {site.event_type for site in _SITES}
    assert _BUCKETS - {_FALLBACK_BUCKET} <= looked_up


def test_the_default_only_list_is_neither_stale_nor_shadowing_a_bucket():
    looked_up = {site.event_type for site in _SITES}
    assert _DEFAULT_ONLY_EVENT_TYPES.isdisjoint(_BUCKETS), "that event now has a bucket; drop it from the exemption"
    assert looked_up >= _DEFAULT_ONLY_EVENT_TYPES, "nothing looks that event up any more; drop the exemption"
