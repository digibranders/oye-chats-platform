"""The company's own prices must not stream on a bot whose pricing goes to the team.

Production, 2026-09-10: "what is th picin for SOC as a Service" is two edits from
"pricing", so the pricing gate never fired, and Eventus (no pricing page) quoted
₹2,66,250 and more from its knowledge base.

Review, 2026-09-11: the first guard tripped on any amount, so answers about GDPR
fines, breach costs and salaries were replaced by the pricing escalation, and a
long comma-separated list of numbers stalled the stream for seconds.
"""

import itertools
import time

import pytest

from app.services import price_guard as price_guard_module
from app.services.price_guard import PriceStreamGuard, answer_trips_price_guard, price_guard_applies
from app.services.pricing_gate import _CURRENCY_AMOUNT_RE, is_pricing_question, question_has_fuzzy_price_word


def _feed(chunks, *, signal=False):
    guard = PriceStreamGuard(signal=signal)
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
def test_a_price_figure_trips_a_signalled_guard_before_it_is_emitted(chunks):
    guard, out = _feed(chunks, signal=True)
    assert guard.tripped is True
    assert "2,66,250" not in out and "499" not in out and "lakh" not in out and "1,200" not in out


@pytest.mark.parametrize("signal", [False, True])
@pytest.mark.parametrize(
    "chunks",
    [
        ["We run 24/7 monitoring across ", "3", " regions."],
        ["Founded in ", "2019", " with 18 people."],
        ["ISO 27001 and SOC 2 Type II."],
    ],
)
def test_ordinary_numbers_pass_through_intact(chunks, signal):
    guard, out = _feed(chunks, signal=signal)
    assert guard.tripped is False
    assert out == "".join(chunks)


#: Answers whose sentence names the price, each with the text the figure starts
#: at. They trip with or without a turn signal, and nothing from the figure on may
#: reach the visitor, however the answer is chunked.
PRICED_FIGURES = [
    ("SOC as a Service starts at ₹2,66,250 per month.", "₹"),
    ("The fee is ₹ 50,000 in total.", "₹"),
    ("Plans from $499 a month.", "$"),
    ("About €1.200 per seat.", "€"),
    ("Roughly £30 per user.", "£"),
    ("It is Rs. 5,000 per endpoint.", "Rs"),
    ("Plans from USD 499 monthly.", "USD"),
    ("Priced at EUR 99 flat.", "EUR"),
    ("Priced at GBP 80 flat.", "GBP"),
    ("Billed at 1,20,000/year.", "1,20,000"),
    ("Billed at 1,20,000 / yr.", "1,20,000"),
    ("It is 45,000 per user.", "45,000"),
    ("It is 3,500 per seat per month.", "3,500"),
    ("It is 12,000 per endpoint.", "12,000"),
    ("A retainer of 2,00,000 per annum.", "2,00,000"),
    ("The licence is 9,999 per licence.", "9,999"),
    # The price word comes after the figure: the figure is held until it arrives.
    ("It is ₹2,66,250 for the Pro plan.", "₹"),
    ("Around 1,200 dollars per seat.", "1,200"),
    # The longest grouped amount the figure pattern reads (32 characters).
    ("It is 123,456,789,012,345,678,901.1234 per user.", "123"),
]

