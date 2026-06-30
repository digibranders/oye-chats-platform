"""Small date helpers shared by billing, subscriptions, and credit code.

Keeping these in ``app.core`` (not in ``app.api.subscription_routes`` or
``app.services.*``) avoids the routes→services→routes import cycle that
``effective_resets_at`` would otherwise force, and lets the worker pick the
same helper up without dragging in FastAPI dependencies.
"""

import math
from datetime import UTC, datetime, timedelta


def trial_days_remaining(trial_end: datetime | None, now: datetime | None = None) -> int | None:
    """Whole days left until ``trial_end``, rounded UP (customer-facing).

    The single source of truth for every "N days left" surface so the API,
    the dashboard banner, the billing badge, and the day-N reminder cron can
    never disagree. ``ceil`` — a trial ending in 2 hours still reads as
    "1 day left", which is how customers count remaining time and matches
    :func:`app.worker.tasks` reminder cadence. The truncating
    ``timedelta.days`` is wrong here: it under-counts by one for any partial
    day (10.4 days left → 10, not 11).

    Returns ``None`` when there is no trial end, and ``0`` once the trial has
    lapsed. Naive datetimes are assumed UTC.
    """
    if trial_end is None:
        return None
    if trial_end.tzinfo is None:
        trial_end = trial_end.replace(tzinfo=UTC)
    now = now or datetime.now(UTC)
    seconds_left = (trial_end - now).total_seconds()
    if seconds_left <= 0:
        return 0
    return math.ceil(seconds_left / 86400)


def add_months(dt: datetime, months: int) -> datetime:
    """Add ``months`` whole calendar months to ``dt``, clamping the day on
    short months (Jan 31 + 1 month → Feb 28/29).

    Used to roll a subscription period forward without depending on the
    external ``python-dateutil`` package. Preserves the original ``tzinfo``
    and the wall-clock time-of-day, so a sub created at 17:18 IST on May 30
    renews at 17:18 IST on June 30 (anniversary, not midnight UTC).

    DST (M5): the production money path passes UTC / fixed-offset datetimes
    (``timestamptz`` rolls + ``datetime.now(UTC)`` expiries), for which this
    wall-clock arithmetic is exact — UTC has no DST. For a DST ``zoneinfo`` the
    offset is re-resolved for the new date and ``fold`` is preserved, so an
    ambiguous fall-back hour is handled deterministically rather than silently.

    Anniversary (N8): callers that roll a period MUST pass the original anchor,
    not the previous period-end — otherwise a 31st anchor ratchets down
    (Jan 31 → Feb 28 → Mar 28 …) and never recovers. ``min(dt.day, …)`` only
    clamps; it cannot re-expand a day the caller already collapsed.
    """
    if months == 0:
        return dt
    new_month = dt.month - 1 + months
    new_year = dt.year + new_month // 12
    new_month = new_month % 12 + 1
    # Last day of the target month (handles Feb / 30-day months).
    if new_month == 12:
        first_of_next = datetime(new_year + 1, 1, 1, tzinfo=dt.tzinfo)
    else:
        first_of_next = datetime(new_year, new_month + 1, 1, tzinfo=dt.tzinfo)
    last_of_month = (first_of_next - timedelta(days=1)).day
    return dt.replace(year=new_year, month=new_month, day=min(dt.day, last_of_month), fold=dt.fold)
