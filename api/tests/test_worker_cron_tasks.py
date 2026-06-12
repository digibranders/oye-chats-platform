"""Unit tests for the four trial-lifecycle + dunning cron tasks.

The tasks themselves are async wrappers around a synchronous ``_run()``
inner function that does the SQLAlchemy work. We test the public async
entry points end-to-end with a stubbed session so the behaviour the
operator depends on — correct status transitions, idempotent email
markers, day-bucket reminder cadence — is locked in regardless of any
future internal refactor.

What we cover:
    * status transitions (trialing → trial_expired, past_due → expired)
    * marker idempotency (no duplicate emails on re-runs)
    * the 7/3/1 day-bucket cadence in ``task_trial_reminder_emails``
    * ``trial_expired`` data hard-delete past ``data_retention_until``
    * dunning grace window enforcement in
      ``task_expire_past_due_subscriptions``

What we deliberately don't cover here:
    * the real Brevo email delivery (mocked out)
    * the real Postgres query planner / FK cascades (we trust SQLAlchemy)
    * the cron scheduler itself — ARQ's cron is a thin wrapper that just
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
    past_due_since: datetime | None = None,
    plan_name: str = "Starter",
    canceled_at: datetime | None = None,
    cancel_reason: str | None = None,
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
        past_due_since=past_due_since,
        plan=SimpleNamespace(name=plan_name) if plan_name else None,
        canceled_at=canceled_at,
        cancel_reason=cancel_reason,
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


# ── task_expire_trials ──────────────────────────────────────────────────────


class TestTaskExpireTrials:
    """Trialing subs past ``trial_end`` flip to ``trial_expired`` and the
    workspace owner gets one — and only one — trial-ended email."""

    @pytest.mark.asyncio
    async def test_flips_status_and_sends_email(self):
        now = datetime.now(UTC)
        sub = _trial_sub(trial_end=now - timedelta(hours=1))
        fake_session = _FakeSession([sub], {sub.client_id: _owner()})

        with (
            patch.object(cron_tasks, "logger"),
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.email_service.send_trial_ended_email") as mock_email,
        ):
            count = await cron_tasks.task_expire_trials({})

        assert count == 1
        assert sub.status == "trial_expired"
        assert sub.data_retention_until is not None
        assert sub.data_retention_until > sub.trial_end
        mock_email.assert_called_once()
        assert sub.trial_emails_sent.get("trial_ended") is not None
        assert fake_session.commit_calls == 1

    @pytest.mark.asyncio
    async def test_idempotent_skips_already_emailed(self):
        """Re-run after a partial failure: status still flips but the
        email-marker stops a second send."""
        now = datetime.now(UTC)
        sub = _trial_sub(
            trial_end=now - timedelta(hours=1),
            trial_emails_sent={"trial_ended": now.isoformat()},
        )
        fake_session = _FakeSession([sub], {sub.client_id: _owner()})

        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.email_service.send_trial_ended_email") as mock_email,
        ):
            await cron_tasks.task_expire_trials({})

        # The cron still flips status (idempotent rebuild) but does NOT
        # re-send the email — that's the whole point of the marker.
        assert sub.status == "trial_expired"
        mock_email.assert_not_called()

    @pytest.mark.asyncio
    async def test_email_failure_does_not_block_status_flip(self):
        """If Brevo errors, the status flip still commits — the email is
        retryable; the customer's trial is over either way."""
        now = datetime.now(UTC)
        sub = _trial_sub(trial_end=now - timedelta(hours=1))
        fake_session = _FakeSession([sub], {sub.client_id: _owner()})

        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch(
                "app.services.email_service.send_trial_ended_email",
                side_effect=RuntimeError("brevo down"),
            ),
        ):
            count = await cron_tasks.task_expire_trials({})

        assert count == 1
        assert sub.status == "trial_expired"
        # Marker NOT set on failure so the next run can retry.
        assert "trial_ended" not in sub.trial_emails_sent
        assert fake_session.commit_calls == 1


# ── task_trial_reminder_emails ──────────────────────────────────────────────


class TestTaskTrialReminderEmails:
    """Trial reminder cadence — day-7 / day-11 / day-13 buckets, gated by
    JSONB ``trial_emails_sent`` markers so each fires exactly once."""

    @pytest.mark.parametrize(
        "days_left,expected_marker,expected_fn",
        [
            (7, "day_7", "send_trial_day_7_email"),
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

    @pytest.mark.parametrize("days_left", [10, 5, 2])
    @pytest.mark.asyncio
    async def test_skips_off_cadence_days(self, days_left):
        """Day-10 / day-5 / day-2 are not in the cadence — nothing fires."""
        now = datetime.now(UTC)
        sub = _trial_sub(trial_end=now + timedelta(days=days_left - 1, hours=12))
        fake_session = _FakeSession([sub], {sub.client_id: _owner()})

        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.email_service.send_trial_day_7_email") as mock_d7,
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
            patch("app.services.email_service.send_trial_day_7_email") as mock_email,
        ):
            count = await cron_tasks.task_trial_reminder_emails({})

        assert count == 0
        mock_email.assert_not_called()

    @pytest.mark.asyncio
    async def test_expired_trial_yields_nothing(self):
        """``seconds_left <= 0`` short-circuits BEFORE the cadence lookup —
        ``task_expire_trials`` owns the post-trial transition."""
        now = datetime.now(UTC)
        sub = _trial_sub(trial_end=now - timedelta(hours=1))
        fake_session = _FakeSession([sub], {sub.client_id: _owner()})

        with (
            patch("app.db.session.get_session", return_value=fake_session),
            patch("app.services.email_service.send_trial_day_7_email") as mock_email,
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
        # Override execute so the second .execute() call (the Bot query)
        # returns our bot list. _FakeSession returns the same scalar set
        # for every execute(); we shadow that with a more granular stub
        # keyed by call index.
        call_count = {"n": 0}
        original_execute = fake_session.execute

        def staged_execute(stmt):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return original_execute(stmt)  # Subscription list

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

        with patch("app.db.session.get_session", return_value=fake_session):
            count = await cron_tasks.task_expire_past_due_subscriptions({})

        assert count == 1
        assert sub.status == "expired"
        assert sub.canceled_at is not None
        assert sub.cancel_reason == "dunning_grace_elapsed"
        assert fake_session.commit_calls == 1

    @pytest.mark.asyncio
    async def test_preserves_existing_canceled_at_and_reason(self):
        """Do NOT overwrite an existing customer-initiated cancellation
        stamp — only the empties get the dunning marker."""
        now = datetime.now(UTC)
        existing_canceled_at = now - timedelta(days=3)
        sub = _trial_sub(
            status="past_due",
            past_due_since=now - timedelta(days=10),
            canceled_at=existing_canceled_at,
            cancel_reason="customer_requested",
        )
        fake_session = _FakeSession([sub])

        with patch("app.db.session.get_session", return_value=fake_session):
            await cron_tasks.task_expire_past_due_subscriptions({})

        assert sub.canceled_at == existing_canceled_at
        assert sub.cancel_reason == "customer_requested"
