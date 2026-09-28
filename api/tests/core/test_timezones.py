"""Legacy IANA zone names resolve to the canonical zone the server can load.

Chrome's ``Intl`` still names India ``Asia/Calcutta`` (the CLDR id), and
Ubuntu 24.04 ships those backward-compatible names in ``tzdata-legacy``, which
the production host does not install. Neither ``zoneinfo`` nor Postgres there
can load the legacy name, so every IST viewer's activity chart answered 422.
"""

import ast
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest

from app.core.timezones import LEGACY_ZONE_ALIASES, UnknownTimezoneError, canonical_zone_name, load_zone

APP_ROOT = Path(__file__).resolve().parents[2] / "app"


@pytest.mark.parametrize(
    ("legacy", "canonical"),
    [
        ("Asia/Calcutta", "Asia/Kolkata"),
        ("Asia/Katmandu", "Asia/Kathmandu"),
        ("Asia/Saigon", "Asia/Ho_Chi_Minh"),
        ("Asia/Rangoon", "Asia/Yangon"),
        ("Europe/Kiev", "Europe/Kyiv"),
        ("America/Buenos_Aires", "America/Argentina/Buenos_Aires"),
        ("America/Godthab", "America/Nuuk"),
    ],
)
def test_legacy_names_map_to_the_canonical_zone(legacy: str, canonical: str) -> None:
    assert canonical_zone_name(legacy) == canonical
    assert load_zone(legacy).key == canonical


def test_canonical_names_pass_through_unchanged() -> None:
    assert canonical_zone_name("Asia/Kolkata") == "Asia/Kolkata"
    assert canonical_zone_name("UTC") == "UTC"
    assert load_zone("Europe/Berlin").key == "Europe/Berlin"


def test_surrounding_whitespace_is_ignored() -> None:
    assert load_zone("  Asia/Calcutta ").key == "Asia/Kolkata"


@pytest.mark.parametrize("bad", ["", "Mars/Olympus_Mons", "../etc/passwd", "Asia", "/usr/share/zoneinfo/UTC"])
def test_unknown_zones_raise_a_value_error(bad: str) -> None:
    with pytest.raises(UnknownTimezoneError, match="Unknown timezone"):
        load_zone(bad)
    assert issubclass(UnknownTimezoneError, ValueError)


@pytest.fixture
def production_tzdata(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make legacy names unloadable, as on the Ubuntu host without ``tzdata-legacy``."""

    def _host_zoneinfo(key: str) -> ZoneInfo:
        if key in LEGACY_ZONE_ALIASES:
            raise ZoneInfoNotFoundError(f"No time zone found with key {key}")
        return ZoneInfo(key)

    monkeypatch.setattr("app.core.timezones.ZoneInfo", _host_zoneinfo)


@pytest.mark.usefixtures("production_tzdata")
def test_quiet_hours_are_cut_in_ist_for_a_legacy_zone_name() -> None:
    """22:00 to 07:00 in Asia/Calcutta: 17:00 UTC (22:30 IST) is quiet, 06:00 UTC (11:30 IST) is not."""
    from app.services.push_service import _in_quiet_hours

    quiet = {"start": "22:00", "end": "07:00", "tz": "Asia/Calcutta"}
    assert _in_quiet_hours(quiet, datetime(2026, 9, 28, 17, 0, tzinfo=UTC)) is True
    assert _in_quiet_hours(quiet, datetime(2026, 9, 28, 6, 0, tzinfo=UTC)) is False


@pytest.mark.usefixtures("production_tzdata")
def test_availability_clock_reads_ist_for_a_legacy_zone_name() -> None:
    from app.services.live_chat_availability_service import _now_in_timezone

    assert _now_in_timezone("Asia/Calcutta").utcoffset() == timedelta(hours=5, minutes=30)


def test_every_alias_target_is_a_loadable_canonical_zone() -> None:
    for legacy, canonical in LEGACY_ZONE_ALIASES.items():
        assert canonical not in LEGACY_ZONE_ALIASES, f"{legacy} -> {canonical} is itself an alias"
        assert ZoneInfo(canonical).key == canonical


def test_no_zone_is_loaded_from_a_runtime_name_outside_the_helper() -> None:
    """A ``ZoneInfo(<variable>)`` call skips the alias map and 422s an IST viewer.

    Literal names (``ZoneInfo("Asia/Kolkata")``) are fine: they are canonical by
    construction. Anything computed at runtime must go through ``load_zone``.
    """
    offenders: list[str] = []
    for path in APP_ROOT.rglob("*.py"):
        if path.name == "timezones.py" and path.parent.name == "core":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name != "ZoneInfo" or not node.args:
                continue
            arg = node.args[0]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                continue
            offenders.append(f"{path.relative_to(APP_ROOT.parent)}:{node.lineno}")
    assert not offenders, f"Use app.core.timezones.load_zone instead of ZoneInfo(<runtime name>): {offenders}"
