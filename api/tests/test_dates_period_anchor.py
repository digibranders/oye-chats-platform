"""B6: rolling a billing period must not ratchet a month-end anchor down.

``add_months(previous_period_end, 1)`` loses the anchor the first time a short
month clamps it — Jan 31 → Feb 28 → Mar 28 → Apr 28 — and the customer is
billed three days early for the life of the subscription. ``next_period_end``
recovers the anchor from the current period before adding.
"""

from datetime import UTC, datetime

from app.core.dates import add_months, next_period_end


def _d(y: int, m: int, d: int) -> datetime:
    return datetime(y, m, d, 17, 18, tzinfo=UTC)


def test_thirty_first_anchor_survives_february():
    # Jan 31 → Feb 28 (clamped) → the NEXT end must be Mar 31, not Mar 28.
    start, end = _d(2026, 1, 31), _d(2026, 2, 28)
    assert next_period_end(start, end, 1) == _d(2026, 3, 31)


def test_anchor_keeps_re_expanding_across_a_full_year():
    """The regression is cumulative, so walk a whole year of rolls."""
    start, end = _d(2026, 1, 31), _d(2026, 1, 31)
    seen = []
    for _ in range(12):
        new_end = next_period_end(start, end, 1)
        start, end = end, new_end
        seen.append((new_end.month, new_end.day))

    assert seen == [
        (2, 28),
        (3, 31),
        (4, 30),
        (5, 31),
        (6, 30),
        (7, 31),
        (8, 31),
        (9, 30),
        (10, 31),
        (11, 30),
        (12, 31),
        (1, 31),
    ]
    # What the old code did instead: permanent drift to the 28th.
    drifted = _d(2026, 1, 31)
    for _ in range(3):
        drifted = add_months(drifted, 1)
    assert drifted.day == 28


def test_leap_year_february():
    assert next_period_end(_d(2024, 1, 31), _d(2024, 2, 29), 1) == _d(2024, 3, 31)


def test_mid_cycle_period_is_not_re_expanded():
    """A period that ends mid-month was never clamped (an upgrade, a
    gateway-supplied period), so its own day is the anchor."""
    assert next_period_end(_d(2026, 3, 5), _d(2026, 4, 2), 1) == _d(2026, 5, 2)


def test_genuine_twenty_eighth_anchor_stays_on_the_twenty_eighth():
    assert next_period_end(_d(2026, 1, 28), _d(2026, 2, 28), 1) == _d(2026, 3, 28)


def test_annual_cycle_rolls_twelve_months():
    assert next_period_end(_d(2026, 2, 28), _d(2027, 2, 28), 12) == _d(2028, 2, 28)


def test_time_of_day_and_tzinfo_are_preserved():
    rolled = next_period_end(_d(2026, 1, 31), _d(2026, 2, 28), 1)
    assert (rolled.hour, rolled.minute, rolled.tzinfo) == (17, 18, UTC)


def test_missing_period_start_falls_back_to_the_end():
    assert next_period_end(None, _d(2026, 2, 28), 1) == _d(2026, 3, 28)
