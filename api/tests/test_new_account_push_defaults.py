"""Every new account and operator row starts with the same push preferences.

``push_service.muted_push_preferences`` is the documented starting point for a
new signup and a new operator: reachable, every per-event push off. Absent
preferences mean "fully opted in" (kept for rows that predate the change), so a
creation path that forgets the argument pages its person for every event.

Production audit, 2026-09-17: email signup and ``POST /operators`` passed it;
Google signup, superadmin-created accounts, affiliate signup, invite
acceptance, the owner's self-add and the websocket's owner row did not. Two
people on the same workspace could start with opposite defaults.
"""

from __future__ import annotations

import ast
from datetime import UTC, datetime
from pathlib import Path

from app.services.push_service import _operator_wants_push, muted_push_preferences

_CONSTRUCTORS = {"Client", "Operator"}


def _constructor_calls() -> list[tuple[str, ast.Call]]:
    root = Path(__file__).resolve().parents[1]
    calls: list[tuple[str, ast.Call]] = []
    for path in sorted((root / "app").rglob("*.py")):
        rel = path.relative_to(root).as_posix()
        if rel.startswith("app/db/"):
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            # ``Bot()``-style bare constructors are cache stand-ins, not new rows.
            is_new_row = (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id in _CONSTRUCTORS
                and bool(node.args or node.keywords)
            )
            if is_new_row:
                calls.append((f"{rel}:{node.lineno} {node.func.id}", node))
    return calls


def test_the_guard_sees_every_creation_path():
    # Two account paths and one operator path at least; a refactor that hides
    # the constructors from this scan must not pass it vacuously.
    names = [label.rsplit(" ", 1)[1] for label, _ in _constructor_calls()]
    assert names.count("Client") >= 4
    assert names.count("Operator") >= 4


def test_every_new_account_and_operator_starts_muted():
    missing = [
        label
        for label, call in _constructor_calls()
        if not any(
            kw.arg == "notification_preferences"
            and isinstance(kw.value, ast.Call)
            and isinstance(kw.value.func, ast.Name)
            and kw.value.func.id == "muted_push_preferences"
            for kw in call.keywords
        )
    ]
    assert missing == [], f"pass notification_preferences=muted_push_preferences(): {missing}"


def test_muted_means_reachable_but_quiet():
    prefs = muted_push_preferences()
    now = datetime(2026, 9, 17, 12, tzinfo=UTC)

    assert prefs["push"]["enabled"] is True
    assert _operator_wants_push(prefs, "handoff_request", now) is False
