"""Resolve IANA zone names the way the production host can load them.

Browsers report the zone through ``Intl.DateTimeFormat().resolvedOptions()``,
and Chrome returns the CLDR id, which for several places is a pre-2014 IANA
name: India is ``Asia/Calcutta``, not ``Asia/Kolkata``. Ubuntu 24.04 moved
every such backward-compatible name into the ``tzdata-legacy`` package, which
the production host does not install, so ``zoneinfo`` and Postgres there both
reject ``Asia/Calcutta`` while a developer Mac loads it without complaint.

Every zone name that arrives at runtime (a query parameter, a stored setting)
goes through ``load_zone``. It swaps a legacy name for the canonical zone
before anything loads it, and the returned ``ZoneInfo.key`` is that canonical
name, which is what a SQL ``timezone(...)`` call must be given as well.
"""

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Every link in tzdata 2026c whose file ``tzdata-legacy`` carries rather than
# ``tzdata`` on Ubuntu 24.04, mapped through to the zone it finally names.
# Regenerate on the host: ``L`` lines of /usr/share/zoneinfo/tzdata.zi whose
# name has no file under /usr/share/zoneinfo. The test suite asserts every
# target is itself canonical and loadable.
LEGACY_ZONE_ALIASES: dict[str, str] = {
    "Africa/Asmera": "Africa/Asmara",
    "America/Argentina/ComodRivadavia": "America/Argentina/Catamarca",
    "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
    "America/Catamarca": "America/Argentina/Catamarca",
    "America/Cordoba": "America/Argentina/Cordoba",
    "America/Fort_Wayne": "America/Indiana/Indianapolis",
    "America/Godthab": "America/Nuuk",
    "America/Indianapolis": "America/Indiana/Indianapolis",
    "America/Jujuy": "America/Argentina/Jujuy",
    "America/Knox_IN": "America/Indiana/Knox",
    "America/Louisville": "America/Kentucky/Louisville",
    "America/Mendoza": "America/Argentina/Mendoza",
    "America/Rosario": "America/Argentina/Cordoba",
    "Antarctica/South_Pole": "Antarctica/McMurdo",
    "Asia/Ashkhabad": "Asia/Ashgabat",
    "Asia/Calcutta": "Asia/Kolkata",
    "Asia/Chungking": "Asia/Shanghai",
    "Asia/Dacca": "Asia/Dhaka",
    "Asia/Katmandu": "Asia/Kathmandu",
    "Asia/Macao": "Asia/Macau",
    "Asia/Rangoon": "Asia/Yangon",
    "Asia/Saigon": "Asia/Ho_Chi_Minh",
    "Asia/Thimbu": "Asia/Thimphu",
    "Asia/Ujung_Pandang": "Asia/Makassar",
    "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
    "Atlantic/Faeroe": "Atlantic/Faroe",
    "Australia/ACT": "Australia/Sydney",
    "Australia/LHI": "Australia/Lord_Howe",
    "Australia/NSW": "Australia/Sydney",
    "Australia/North": "Australia/Darwin",
    "Australia/Queensland": "Australia/Brisbane",
    "Australia/South": "Australia/Adelaide",
    "Australia/Tasmania": "Australia/Hobart",
    "Australia/Victoria": "Australia/Melbourne",
    "Australia/West": "Australia/Perth",
    "Brazil/Acre": "America/Rio_Branco",
    "Brazil/DeNoronha": "America/Noronha",
    "Brazil/East": "America/Sao_Paulo",
    "Brazil/West": "America/Manaus",
    "Canada/Atlantic": "America/Halifax",
    "Canada/Central": "America/Winnipeg",
    "Canada/Eastern": "America/Toronto",
    "Canada/Mountain": "America/Edmonton",
    "Canada/Newfoundland": "America/St_Johns",
    "Canada/Pacific": "America/Vancouver",
    "Canada/Saskatchewan": "America/Regina",
    "Canada/Yukon": "America/Whitehorse",
    "Chile/Continental": "America/Santiago",
    "Chile/EasterIsland": "Pacific/Easter",
    "Cuba": "America/Havana",
    "Egypt": "Africa/Cairo",
    "Eire": "Europe/Dublin",
    "Europe/Kiev": "Europe/Kyiv",
    "Europe/Uzhgorod": "Europe/Kyiv",
    "Europe/Zaporozhye": "Europe/Kyiv",
    "GB": "Europe/London",
    "GB-Eire": "Europe/London",
    "GMT+0": "Etc/GMT",
    "GMT-0": "Etc/GMT",
    "GMT0": "Etc/GMT",
    "Greenwich": "Etc/GMT",
    "Hongkong": "Asia/Hong_Kong",
    "Iceland": "Atlantic/Reykjavik",
    "Iran": "Asia/Tehran",
    "Israel": "Asia/Jerusalem",
    "Jamaica": "America/Jamaica",
    "Japan": "Asia/Tokyo",
    "Kwajalein": "Pacific/Kwajalein",
    "Libya": "Africa/Tripoli",
    "Mexico/BajaNorte": "America/Tijuana",
    "Mexico/BajaSur": "America/Mazatlan",
    "Mexico/General": "America/Mexico_City",
    "NZ": "Pacific/Auckland",
    "NZ-CHAT": "Pacific/Chatham",
    "Navajo": "America/Denver",
    "PRC": "Asia/Shanghai",
    "Pacific/Enderbury": "Pacific/Kanton",
    "Pacific/Ponape": "Pacific/Pohnpei",
    "Pacific/Truk": "Pacific/Chuuk",
    "Poland": "Europe/Warsaw",
    "Portugal": "Europe/Lisbon",
    "ROC": "Asia/Taipei",
    "ROK": "Asia/Seoul",
    "Singapore": "Asia/Singapore",
    "Turkey": "Europe/Istanbul",
    "UCT": "Etc/UTC",
    "US/Alaska": "America/Anchorage",
    "US/Aleutian": "America/Adak",
    "US/Arizona": "America/Phoenix",
    "US/Central": "America/Chicago",
    "US/East-Indiana": "America/Indiana/Indianapolis",
    "US/Eastern": "America/New_York",
    "US/Hawaii": "Pacific/Honolulu",
    "US/Indiana-Starke": "America/Indiana/Knox",
    "US/Michigan": "America/Detroit",
    "US/Mountain": "America/Denver",
    "US/Pacific": "America/Los_Angeles",
    "US/Samoa": "Pacific/Pago_Pago",
    "Universal": "Etc/UTC",
    "W-SU": "Europe/Moscow",
    "Zulu": "Etc/UTC",
}

# Longer than any real zone name; bounds what an error message echoes back.
_MAX_ECHO = 64


class UnknownTimezoneError(ValueError):
    """The name is not an IANA zone this host can load, even after aliasing."""

    def __init__(self, name: str) -> None:
        super().__init__(f"Unknown timezone: {name[:_MAX_ECHO]!r}")
        self.name = name


def canonical_zone_name(name: str) -> str:
    """``name`` with surrounding whitespace dropped and any legacy alias replaced.

    Does not check the result exists; ``load_zone`` does.
    """
    stripped = name.strip()
    return LEGACY_ZONE_ALIASES.get(stripped, stripped)


def load_zone(name: str) -> ZoneInfo:
    """Load ``name`` as a ``ZoneInfo`` keyed by its canonical IANA name.

    Raises ``UnknownTimezoneError`` (a ``ValueError``) for an empty, malformed
    or unknown name.
    """
    canonical = canonical_zone_name(name)
    if not canonical:
        raise UnknownTimezoneError(name)
    try:
        return ZoneInfo(canonical)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise UnknownTimezoneError(name) from exc
