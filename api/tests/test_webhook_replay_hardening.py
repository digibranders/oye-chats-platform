"""Wave 3.4 (M-2): replay dedup on the SIGNED body, not just the header id.

The Razorpay HMAC covers only the request BODY; the event id is a header. A
replayed signed body with a FRESH header id passed both the signature check
and the event-id dedup — and was processed twice (double grants, duplicate
invoices). ``processed_webhooks.payload_digest`` (sha256 of the raw body) is
the second unique key; distinct real events never share an exact body.
"""

import os
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import ProcessedWebhook
from app.services.razorpay_service import _record_or_skip_event

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def test_fresh_event_and_digest_processes(db):
    assert _record_or_skip_event(db, "evt_replay_1", "digest-aaa") is True


def test_same_event_id_is_a_replay(db):
    assert _record_or_skip_event(db, "evt_replay_2", "digest-bbb") is True
    assert _record_or_skip_event(db, "evt_replay_2", "digest-bbb") is False


def test_same_body_with_fresh_event_id_is_a_replay(db):
    # The attack this closes: identical signed body, new header id.
    assert _record_or_skip_event(db, "evt_replay_3a", "digest-ccc") is True
    assert _record_or_skip_event(db, "evt_replay_3b", "digest-ccc") is False


def test_legacy_null_digests_do_not_collide(db):
    # Partial-unique: rows without a digest (legacy, or callers that don't
    # pass one) must never dedup against each other.
    assert _record_or_skip_event(db, "evt_replay_4a", None) is True
    assert _record_or_skip_event(db, "evt_replay_4b", None) is True


def test_pruning_cron_deletes_only_old_rows(db, monkeypatch):
    import asyncio

    from app.worker import tasks as worker_tasks

    old = ProcessedWebhook(
        event_id="evt_prune_old",
        provider="razorpay",
        processed_at=datetime.now(UTC) - timedelta(days=200),
    )
    fresh = ProcessedWebhook(
        event_id="evt_prune_fresh",
        provider="razorpay",
        processed_at=datetime.now(UTC) - timedelta(days=5),
    )
    db.add_all([old, fresh])
    db.commit()

    from contextlib import contextmanager

    @contextmanager
    def _cm():
        yield db

    import app.db.session as db_session_module

    monkeypatch.setattr(db_session_module, "get_session", _cm)

    pruned = asyncio.run(worker_tasks.task_prune_processed_webhooks({}))
    assert pruned >= 1
    remaining = {row.event_id for row in db.query(ProcessedWebhook).all()}
    assert "evt_prune_old" not in remaining
    assert "evt_prune_fresh" in remaining
