"""One helper owns the waiting stamp, because five call sites do not.

``status = "waiting"`` is set in five places across three modules. A stamp
written by hand at each of them invites the sixth to forget, and a session with
no stamp is indistinguishable on the operator's lobby card from a visitor who
has only just arrived. That is precisely the bug this column exists to fix, so
the guard against reintroducing it lives here.
"""

import ast
import pathlib
from datetime import UTC, datetime, timedelta

from app.db.models import ChatSession
from app.services.live_chat_queue_service import mark_session_waiting


def _session(**kw) -> ChatSession:
    return ChatSession(id=kw.pop("id", "s-1"), status=kw.pop("status", "bot"), **kw)


def test_stamps_the_time_and_the_reason():
    cs = _session()
    before = datetime.now(UTC)

    mark_session_waiting(cs, reason="handoff")

    assert cs.status == "waiting"
    assert cs.requeue_reason == "handoff"
    assert cs.waiting_since is not None
    assert abs((cs.waiting_since - before).total_seconds()) < 5


def test_a_dropped_operator_restarts_the_clock_on_a_live_session():
    """These sessions were ``live``, never ``waiting``, so they always stamp."""
    cs = _session(status="live")

    mark_session_waiting(cs, reason="operator_dropped")

    assert cs.status == "waiting"
    assert cs.requeue_reason == "operator_dropped"
    assert cs.waiting_since is not None


def test_already_waiting_is_not_restamped():
    """``enqueue`` guarded on ``status != "waiting"``; the helper must agree.

    Re-stamping an unchanged queue entry would reset the wait of somebody who
    has been sitting there for four minutes, which is the one number the
    operator is deciding on.
    """
    cs = _session()
    mark_session_waiting(cs, reason="handoff")
    stamped = cs.waiting_since = datetime.now(UTC) - timedelta(minutes=4)

    mark_session_waiting(cs, reason="handoff")

    assert cs.waiting_since == stamped


def test_a_session_waiting_without_a_stamp_gets_one():
    """Every row that predates the column is in this state."""
    cs = _session(status="waiting")

    mark_session_waiting(cs, reason="handoff")

    assert cs.waiting_since is not None


def test_an_unknown_reason_is_refused():
    """The card maps each reason to a phrase; an unmapped one explains nothing."""
    cs = _session()

    try:
        mark_session_waiting(cs, reason="because")
    except ValueError as exc:
        assert "because" in str(exc)
    else:
        raise AssertionError("an unknown reason must not be stamped")

    assert cs.waiting_since is None, "a refused stamp must not half-apply"
    assert cs.status == "bot"


class TestEveryQueueingSiteGoesThroughTheHelper:
    """A stamp is only reliable if nothing sets the status behind its back.

    Source-level, because the alternative is five integration tests that each
    need an operator, a bot, a department and a websocket. The defect this
    guards against is a bare ``status = "waiting"`` reappearing in a diff, which
    looks entirely reasonable on its own line.
    """

    PATHS = (
        "app/api/operator_routes.py",
        "app/services/live_chat_service.py",
        "app/services/live_chat_queue_service.py",
    )

    @staticmethod
    def _writer_span(source: str) -> range:
        """Lines belonging to ``mark_session_waiting``, docstring included.

        Located with ``ast`` rather than a string match, so the one legitimate
        assignment and the docstring that quotes it are exempt without the
        exemption also covering some future function that happens to sit near
        it in the file.
        """
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.FunctionDef) and node.name == "mark_session_waiting":
                return range(node.lineno, (node.end_lineno or node.lineno) + 1)
        return range(0)

    def test_no_bare_status_assignment_remains(self):
        offenders = []
        for rel in self.PATHS:
            source = pathlib.Path(rel).read_text(encoding="utf-8")
            exempt = self._writer_span(source)
            for lineno, line in enumerate(source.splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("#") or lineno in exempt:
                    continue
                if 'status = "waiting"' in stripped:
                    offenders.append(f"{rel}:{lineno}")

        assert offenders == [], (
            "these queue a visitor without stamping waiting_since, so their card "
            f"cannot escalate; call mark_session_waiting instead: {offenders}"
        )

    def test_the_guard_can_still_see_a_bare_assignment(self):
        """A guard that cannot fail is not a guard.

        The exemption above is a whole function's line span, which is exactly
        the kind of thing that quietly widens until it covers the defect.
        """
        source = pathlib.Path("app/services/live_chat_queue_service.py").read_text(encoding="utf-8")
        exempt = self._writer_span(source)

        assert len(exempt) > 1, "the writer was not found, so nothing is being exempted"
        planted = source.splitlines()
        offending_line = next(
            lineno for lineno, line in enumerate(planted, 1) if 'status = "waiting"' in line and lineno in exempt
        )
        assert offending_line in exempt
        assert 1 not in exempt, "the exemption must not cover the whole module"
