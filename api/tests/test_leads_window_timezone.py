"""A custom leads range is the reader's calendar days, not UTC's.

The picker sends a bare ``YYYY-MM-DD`` that the reader chose in their own
timezone, while ``ChatSession.created_at`` is stamped in UTC. Cutting the day
in UTC therefore put every reader east of it off by one at both edges: for
Asia/Kolkata (UTC+5:30) a lead captured 02:00 IST on the start day fell
outside the window, and one captured 04:30 IST on the day AFTER the end day
fell inside it.

``tz`` defaults to UTC so a client that does not send it behaves exactly as
before, and an unparseable zone degrades to UTC rather than 500ing a list of
leads.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from app.api.lead_routes import _resolve_window, _zone

IST = "Asia/Kolkata"


class TestResolveWindowTimezone:
    def test_defaults_to_utc_when_no_zone_is_given(self):
        since, until = _resolve_window(None, date(2026, 9, 2), date(2026, 9, 2))

        assert since == datetime(2026, 9, 2, 0, 0, 0, tzinfo=UTC)
        assert until.replace(microsecond=0) == datetime(2026, 9, 2, 23, 59, 59, tzinfo=UTC)

    def test_ist_day_starts_and_ends_five_and_a_half_hours_earlier_in_utc(self):
        since, until = _resolve_window(None, date(2026, 9, 2), date(2026, 9, 2), IST)

        # 2 Sep 00:00 IST is 1 Sep 18:30 UTC.
        assert since == datetime(2026, 9, 1, 18, 30, tzinfo=UTC)
        # 2 Sep 23:59:59.999999 IST is 2 Sep 18:29:59 UTC.
        assert until.replace(microsecond=0) == datetime(2026, 9, 2, 18, 29, 59, tzinfo=UTC)

    def test_a_lead_captured_early_on_the_start_day_is_inside_the_window(self):
        """02:00 IST on 2 Sep is 20:30 UTC on 1 Sep. Under the old UTC cut it
        sat before ``since`` and the reader's own lead went missing."""
        since, until = _resolve_window(None, date(2026, 9, 2), date(2026, 9, 2), IST)
        captured = datetime(2026, 9, 1, 20, 30, tzinfo=UTC)

        assert since <= captured <= until

    def test_a_lead_captured_after_the_end_day_is_outside_the_window(self):
        """04:30 IST on 3 Sep is 23:00 UTC on 2 Sep, which the old UTC cut
        wrongly included in a range ending 2 Sep."""
        _, until = _resolve_window(None, date(2026, 9, 2), date(2026, 9, 2), IST)
        captured = datetime(2026, 9, 2, 23, 0, tzinfo=UTC)

        assert captured > until

    def test_a_western_zone_shifts_the_other_way(self):
        since, _ = _resolve_window(None, date(2026, 9, 2), date(2026, 9, 2), "America/New_York")

        # 2 Sep 00:00 EDT is 2 Sep 04:00 UTC.
        assert since == datetime(2026, 9, 2, 4, 0, tzinfo=UTC)

    def test_an_unknown_zone_degrades_to_utc(self):
        since, _ = _resolve_window(None, date(2026, 9, 2), None, "Mars/Olympus_Mons")

        assert since == datetime(2026, 9, 2, 0, 0, tzinfo=UTC)

    def test_the_trailing_days_preset_ignores_the_zone(self):
        """``days`` is a rolling instant window, not a calendar one."""
        since, until = _resolve_window(7, None, None, IST)

        assert until is None
        assert since is not None


class TestZoneHelper:
    def test_known_zone_resolves(self):
        assert _zone(IST) is not None

    def test_empty_and_bad_values_fall_back_to_utc(self):
        assert _zone(None) is UTC
        assert _zone("") is UTC
        assert _zone("Not/AZone") is UTC