#: Figures whose sentence names no price. They trip only on a turn signal; without
#: one they must reach the visitor byte for byte, however the answer is chunked.
BARE_FIGURES = [
    ("Roughly ¥3000 each.", "¥"),
    ("It is Rs 500 only.", "Rs"),
    ("It is Rs.2,66,250 all in.", "Rs"),
    ("Budget INR 2.5 lakh for it.", "INR"),
    ("A total of 2,66,250 rupees.", "2,66,250"),
    ("Around 1,200 dollars.", "1,200"),
    ("Around 40 euros a head.", "40"),
    ("Around 300 pounds a head.", "300"),
    ("Budget about 50 lakh for this.", "50"),
    ("Budget about 50 lakhs.", "50"),
    ("It comes to 3 crores.", "3"),
    ("That is 499 USD monthly.", "499"),
    ("That is 2,66,250 per month for small teams.", "2,66,250"),
    ("Support is 1,500/hr.", "1,500"),
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

#: Realistic answers carrying amounts that are not the company's price (review,
#: 2026-09-11). The first guard tripped on 38 of them.
NOT_OWN_PRICES = [
    "GDPR fines can reach €20 million or 4% of annual turnover.",
    "GDPR fines can reach EUR 20 million or 4% of turnover.",
    "GDPR fines can reach 20 million euros.",
    "DPDP penalties go up to ₹250 crore per breach.",
    "DPDP penalties go up to Rs 250 crore.",
    "DPDP penalties go up to 250 crore rupees.",
    "HIPAA fines go up to $1.5 million a year.",
    "The average data breach cost $4.45 million in 2023.",
    "In India the average breach cost INR 19.5 crore in 2024.",
    "We saved the client ₹50 lakh in the first year.",
    "We saved the client 50 lakh in the first year.",
    "We recovered $2M for a fintech client.",
    "The company raised $10M in its Series A.",
    "It is a $5 billion market.",
    "The average salary in Bangalore is ₹12 lakh a year.",
    "The average salary in Bangalore is 12 lakh per annum.",
    "The average salary is 12 LPA.",
    "2 BHK apartments start from ₹85 lakh.",
    "2 BHK apartments from 85 lakhs.",
    "Free shipping on orders over $50.",
    "Free shipping on orders above ₹499.",
    "Refunds up to ₹5,000 are processed within 3 days.",
    "The minimum wage is ₹178 per day.",
    "Income up to ₹7 lakh is tax free under the new regime.",
    "GST registration is mandatory above ₹40 lakh turnover.",
    "The ransomware demand was 50 bitcoin, about $2 million.",
    "Our clients include firms with revenue over USD 100 million.",
    "We manage assets worth ₹1,200 crore.",
    "Section 43A makes companies pay compensation; the old cap was Rs 5 crore.",
    "A scholarship of ₹25,000 is available for eligible students.",
    "Win a gift voucher worth ₹1,000.",
    "The hackathon prize pool is $10,000.",
    "Transactions above ₹2,00,000 need PAN.",
    "Cover up to ₹5 lakh per family per year under Ayushman Bharat.",
    "Stipend: 15,000 per month.",
    "Salary 45,000 per month.",
    "Loan amounts from 50,000 per user are not allowed.",
    "We handle 1,000,000 events/hour.",
    "We process 10,000 requests / hour.",
    "We monitor 1,20,000 endpoints / month.",
    "It supports 1,000 users per licence.",
    "Our SLA credits are 10% of monthly fees.",
    "Up to 5 users per seat.",
    "We have 1,500 devices per site.",
    "Python 3.11 and Node 20 LTS.",
    "C# and .NET 8.",
    "Version $1 of the API",
    "Use the $HOME variable and $PATH.",
    "Run `echo $1` in the shell.",
    "Markdown: price is **$99**",
]

PRODUCTION_ANSWER = "SOC as a Service starts at ₹2,66,250 per month for small teams."


def _splits(text):
    """The whole text, every two-way split, every three-way split, one character at a time."""
    yield [text]
    for i in range(1, len(text)):
        yield [text[:i], text[i:]]
    for i, j in itertools.combinations(range(1, len(text)), 2):
        yield [text[:i], text[i:j], text[j:]]
    yield list(text)


def _assert_nothing_from_the_figure_is_emitted(text, figure_start, *, signal):
    cut = text.index(figure_start)
    for chunks in _splits(text):
        guard, out = _feed(chunks, signal=signal)
        assert guard.tripped is True, chunks
        assert text.startswith(out), chunks
        assert len(out) <= cut, (chunks, out)


@pytest.mark.parametrize(("text", "figure_start"), PRICED_FIGURES + BARE_FIGURES, ids=lambda v: v)
def test_a_signalled_guard_emits_no_part_of_any_figure_however_the_answer_is_split(text, figure_start):
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=True)


@pytest.mark.parametrize(("text", "figure_start"), PRICED_FIGURES, ids=lambda v: v)
def test_a_figure_whose_sentence_names_a_price_trips_without_a_signal(text, figure_start):
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=False)


@pytest.mark.parametrize(("text", "figure_start"), BARE_FIGURES, ids=lambda v: v)
def test_a_figure_whose_sentence_names_no_price_streams_intact_without_a_signal(text, figure_start):
    for chunks in _splits(text):
        guard, out = _feed(chunks)
        assert guard.tripped is False, chunks
        assert out == text, chunks


