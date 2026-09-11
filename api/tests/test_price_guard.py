"""Price figures must not stream on a bot whose pricing goes to the team.

Production, 2026-09-10: "what is th picin for SOC as a Service" is two edits from
"pricing", so the pricing gate never fired, and Eventus (no pricing page) quoted
₹2,66,250 and more from its knowledge base.
"""

import itertools

import pytest

from app.services import price_guard as price_guard_module
from app.services.price_guard import (
    PriceStreamGuard,
    contains_price_figure,
    price_figure_start,
    price_guard_applies,
)
from app.services.pricing_gate import _CURRENCY_AMOUNT_RE


def _feed(chunks):
    guard = PriceStreamGuard()
    out = "".join(guard.feed(c) for c in chunks)
    out += guard.flush()
    return guard, out


@pytest.mark.parametrize(
    "chunks",
    [
        ["It starts at ₹2,66,250 per month."],
        ["It starts at ", "₹", "2,66,250 per month."],
        ["Budget about ", "50", " lakh for this."],
        ["Plans from USD ", "499 monthly."],
        ["Around 1,200 dollars."],
    ],
)
def test_a_price_figure_trips_the_guard_before_it_is_emitted(chunks):
    guard, out = _feed(chunks)
    assert guard.tripped is True
    assert "2,66,250" not in out and "499" not in out and "lakh" not in out and "1,200" not in out


@pytest.mark.parametrize(
    "chunks",
    [
        ["We run 24/7 monitoring across ", "3", " regions."],
        ["Founded in ", "2019", " with 18 people."],
        ["ISO 27001 and SOC 2 Type II."],
    ],
)
def test_ordinary_numbers_pass_through_intact(chunks):
    guard, out = _feed(chunks)
    assert guard.tripped is False
    assert out == "".join(chunks)


#: Answers carrying a price, each with the text the figure starts at. Nothing
#: from that point on may reach the visitor, however the answer is chunked.
FIGURES = [
    ("SOC as a Service starts at ₹2,66,250 per month.", "₹"),
    ("The fee is ₹ 50,000 in total.", "₹"),
    ("Plans from $499 a month.", "$"),
    ("About €1.200 per seat.", "€"),
    ("Roughly £30 per user.", "£"),
    ("Roughly ¥3000 each.", "¥"),
    ("It is Rs. 5,000 per endpoint.", "Rs"),
    ("It is Rs 500 only.", "Rs"),
    ("It is Rs.2,66,250 all in.", "Rs"),
    ("Budget INR 2.5 lakh for it.", "INR"),
    ("Plans from USD 499 monthly.", "USD"),
    ("Priced at EUR 99 flat.", "EUR"),
    ("Priced at GBP 80 flat.", "GBP"),
    ("A total of 2,66,250 rupees.", "2,66,250"),
    ("Around 1,200 dollars.", "1,200"),
    ("Around 40 euros a head.", "40"),
    ("Around 300 pounds a head.", "300"),
    ("Budget about 50 lakh for this.", "50"),
    ("Budget about 50 lakhs.", "50"),
    ("It comes to 3 crores.", "3"),
    ("That is 499 USD monthly.", "499"),
    ("That is 2,66,250 per month for small teams.", "2,66,250"),
    ("Billed at 1,20,000/year.", "1,20,000"),
    ("Billed at 1,20,000 / yr.", "1,20,000"),
    ("It is 45,000 per user.", "45,000"),
    ("It is 3,500 per seat per month.", "3,500"),
    ("It is 12,000 per endpoint.", "12,000"),
    ("Support is 1,500/hr.", "1,500"),
    ("A retainer of 2,00,000 per annum.", "2,00,000"),
    ("The licence is 9,999 per licence.", "9,999"),
    ("It ends on a figure: 50 lakh", "50"),
    ("It ends on a figure: 2,66,250 per month", "2,66,250"),
]

#: Answers full of numbers that are not prices. None may trip the guard, and
#: every one must reach the visitor byte for byte, however it is chunked.
ORDINARY = [
    "We run 24/7 monitoring across 3 regions.",
    "Founded in 2019 with 18 people.",
    "ISO 27001 and SOC 2 Type II certified.",
    "We are PCI DSS 4.0 compliant.",
    "Uptime is 99.9% across the year.",
    "We have 10,000 endpoints monitored today.",
    "Call 1800-123-4567 or +91 98765 43210.",
    "Upgrade to version 2.3.1 first.",
    "The report is due 10/09/2026, or 15 September 2026.",
    "Open 24 hours 5 days a week.",
    "We cover 2 European regions and 4 US states.",
    "Up to 5 per user and 2 per year.",
    "Our team of 1,200 analysts works 3 shifts per day.",
    "We process 5,000 events per second.",
    "In Q3 2026 we added 4 regions, I think.",
    "Talk to us and I can help.",
]


def _splits(text):
    """The whole text, every two-way split, every three-way split, one character at a time."""
    yield [text]
    for i in range(1, len(text)):
        yield [text[:i], text[i:]]
    for i, j in itertools.combinations(range(1, len(text)), 2):
        yield [text[:i], text[i:j], text[j:]]
    yield list(text)


@pytest.mark.parametrize(("text", "figure_start"), FIGURES, ids=[f[0] for f in FIGURES])
def test_no_part_of_a_figure_is_emitted_however_the_answer_is_split(text, figure_start):
    cut = text.index(figure_start)
    for chunks in _splits(text):
        guard, out = _feed(chunks)
        assert guard.tripped is True, chunks
        assert text.startswith(out), chunks
        assert len(out) <= cut, (chunks, out)


@pytest.mark.parametrize("text", ORDINARY)
def test_ordinary_numbers_survive_every_split(text):
    for chunks in _splits(text):
        guard, out = _feed(chunks)
        assert guard.tripped is False, chunks
        assert out == text, chunks


