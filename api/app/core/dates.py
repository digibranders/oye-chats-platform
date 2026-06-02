"""Small date helpers shared by billing, subscriptions, and credit code.

Keeping these in ``app.core`` (not in ``app.api.subscription_routes`` or
``app.services.*``) avoids the routes→services→routes import cycle that
``effective_resets_at`` would otherwise force, and lets the worker pick the
same helper up without dragging in FastAPI dependencies.
"""

from datetime import datetime, timedelta


def add_months(dt: datetime, months: int) -> datetime:
    """Add ``months`` whole calendar months to ``dt``, clamping the day on
    short months (Jan 31 + 1 month → Feb 28/29).

    Used to roll a subscription period forward without depending on the
    external ``python-dateutil`` package. Preserves the original ``tzinfo``
    and the wall-clock time-of-day, so a sub created at 17:18 IST on May 30
    renews at 17:18 IST on June 30 (anniversary, not midnight UTC).
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
    return dt.replace(year=new_year, month=new_month, day=min(dt.day, last_of_month))