@pytest.mark.parametrize("signal", [False, True])
@pytest.mark.parametrize("text", ORDINARY)
def test_ordinary_numbers_survive_every_split(text, signal):
    for chunks in _splits(text):
        guard, out = _feed(chunks, signal=signal)
        assert guard.tripped is False, chunks
        assert out == text, chunks


def test_amounts_that_are_not_the_companys_price_rarely_trip():
    tripped = [text for text in NOT_OWN_PRICES if answer_trips_price_guard(text, signal=False)]
    assert len(NOT_OWN_PRICES) == 50
    assert len(tripped) <= 3, tripped


@pytest.mark.parametrize("text", NOT_OWN_PRICES)
def test_an_answer_that_does_not_trip_streams_byte_for_byte(text):
    whole = answer_trips_price_guard(text, signal=False)
    for size in (1, 3, 7):
        guard, out = _feed([text[i : i + size] for i in range(0, len(text), size)])
        assert guard.tripped is whole, size
        if not whole:
            assert out == text, size


@pytest.mark.parametrize("signal", [False, True])
def test_the_production_answer_trips_with_or_without_a_signal(signal):
    """Without a signal it trips on "starts at"."""
    guard, out = _feed([PRODUCTION_ANSWER], signal=signal)
    assert guard.tripped is True
    assert "2,66,250" not in out


def test_a_held_figure_is_released_intact_when_its_sentence_ends_in_the_next_chunk():
    guard = PriceStreamGuard()
    assert guard.feed("Fines can reach €20 million") == "Fines can reach "
    assert guard.feed(". Talk to us.") == "€20 million. Talk to us."
    assert guard.flush() == ""
    assert guard.tripped is False


def test_a_held_figure_trips_when_a_price_word_arrives_in_the_next_chunk():
    guard = PriceStreamGuard()
    assert guard.feed("Access is ₹5,000") == "Access is "
    assert guard.feed(" per user.") == ""
    assert guard.tripped is True
    assert guard.flush() == ""


@pytest.mark.parametrize(
    "chunks",
    [
        ["Our Pro plan is ", "₹5,000 a month for teams."],
        ["The Pro pl", "an is ₹5,000 a month."],
        ["Pricing for SOC: ", "2,66,250 rupees."],
        ["It starts ", "at ", "₹5,000."],
    ],
)
def test_a_price_word_before_the_figure_in_an_earlier_chunk_trips_it(chunks):
    guard, out = _feed(chunks)
    assert guard.tripped is True
    assert "5,000" not in out and "2,66,250" not in out


@pytest.mark.parametrize(
    "chunks",
    [
        # "plan" that keeps going is "planet", not a price word.
        ["Our plan", "et team saved ₹50 lakh."],
        # The price word is in the previous sentence.
        ["Our plans are flexible. ", "Fines can reach €20 million."],
        ["Our plans are flexible.", "\nFines can reach €20 million."],
    ],
)
def test_a_price_word_outside_the_figures_sentence_does_not_trip_it(chunks):
    guard, out = _feed(chunks)
    assert guard.tripped is False
    assert out == "".join(chunks)


@pytest.mark.parametrize(
    "text",
    [
        # The full stop in "Rs." does not end the sentence that named the price.
        "The plan is priced in Rs. and the total comes to 2,66,250 rupees.",
        # Nor does a decimal point.
        "The fee is 4.5 percent, which comes to 2,66,250 rupees.",
    ],
)
def test_a_full_stop_inside_a_sentence_does_not_end_it(text):
    for size in (1, 4, len(text)):
        guard, out = _feed([text[i : i + size] for i in range(0, len(text), size)])
        assert guard.tripped is True, size
        assert "2,66,250" not in out, size


def test_a_held_sentence_is_released_at_the_cap():
    guard = PriceStreamGuard()
    long_tail = " and it rose again" * 20
    out = guard.feed("Fines reach €20 million" + long_tail)
    assert guard.tripped is False
    assert out == "Fines reach €20 million" + long_tail
    assert guard.held == ""


def test_held_is_what_never_reached_the_visitor():
    guard = PriceStreamGuard()
    assert guard.feed("Budget about 50 lakh") == "Budget about "
    assert guard.held == "50 lakh"
    guard.feed(" per seat.")
    assert guard.tripped is True
    assert guard.held == ""


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
    guard, out = _feed(["costs ", symbol, "5 flat"], signal=True)
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
    guard, out = _feed(["Open 24 hou", "rs 5 days a week."], signal=True)
    assert guard.tripped is False
    assert out == "Open 24 hours 5 days a week."