@pytest.mark.parametrize(
    "chunks",
    [
        ["It costs ", "₹"],
        ["It costs ", "U"],
        ["It costs ", "US"],
        ["It costs ", "I"],
        ["It costs ", "IN"],
        ["It costs ", "R"],
        ["It costs ", "Rs"],
        ["It costs ", "Rs."],
        ["It costs ", "INR "],
        ["It costs ", "2,66,250"],
        ["It costs ", "2,66,250 rupe"],
        ["It costs ", "50 la"],
        ["It costs ", "1,200 dol"],
        ["It costs ", "2,66,250 per"],
        ["It costs ", "2,66,250 per mo"],
        ["It costs ", "2,66,250/"],
        ["It costs ", "2,66,250/ye"],
    ],
)
def test_a_tail_that_could_still_become_a_figure_is_held(chunks):
    guard = PriceStreamGuard()
    assert guard.feed(chunks[0]) == chunks[0]
    assert guard.feed(chunks[1]) == ""
    assert guard.tripped is False


@pytest.mark.parametrize("symbol", ["₹", "$", "€", "£", "¥"])
def test_every_symbol_the_gate_knows_is_held_until_its_digit_arrives(symbol):
    assert _CURRENCY_AMOUNT_RE.search(f"{symbol}5")
    guard, out = _feed(["costs ", symbol, "5 flat"])
    assert guard.tripped is True
    assert out == "costs "


def test_holding_a_trailing_number_delays_only_the_number():
    guard = PriceStreamGuard()
    assert guard.feed("We cover 3") == "We cover "
    assert guard.feed(" regions and more.") == "3 regions and more."


def test_plain_text_is_not_held_at_all():
    guard = PriceStreamGuard()
    assert guard.feed("Monitoring runs all day.") == "Monitoring runs all day."


def test_a_word_split_across_chunks_is_not_read_as_a_currency_code():
    """ "hou" + "rs 5" is "hours 5", not "Rs 5"."""
    guard, out = _feed(["Open 24 hou", "rs 5 days a week."])
    assert guard.tripped is False
    assert out == "Open 24 hours 5 days a week."


def test_a_unit_word_that_keeps_going_is_not_a_figure():
    """ "2 euro" + "pean" is "2 european", not "2 euro"."""
    guard, out = _feed(["We cover 2 euro", "pean regions."])
    assert guard.tripped is False
    assert out == "We cover 2 european regions."


def test_nothing_is_emitted_after_a_trip():
    guard = PriceStreamGuard()
    guard.feed("It is ₹5")
    assert guard.tripped is True
    assert guard.feed(" and more text.") == ""
    assert guard.flush() == ""


class _CountingPattern:
    """Wraps a compiled pattern and counts the characters handed to it."""

    def __init__(self, pattern):
        self._pattern = pattern
        self.scanned = 0

    def __getattr__(self, name):
        method = getattr(self._pattern, name)

        def counted(string, *args, **kwargs):
            self.scanned += len(string)
            return method(string, *args, **kwargs)

        return counted


def test_a_long_answer_streamed_in_small_chunks_is_scanned_in_linear_time(monkeypatch):
    figure = _CountingPattern(price_guard_module._FIGURE_RE)
    hold = _CountingPattern(price_guard_module._HOLD_RE)
    monkeypatch.setattr(price_guard_module, "_FIGURE_RE", figure)
    monkeypatch.setattr(price_guard_module, "_HOLD_RE", hold)
    answer = " ".join(ORDINARY * 20)

    guard, out = _feed([answer[i : i + 3] for i in range(0, len(answer), 3)])

    assert guard.tripped is False
    assert out == answer
    assert figure.scanned + hold.scanned < 10 * len(answer)


def test_contains_price_figure_reads_a_whole_answer():
    assert contains_price_figure("SOC as a Service starts at ₹2,66,250 per month.") is True
    assert contains_price_figure("It ends on a figure: 50 lakh") is True
    assert contains_price_figure("We run 24/7 monitoring across 3 regions.") is False
    assert contains_price_figure("") is False
    assert contains_price_figure(None) is False


def test_price_figure_start_points_at_the_figure():
    assert price_figure_start("It starts at ₹2,66,250 per month.") == len("It starts at ")
    assert price_figure_start("Budget about 50 lakh") == len("Budget about ")
    assert price_figure_start("We run 24/7 monitoring across 3 regions.") is None
    assert price_figure_start(None) is None


def _applies(**over):
    kwargs = dict(
        gate_outcome="not_pricing",
        pricing_url=None,
        answer_from_knowledge_base=False,
        support_enabled=True,
        judges_bypassed=False,
    )
    kwargs.update(over)
    return price_guard_applies(**kwargs)


def test_applies_on_a_bot_whose_pricing_goes_to_the_team():
    assert _applies() is True


@pytest.mark.parametrize("pricing_url", ["", "   ", "javascript:alert(1)"])
def test_an_unusable_pricing_url_is_no_pricing_page(pricing_url):
    assert _applies(pricing_url=pricing_url) is True


@pytest.mark.parametrize(
    "over",
    [
        {"answer_from_knowledge_base": True},
        {"pricing_url": "https://acme.com/pricing"},
        {"gate_outcome": "answer"},
        {"gate_outcome": "quote_standdown"},
        {"gate_outcome": "owner_optout"},
        {"gate_outcome": "no_support_path_standdown"},
        {"gate_outcome": "escalate_no_url"},
        {"support_enabled": False},
        {"judges_bypassed": True},
    ],
)
def test_does_not_apply_where_prices_may_be_quoted_or_nothing_can_replace_them(over):
    assert _applies(**over) is False
