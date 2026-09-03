"""An activation the handler cannot persist must not vanish behind a 200.

``_handle_subscription_activated`` reads the customer and plan out of the
mandate's ``notes``. A mandate created anywhere but our own checkout (the
Razorpay dashboard for an enterprise deal, a legacy mandate minted before the
notes were stamped, a garbled note) arrives without them, and the handler used
to log a WARNING and return. The customer had been charged; the return ACKed
the delivery, so Razorpay stopped redelivering; and the idempotency row from
``_record_or_skip_event`` stayed behind, so a superadmin replay and
``reconcile_subscription_from_razorpay`` were both refused as duplicates. No
subscription, no invoice, no credits, and the only record of any of it was a
log line below the level anything alerts on.

The two sibling refusals directly beneath it (unknown plan, pooled-plan sink)
already do the right thing: dead-letter the charge into the list ops watches
and release the key so a deliberate second attempt can succeed once the notes
are fixed. This one now does the same.
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from sqlalchemy import Delete

from app.db.models import FailedWebhook, ProcessedWebhook
from app.services import razorpay_service

_PAST_START = 1704067200  # 2024-01-01Z
_PAST_END = 1706745600  # 2024-02-01Z


def _payload(notes: dict[str, str]) -> dict:
    return {
        "subscription": {
            "entity": {
                "id": "sub_no_notes",
                "notes": notes,
                "current_start": _PAST_START,
                "current_end": _PAST_END,
                "quantity": 1,
            }
        },
        "payment": {"entity": {"id": "pay_no_notes"}},
    }


@pytest.fixture()
def activation(monkeypatch):
    """Drive the CREATE path with a mandate whose notes cannot name an account."""

    def _run(*, notes: dict[str, str], event_id: str | None = "evt_no_notes"):
        executed: list[object] = []
        dead_letters: list[FailedWebhook] = []

        session = MagicMock()
        session.execute.side_effect = lambda stmt, *a, **k: executed.append(stmt) or MagicMock()

        @contextmanager
        def _dead_letter_session():
            dl = MagicMock()
            dl.execute.return_value.scalars.return_value.first.return_value = None
            dl.add.side_effect = dead_letters.append
            yield dl

        monkeypatch.setattr(razorpay_service, "_resolve_local_subscription", lambda *a, **k: None)
        monkeypatch.setattr("app.db.session.get_session", _dead_letter_session)
        return SimpleNamespace(
            session=session,
            executed=executed,
            dead_letters=dead_letters,
            run=lambda: razorpay_service._handle_subscription_activated(session, _payload(notes), event_id=event_id),
        )

    return _run


def _released_event_ids(executed: list[object]) -> list[str]:
    ids: list[str] = []
    for stmt in executed:
        if not isinstance(stmt, Delete) or stmt.entity_description["entity"] is not ProcessedWebhook:
            continue
        ids.extend(str(c.right.value) for c in stmt.whereclause.clauses if c.left.name == "event_id")
    return ids


@pytest.mark.parametrize(
    "notes",
    [
        {},
        {"oyechats_client_id": "1"},
        {"oyechats_plan_id": "7"},
        {"oyechats_client_id": "", "oyechats_plan_id": "7"},
    ],
    ids=["no-notes", "plan-missing", "client-missing", "client-blank"],
)
def test_a_mandate_without_an_owner_is_dead_lettered(activation, notes):
    fixture = activation(notes=notes)

    result = fixture.run()

    assert "NOT created" in result
    assert len(fixture.dead_letters) == 1
    row = fixture.dead_letters[0]
    assert row.event_type == "subscription.activated"
    assert row.status == "pending"
    assert "sub_no_notes" in (row.error or "")
    assert "pay_no_notes" in (row.error or "")


def test_the_idempotency_key_is_released_so_a_fix_can_be_replayed(activation):
    """A burned key is what made this unrecoverable without a hand edit."""
    fixture = activation(notes={}, event_id="evt_release_me")

    fixture.run()

    assert _released_event_ids(fixture.executed) == ["evt_release_me"]


def test_nothing_is_persisted_in_the_handlers_own_transaction(activation):
    """The webhook route commits whatever the handler leaves behind."""
    fixture = activation(notes={})

    fixture.run()

    fixture.session.add.assert_not_called()


def test_the_dead_letter_key_is_stable_per_mandate(activation):
    """A redelivery must land on the same open task, not stack a second one."""
    fixture = activation(notes={})

    fixture.run()

    assert fixture.dead_letters[0].event_id == f"{razorpay_service._MISSING_NOTES_DEAD_LETTER_PREFIX}sub_no_notes"
