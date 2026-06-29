"""Unit coverage for :func:`app.core.dates.trial_days_remaining`.

The helper is the single source of truth for the "N days left" count shown
on the dashboard trial banner and the billing badge. It must round UP so a
trial with a partial day left never under-counts — the floor-vs-ceil split
is exactly what caused the banner ("10 days left") and badge ("11 days left")
to disagree before this helper existed.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.core.dates import trial_days_remaining

_NOW = datetime(2026, 6, 29, 12, 0, 0, tzinfo=UTC)


def test_none_trial_end_returns_none():
    assert trial_days_remaining(None, now=_NOW) is None


def test_partial_day_rounds_up():
    # 10 days + 4 hours left → "11 days", never the truncating 10. This is
    # the exact screenshot scenario that surfaced the bug.
    trial_end = _NOW + timedelta(days=10, hours=4)
    assert trial_days_remaining(trial_end, now=_NOW) == 11


def test_whole_day_is_exact():
    trial_end = _NOW + timedelta(days=10)
    assert trial_days_remaining(trial_end, now=_NOW) == 10


def test_under_one_day_still_counts_as_one():
    # A trial expiring in 2 hours still reads "1 day left" — matches how the
    # reminder cron and badge count remaining time.
    trial_end = _NOW + timedelta(hours=2)
    assert trial_days_remaining(trial_end, now=_NOW) == 1


def test_lapsed_trial_is_zero():
    trial_end = _NOW - timedelta(hours=1)
    assert trial_days_remaining(trial_end, now=_NOW) == 0


def test_exact_boundary_is_zero():
    assert trial_days_remaining(_NOW, now=_NOW) == 0


def test_naive_trial_end_assumed_utc():
    # A naive datetime (no tzinfo) must be treated as UTC, not crash on the
    # aware/naive subtraction.
    trial_end_naive = (_NOW + timedelta(days=5, hours=1)).replace(tzinfo=None)
    assert trial_days_remaining(trial_end_naive, now=_NOW) == 6
