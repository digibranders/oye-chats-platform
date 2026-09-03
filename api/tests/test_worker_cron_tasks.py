"""Unit tests for the trial-lifecycle + dunning cron tasks.

The tasks themselves are async wrappers around a synchronous ``_run()``
inner function that does the SQLAlchemy work. We test the public async
entry points end-to-end with a stubbed session so the behaviour the
operator depends on (correct status transitions, idempotent email
markers, day-bucket reminder cadence) is locked in regardless of any
future internal refactor.

What we cover:
    * status transitions (past_due → expired). The trial transition moved to
      tests/test_trial_expiry_converts_to_free.py when it stopped being a flip
      and became a conversion across several real tables.
    * marker idempotency (no duplicate emails on re-runs)
    * the 7/3/1 day-bucket cadence in ``task_trial_reminder_emails``
    * ``trial_expired`` data hard-delete past ``data_retention_until``
    * dunning grace window enforcement in
      ``task_expire_past_due_subscriptions``

What we deliberately don't cover here:
    * the real Brevo email delivery (mocked out)
    * the real Postgres query planner / FK cascades (we trust SQLAlchemy)
    * the cron scheduler itself. ARQ's cron is a thin wrapper that just
      calls these awaitables at the right time
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.worker import tasks as cron_tasks

# ── Fixtures ────────────────────────────────────────────────────────────────


def _trial_sub(
    *,
    sub_id: int = 1,
    client_id: int = 100,
    status: str = "trialing",
    trial_end: datetime | None = None,
    data_retention_until: datetime | None = None,
    trial_emails_sent: dict | None = None,
    dunning_emails_sent: dict | None = None,
    past_due_since: datetime | None = None,
    plan_name: str = "Starter",
    canceled_at: datetime | None = None,
    cancel_reason: str | None = None,
    gateway_cancel_executed_at: datetime | None = None,
) -> SimpleNamespace:
    """Lightweight Subscription stand-in.

    SimpleNamespace lets the cron's attribute assignments (``sub.status = …``,
    ``sub.data_retention_until = …``, ``sub.trial_emails_sent = …``) flow
    without ORM machinery.
    """
    return SimpleNamespace(
        id=sub_id,
        client_id=client_id,
        status=status,
        trial_end=trial_end,
        data_retention_until=data_retention_until,
        trial_emails_sent=trial_emails_sent or {},
        dunning_emails_sent=dunning_emails_sent or {},
        past_due_since=past_due_since,
        razorpay_subscription_id=None,
        plan=SimpleNamespace(name=plan_name) if plan_name else None,
        canceled_at=canceled_at,
        cancel_reason=cancel_reason,
        # Read by ``transition_service.execute_gateway_cancellation``, which the
        # past-due expiry cron now calls to retire the mandate. None means "the
        # gateway cancel has not run", which is the state every one of these
        # fixtures is in.
        gateway_cancel_executed_at=gateway_cancel_executed_at,
        razorpay_plan_id=None,
        bot_id=None,
    )


def _owner(client_id: int = 100, email: str = "owner@example.com") -> SimpleNamespace:
    return SimpleNamespace(id=client_id, email=email, name="Owner Name", deactivated_at=None)


class _FakeSession:
    """Stand-in for ``app.db.session.get_session()`` that yields a session
    whose ``execute`` returns the configured subscription list and whose
    ``get`` returns the configured client row.

    Tracks ``commit`` calls and ``delete`` invocations so tests can assert
    persistence behaviour without a real DB.
    """

    def __init__(self, subs: list[SimpleNamespace], owners: dict[int, SimpleNamespace] | None = None):
        self._subs = subs
        self._owners = owners or {}
        self.commit_calls = 0
        self.rollback_calls = 0
        self.deleted: list = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, _stmt):
        subs = self._subs

        class _Scalars:
            def all(self_inner):
                return subs

            def first(self_inner):
                return subs[0] if subs else None

        class _Result:
            def scalars(self_inner):
                return _Scalars()

        return _Result()

    def get(self, _model, pk):
        return self._owners.get(pk)

    def delete(self, obj):
        self.deleted.append(obj)

    def commit(self):
        self.commit_calls += 1

    def rollback(self):
        # The past-due expiry cron rolls back a failed gateway cancel so the
        # expiry itself still commits. Counted, not ignored: a test that cannot
        # see the rollback cannot tell "the cancel failed and was contained"
        # from "the cancel never ran".
        self.rollback_calls += 1


# ── task_expire_trials ──────────────────────────────────────────────────────
#
# Covered in tests/test_trial_expiry_converts_to_free.py against real Postgres,
# not here. The task stopped being a status flip: it now moves the row onto the
# Free plan, forfeits the unused trial allowance, grants Free's, and pauses the
# knowledge across every bot on the account. Those collaborate through real
# tables (plans, credit_ledger, documents), and a hand-rolled fake session that
# had to satisfy all of them would be asserting on the fake rather than on the
# conversion. The three behaviours this class used to own, marker idempotency,
# an email failure not blocking the transition, and the transition itself, are
# all pinned there.

# ── task_trial_reminder_emails ──────────────────────────────────────────────


class TestTaskTrialReminderEmails:
    """Trial reminder cadence on the 14-day trial. Halfway (T-7) / T-3 / T-1
    buckets, gated by JSONB ``trial_emails_sent`` markers so each fires
    exactly once. Marker keys keep their historical ``day_7`` / ``day_11`` /
    ``day_13`` names across every rescale, so a subscription already carrying
    one of those slots is never sent it twice. The keys name the SLOT, not the
    day."""

    @pytest.mark.parametrize(
        "days_left,expected_marker,expected_fn",
        [
            (7, "day_7", "send_trial_halfway_email"),
            (3, "day_11", "send_trial_days_left_email"),
            (1, "day_13", "send_trial_days_left_email"),
        ],
    )
    @pytest.mark.asyncio
    async def test_fires_correct_email_for_day_bucket(self, days_left, expected_marker, expected_fn):
        now = datetime.now(UTC)
        # +0.5h margin keeps math.ceil at days_left
        sub = _trial_sub(trial_end=now + timedelta(days=days_left - 1, hours=12))
        fake_session = _FakeSession([sub], {sub.client_id: _owner()})

        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch(f"app.services.email_service.{expected_fn}") as mock_email,
        ):
            count = await cron_tasks.task_trial_reminder_emails({})

        assert count == 1
        mock_email.assert_called_once()
        assert sub.trial_emails_sent.get(expected_marker) is not None

    @pytest.mark.parametrize("days_left", [13, 5, 2])
    @pytest.mark.asyncio
    async def test_skips_off_cadence_days(self, days_left):
        """T-13 / T-5 / T-2 are not in the 14-day cadence, nothing fires."""
        now = datetime.now(UTC)
        sub = _trial_sub(trial_end=now + timedelta(days=days_left - 1, hours=12))
        fake_session = _FakeSession([sub], {sub.client_id: _owner()})

        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.email_service.send_trial_halfway_email") as mock_d7,
            patch("app.services.email_service.send_trial_days_left_email") as mock_dl,
        ):
            count = await cron_tasks.task_trial_reminder_emails({})

        assert count == 0
        mock_d7.assert_not_called()
        mock_dl.assert_not_called()

    @pytest.mark.asyncio
    async def test_marker_collision_skips_resend(self):
        """A second tick on the same day must not re-send."""
        now = datetime.now(UTC)
        sub = _trial_sub(
            trial_end=now + timedelta(days=6, hours=12),  # 7 days remaining
            trial_emails_sent={"day_7": now.isoformat()},
        )
        fake_session = _FakeSession([sub], {sub.client_id: _owner()})

        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.email_service.send_trial_halfway_email") as mock_email,
        ):
            count = await cron_tasks.task_trial_reminder_emails({})

        assert count == 0
        mock_email.assert_not_called()

    @pytest.mark.asyncio
    async def test_expired_trial_yields_nothing(self):
        """``seconds_left <= 0`` short-circuits BEFORE the cadence lookup.
        ``task_expire_trials`` owns the post-trial transition."""
        now = datetime.now(UTC)
        sub = _trial_sub(trial_end=now - timedelta(hours=1))
        fake_session = _FakeSession([sub], {sub.client_id: _owner()})

        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.email_service.send_trial_halfway_email") as mock_email,
        ):
            count = await cron_tasks.task_trial_reminder_emails({})

        assert count == 0
        mock_email.assert_not_called()


# ── task_delete_expired_trial_data ──────────────────────────────────────────


class TestTaskDeleteExpiredTrialData:
    """Past the retention window, the workspace is hard-deleted and the
    owner is marked deactivated. Idempotent via ``deactivated_at`` +
    ``data_deleted`` marker."""

    @pytest.mark.asyncio
    async def test_deletes_bots_and_deactivates_owner(self):
        now = datetime.now(UTC)
        sub = _trial_sub(
            status="trial_expired",
            data_retention_until=now - timedelta(hours=1),
        )
        owner = _owner()
        bots = [SimpleNamespace(id=1, client_id=owner.id), SimpleNamespace(id=2, client_id=owner.id)]

        fake_session = _FakeSession([sub], {sub.client_id: owner})
        # The cron issues three queries per candidate: (1) the trial_expired
        # subscription list, (2) the active-sibling defence check, (3) the
        # bot list to delete. _FakeSession returns the same scalar set for
        # every execute(); we shadow it with a per-call stub so each query
        # gets the shape it expects.
        call_count = {"n": 0}
        original_execute = fake_session.execute

        def staged_execute(stmt):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return original_execute(stmt)  # Subscription list
            if call_count["n"] == 2:
                # No active sibling → cron proceeds with the delete.
                class _NoSiblingRow:
                    def first(self):
                        return None

                return _NoSiblingRow()

            class _Scalars:
                def all(self):
                    return bots

            class _Result:
                def scalars(self):
                    return _Scalars()

            return _Result()

        fake_session.execute = staged_execute

        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.email_service.send_trial_data_deleted_email") as mock_email,
        ):
            count = await cron_tasks.task_delete_expired_trial_data({})

        assert count == 1
        assert len(fake_session.deleted) == len(bots)
        assert owner.deactivated_at is not None
        mock_email.assert_called_once()
        assert sub.trial_emails_sent.get("data_deleted") is not None

    @pytest.mark.asyncio
    async def test_skips_delete_when_client_has_active_subscription(self):
        """Data-loss regression: a customer who subscribed to a paid plan
        during the retention window must not have their workspace deleted
        by this cron. The old trial_expired row would normally be canceled
        at activation (razorpay_service.py); the cron's active-sibling
        check is defence-in-depth for the case where that cancel didn't
        happen (lost webhook, manual DB edit, future code path)."""
        now = datetime.now(UTC)
        sub = _trial_sub(
            status="trial_expired",
            data_retention_until=now - timedelta(hours=1),
        )
        owner = _owner()

        fake_session = _FakeSession([sub], {sub.client_id: owner})
        call_count = {"n": 0}
        original_execute = fake_session.execute

        def staged_execute(stmt):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return original_execute(stmt)  # Subscription list

            # Active-sibling check → returns a truthy row, meaning the
            # customer already has a live paid subscription. Cron must
            # abort the delete and null data_retention_until.
            class _SiblingRow:
                def first(self):
                    return (999,)

            return _SiblingRow()

        fake_session.execute = staged_execute

        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.email_service.send_trial_data_deleted_email") as mock_email,
        ):
            count = await cron_tasks.task_delete_expired_trial_data({})

        assert count == 0, "cron must not count a bailed-out delete"
        assert fake_session.deleted == [], "no bots should be deleted"
        assert owner.deactivated_at is None, "owner must not be deactivated"
        assert sub.data_retention_until is None, (
            "retention marker must be nulled so the cron stops re-firing on this orphan"
        )
        mock_email.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_already_deactivated_owner_with_marker(self):
        """Re-run after a partial commit failure: don't double-email if
        the previous run got far enough to deactivate AND mark."""
        now = datetime.now(UTC)
        sub = _trial_sub(
            status="trial_expired",
            data_retention_until=now - timedelta(hours=1),
            trial_emails_sent={"data_deleted": now.isoformat()},
        )
        owner = _owner()
        owner.deactivated_at = now - timedelta(minutes=10)

        fake_session = _FakeSession([sub], {sub.client_id: owner})

        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.email_service.send_trial_data_deleted_email") as mock_email,
        ):
            count = await cron_tasks.task_delete_expired_trial_data({})

        assert count == 0
        mock_email.assert_not_called()


# ── task_expire_past_due_subscriptions ──────────────────────────────────────


class TestTaskExpirePastDueSubscriptions:
    """``past_due`` subs whose ``past_due_since`` exceeds the dunning grace
    window get flipped to ``expired`` with a ``canceled_at`` stamp +
    ``cancel_reason='dunning_grace_elapsed'``."""

    @pytest.mark.asyncio
    async def test_flips_to_expired_with_reason(self):
        now = datetime.now(UTC)
        # PAYMENT_FAILED_GRACE_DAYS defaults to 7; push past_due_since out
        # by 10 days to guarantee we're past the grace window.
        sub = _trial_sub(
            status="past_due",
            past_due_since=now - timedelta(days=10),
        )
        fake_session = _FakeSession([sub])

        # The fake session cannot serve the client-level knowledge pause an
        # account-level row takes on expiry; that path has its own tests.
        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.knowledge_state_service.deactivate_client_knowledge"),
        ):
            count = await cron_tasks.task_expire_past_due_subscriptions({})

        assert count == 1
        assert sub.status == "expired"
        assert sub.canceled_at is not None
        assert sub.cancel_reason == "dunning_grace_elapsed"
        assert fake_session.commit_calls == 1

    @pytest.mark.asyncio
    async def test_preserves_existing_canceled_at_and_reason(self):
        """Do NOT overwrite an existing customer-initiated cancellation
        stamp. Only the empties get the dunning marker."""
        now = datetime.now(UTC)
        existing_canceled_at = now - timedelta(days=3)
        sub = _trial_sub(
            status="past_due",
            past_due_since=now - timedelta(days=10),
            canceled_at=existing_canceled_at,
            cancel_reason="customer_requested",
        )
        fake_session = _FakeSession([sub])

        # The fake session cannot serve the client-level knowledge pause an
        # account-level row takes on expiry; that path has its own tests.
        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.knowledge_state_service.deactivate_client_knowledge"),
        ):
            await cron_tasks.task_expire_past_due_subscriptions({})

        assert sub.canceled_at == existing_canceled_at
        assert sub.cancel_reason == "customer_requested"
