"""Customer-facing billing dates are IST calendar dates, whatever zone the value arrives in.

``/subscriptions/resume`` used to render ``current_period_end.date()``, which
follows the Postgres session ``TimeZone`` the row was read through: IST on a
developer database set to Asia/Kolkata, UTC in the CI container. A period
ending at 01:30 IST read "2026-10-01" on one and "2026-09-30" on the other.
"""

from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.core.dates import billing_date_iso

_IST_OFFSET = timezone(timedelta(hours=5, minutes=30))


@pytest.mark.parametrize(
    ("moment", "expected"),
    [
        # IST midnight is 18:30 UTC the day before.
        (datetime(2026, 9, 30, 18, 29, 59, tzinfo=UTC), "2026-09-30"),
        (datetime(2026, 9, 30, 18, 30, tzinfo=UTC), "2026-10-01"),
        (datetime(2026, 9, 30, 20, 0, tzinfo=UTC), "2026-10-01"),
        # The same instant as a driver returns it through an IST session.
        (datetime(2026, 10, 1, 1, 30, tzinfo=_IST_OFFSET), "2026-10-01"),
        # Naive values are UTC, as everywhere else in app.core.dates.
        (datetime(2026, 9, 30, 20, 0), "2026-10-01"),
    ],
)
def test_billing_date_is_the_ist_calendar_day(moment: datetime, expected: str) -> None:
    assert billing_date_iso(moment) == expected


def test_billing_date_passes_none_through() -> None:
    assert billing_date_iso(None) is None