def test_a_unit_word_that_keeps_going_is_not_a_figure():
    """ "2 euro" + "pean" is "2 european", not "2 euro"."""
    guard, out = _feed(["We cover 2 euro", "pean regions."], signal=True)
    assert guard.tripped is False
    assert out == "We cover 2 european regions."


def test_nothing_is_emitted_after_a_trip():
    guard = PriceStreamGuard(signal=True)
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


_PATTERNS = ("_FIGURE_RE", "_HOLD_RE", "_OWN_PRICE_RE", "_SENTENCE_END_RE")


def _characters_scanned(monkeypatch, answer):
    counters = [_CountingPattern(getattr(price_guard_module, name)) for name in _PATTERNS]
    with monkeypatch.context() as patched:
        for name, counter in zip(_PATTERNS, counters, strict=True):
            patched.setattr(price_guard_module, name, counter)
        guard, out = _feed([answer[i : i + 3] for i in range(0, len(answer), 3)])
    assert guard.tripped is False
    assert out == answer
    return sum(counter.scanned for counter in counters)


def test_a_long_answer_streamed_in_small_chunks_is_scanned_in_linear_time(monkeypatch):
    """Held figures included: the bare figures are held until their sentences end."""
    paragraph = " ".join(ORDINARY + [text for text, _ in BARE_FIGURES])
    short = _characters_scanned(monkeypatch, " ".join([paragraph] * 5))
    long = _characters_scanned(monkeypatch, " ".join([paragraph] * 20))
    assert long < 4.5 * short
    assert long < 60 * len(" ".join([paragraph] * 20))


_COMMA_LIST = ",".join(str(560001 + i) for i in range(1000))[:6000]
_NUMBER_RUN = ("12,345.6.7,890,1.23,4" * 300)[:6000]


@pytest.mark.parametrize("signal", [False, True])
@pytest.mark.parametrize("size", [1, 2, 3, 4])
@pytest.mark.parametrize("text", [_COMMA_LIST, _NUMBER_RUN], ids=["comma_list", "digits_dots_commas"])
def test_a_long_run_of_numbers_streams_quickly(text, size, signal):
    """A 3,000-character pincode list in 4-character chunks took 14.1s (review, 2026-09-11)."""
    assert len(text) == 6000
    started = time.perf_counter()
    guard, out = _feed([text[i : i + size] for i in range(0, len(text), size)], signal=signal)
    elapsed = time.perf_counter() - started
    assert guard.tripped is False
    assert out == text
    assert elapsed < 0.2, elapsed


def test_answer_trips_price_guard_reads_a_whole_answer():
    assert answer_trips_price_guard(PRODUCTION_ANSWER, signal=False) is True
    assert answer_trips_price_guard("It ends on a figure: 50 lakh", signal=True) is True
    assert answer_trips_price_guard("It ends on a figure: 50 lakh", signal=False) is False
    assert answer_trips_price_guard("We run 24/7 monitoring across 3 regions.", signal=True) is False
    assert answer_trips_price_guard("", signal=True) is False
    assert answer_trips_price_guard(None, signal=True) is False


@pytest.mark.parametrize(
    "question",
    [
        "what is th picin for SOC",
        "iwant to know the soc pricng ?",
        "whats teh prcie",
        "chrges for the setup",
        "can I get a quotaton",
        "costng for 50 seats",
        "what are your rates",
        "what does it cost",
        "can I get a quote",
        "How much for 50 people?",
    ],
)
def test_a_question_with_a_price_word_is_a_signal_typos_included(question):
    assert question_has_fuzzy_price_word(question) is True


@pytest.mark.parametrize(
    "question",
    [
        "what are GDPR fines?",
        "and for 50 people?",
        "what places do you cover",
        "tell me about your team",
        "pric",
        "",
        None,
    ],
)
def test_a_question_without_a_price_word_is_no_signal(question):
    assert question_has_fuzzy_price_word(question) is False


@pytest.mark.parametrize("question", ["what is th picin for SOC", "whats teh prcie", "what are your rates"])
def test_the_question_signal_is_not_part_of_the_gates_decision(question):
    assert is_pricing_question(question) is False


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
