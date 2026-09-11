"""The company's own prices must not stream on a bot whose pricing goes to the team.

Production, 2026-09-10: "what is th picin for SOC as a Service" is two edits from
"pricing", so the pricing gate never fired, and a security company's bot (no pricing page) quoted
₹2,66,250 and more from its knowledge base.

Review, 2026-09-11: the first guard tripped on any amount, so answers about GDPR
fines, breach costs and salaries were replaced by the pricing escalation, and a
long comma-separated list of numbers stalled the stream for seconds.
"""

import itertools
import random
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
    ("Our fee is ₹ 50,000 in total.", "₹"),
    ("Plans from $499 a month.", "$"),
    ("About €1.200 per seat.", "€"),
    ("Roughly £30 per user.", "£"),
    ("It is Rs. 5,000 per endpoint.", "Rs"),
    ("Plans from USD 499 monthly.", "USD"),
    ("We priced it at EUR 99 flat.", "EUR"),
    ("Our price is GBP 80 flat.", "GBP"),
    ("We billed it at 1,20,000/year.", "1,20,000"),
    ("We billed it at 1,20,000 / yr.", "1,20,000"),
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


def _assert_nothing_from_the_figure_is_emitted(text, figure_start, *, signal, splits=None):
    cut = text.index(figure_start)
    for chunks in (splits or _splits)(text):
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
        # The price word is in the previous paragraph. (In the previous sentence of
        # the same paragraph it opens a price context: see ``PRICE_LISTS``.)
        ["Our pricing is simple. ", "\n\nFines can reach €20 million."],
        ["Our pricing is simple.", "\n", "\n", "Fines can reach €20 million."],
    ],
)
def test_a_price_word_outside_the_figures_paragraph_does_not_trip_it(chunks):
    guard, out = _feed(chunks)
    assert guard.tripped is False
    assert out == "".join(chunks)


@pytest.mark.parametrize(
    "text",
    [
        # The full stop in "Rs." does not end the sentence whose "we" makes the fee
        # the company's own.
        "We work in Rs. and the fee comes to 2,66,250 rupees.",
        # Nor does a decimal point.
        "We add 4.5 percent, so the fee comes to 2,66,250 rupees.",
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


_PATTERNS = ("_FIGURE_RE", "_HOLD_RE", "_PRICE_WORDS_RE", "_SENTENCE_END_RE")


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
    # One paragraph per answer: "Up to 5 per user" opens a price context that would
    # otherwise cover the bare figures after it.
    paragraph = "\n\n".join(ORDINARY + [text for text, _ in BARE_FIGURES])
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
        # One letter short of "price" (approval review, 2026-09-11).
        "pric",
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


# Approval review, 2026-09-11: statutory and third-party fees still tripped, a
# plan list whose price word sat outside the figure's sentence streamed in full,
# and typo'd "how much" and "quote" questions gave no signal.


def _chunked(text, size):
    return [text[i : i + size] for i in range(0, len(text), size)]


def _light_splits(text):
    """The whole text, every two-way split, and fixed chunk sizes: for answers too long for ``_splits``."""
    yield [text]
    for i in range(1, len(text)):
        yield [text[:i], text[i:]]
    for size in (1, 2, 3, 5, 8, 13):
        yield _chunked(text, size)


#: Someone else's fee or price: a court, a registry, a university, a regulator. A
#: fee or price word counts only as the company's own ("our", "we" or "us").
NOT_THE_COMPANYS_FEE = [
    "For a money recovery suit of ₹10 lakh in Delhi, the court fee works out to roughly ₹12,000 under the Court Fees Act.",
    "Filing a civil case in a US federal district court costs $405, which covers the $350 filing fee and a $55 administrative fee.",
    "Registration charges are 1% of the property value, capped at ₹30,000 for properties in Mumbai.",
    "The Chevening scholarship covers your tuition fees, a monthly stipend of around £1,400 and your return flights.",
    "From April 2025, first-time buyers in England pay no Stamp Duty Land Tax on homes priced up to £300,000.",
    "There is no court fee for filing a consumer complaint at the District Commission if the value of your claim is up to ₹5 lakh.",
    "Under the Motor Vehicles Act, driving without a valid licence can attract a fine of up to ₹5,000.",
    "Acmeville charges a toll of ₹150 per car.",
]


@pytest.mark.parametrize("text", NOT_THE_COMPANYS_FEE)
def test_a_fee_or_price_word_that_is_not_the_companys_own_does_not_trip(text):
    for size in (1, 4, len(text)):
        guard, out = _feed(_chunked(text, size))
        assert guard.tripped is False, size
        assert out == text, size


UNQUALIFIED_PRICE_WORDS = [
    "plan", "plans", "package", "packages", "subscription", "subscriptions", "tier", "tiers", "edition",
    "editions", "annual licence", "software license", "retainer", "quote", "quoted", "quotation", "pricing",
]  # fmt: skip
#: Billing words describe a hospital's or a courier's bill as readily as the company's (final review,
#: 2026-09-11), so they count only beside a first-person word too.
QUALIFIED_PRICE_WORDS = [
    "price", "prices", "priced", "fee", "fees", "charge", "charges", "charged", "tariff", "tariffs", "rate", "rates",
    "cost", "costs", "invoice", "invoices", "invoiced", "billed", "billing",
]  # fmt: skip


@pytest.mark.parametrize("word", UNQUALIFIED_PRICE_WORDS)
def test_a_plan_or_billing_word_makes_a_figure_the_companys_price_on_its_own(word):
    text = f"The {word} comes to ₹5,000 for small teams."
    _assert_nothing_from_the_figure_is_emitted(text, "₹", signal=False, splits=_light_splits)


@pytest.mark.parametrize(
    "text",
    [
        "It starts at ₹5,000 for small teams.",
        "Starting at ₹5,000 for small teams.",
        "Starting from ₹5,000 for small teams.",
        "It is ₹5,000 per user.",
        "It is ₹5,000 per seat.",
        "It is ₹5,000 per licence.",
        "It is ₹5,000 per license.",
        "It is ₹5,000 per device.",
        "It is ₹5,000 per endpoint.",
        "It is ₹5,000/user.",
        "It is ₹5,000 / seat.",
    ],
)
def test_a_starting_or_per_unit_phrase_makes_a_figure_the_companys_price_on_its_own(text):
    _assert_nothing_from_the_figure_is_emitted(text, "₹", signal=False, splits=_light_splits)


@pytest.mark.parametrize("word", QUALIFIED_PRICE_WORDS)
def test_a_fee_or_price_word_alone_does_not_make_a_figure_the_companys_price(word):
    text = f"The {word} comes to ₹5,000 for small teams."
    guard, out = _feed(_chunked(text, 3))
    assert guard.tripped is False
    assert out == text


@pytest.mark.parametrize("word", QUALIFIED_PRICE_WORDS)
@pytest.mark.parametrize(
    "template",
    [
        "Our {word} comes to ₹5,000 for small teams.",
        "The {word} we set comes to ₹5,000 for small teams.",
        "The {word} comes to ₹5,000 for small teams with us.",
        "The {word} comes to ₹5,000 for small teams with Us.",
        "We're told the {word} comes to ₹5,000 for small teams.",
        "We've set the {word} at ₹5,000 for small teams.",
    ],
)
def test_a_fee_or_price_word_with_our_we_or_us_trips(word, template):
    text = template.format(word=word)
    _assert_nothing_from_the_figure_is_emitted(text, "₹", signal=False, splits=_light_splits)


@pytest.mark.parametrize(
    "text",
    [
        # "US" is the country, not "us".
        "In the US the filing fee is $350.",
        "The USCIS filing fee in the US is $460.",
        # A company named in the third person is not a first-person word.
        "The Acme fee is ₹5,000 a year.",
    ],
)
def test_a_word_that_is_not_first_person_does_not_qualify_a_fee(text):
    guard, out = _feed(_chunked(text, 2))
    assert guard.tripped is False
    assert out == text


#: Price lists whose price word is outside the figure's sentence (review, 2026-09-11).
PRICE_LISTS = [
    ("We offer three plans:\n- Starter: ₹9,999/month\n- Growth: ₹24,999/month\n- Enterprise: custom", "₹"),
    ("| Plan | Price |\n|---|---|\n| Starter | $49 |\n| Growth | $149 |", "$"),
    ("Our pricing is simple. SOC as a Service is ₹2,66,250 a month for small teams.", "₹"),
    ("Here are our SOC packages.\n\n**Essentials**: ₹1,20,000 a month\n**Advanced**: ₹2,66,250 a month", "₹"),
    ("Pricing depends on endpoints. For 100 endpoints it is about $3,000 a month.", "$"),
    # A table whose header names a cost or a fee, and no other price word.
    ("| Service | Cost |\n|---|---|\n| SOC as a Service | ₹2,66,250 |", "₹"),
    ("| Service | Monthly fee |\n| --- | ---: |\n| SOC | ₹2,66,250 |", "₹"),
    # A heading, or a lead ending in a colon, carries the context across one blank line.
    ("## Pricing\n\nSOC as a Service comes to ₹2,66,250 a month.", "₹"),
    ("**Our plans**\n\nSOC as a Service comes to ₹2,66,250 a month.", "₹"),
    ("These are the options we quote on:\n\n1. SOC as a Service, ₹2,66,250 a month", "₹"),
    # A table header naming a rate or a charge (final review, 2026-09-11).
    ("| Service | Rate |\n|---|---|\n| Website audit | $2,400 |\n| SEO retainer | $1,800/month |", "$"),
    ("| Service | Charges |\n| --- | --- |\n| SOC | ₹2,66,250 |", "₹"),
    # A heading naming prices, plans, packages or rates covers its whole section.
    ("## Pricing\n\nEvery option below is billed monthly.\n\n- Starter: $29\n- Growth: $79", "$"),
    ("# Plans\n\nPick what suits you.\n\nMost teams start small.\n\n**Starter** comes to ₹999 a month.", "₹"),
    ("## Our rates\n\nWe work in two ways.\n\n### Hourly\n\nSupport is $120 an hour.", "$"),
    # A list item's indented continuation stays in the list.
    ("Our plans:\n- Starter\n  ₹9,999 a month", "₹"),
    # A plain line right after a priced line continues its paragraph, and so does
    # the next sentence.
    ("Our plans are flexible.\nFines can reach €20 million.", "€"),
    ("Our plans are flexible. Fines can reach €20 million.", "€"),
]


@pytest.mark.parametrize(("text", "figure_start"), PRICE_LISTS)
def test_a_figure_in_the_paragraph_list_or_table_of_a_price_word_trips(text, figure_start):
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=False, splits=_light_splits)


_LONG_PARAGRAPH = " It is flexible and it is reviewed every quarter." * 13


#: The context has ended before the figure.
CONTEXT_ENDED = [
    # A blank line after a lead that neither ends in a colon, is a heading, nor names plans.
    "Our pricing is simple.\n\nGDPR fines can reach €20 million.",
    # Two blank lines, even after a lead.
    "Here are our plans:\n\n\nGDPR fines can reach €20 million.",
    # A plain line after a list.
    "We offer three plans:\n- Starter\n- Growth\nGDPR fines can reach €20 million.",
    # A plain line after a table.
    "| Plan | Seats |\n|---|---|\n| Starter | 5 |\nGDPR fines can reach €20 million.",
    # More than 600 characters after the last price word.
    "Our pricing is simple." + _LONG_PARAGRAPH + " GDPR fines can reach €20 million.",
    # A table header without a price word, and a data row that names a fee.
    "| Law | Maximum |\n|---|---|\n| GDPR | €20 million |",
]


@pytest.mark.parametrize("text", CONTEXT_ENDED)
def test_a_figure_after_the_price_context_ends_streams_intact(text):
    for chunks in _light_splits(text):
        guard, out = _feed(chunks)
        assert guard.tripped is False, chunks
        assert out == text, chunks


def test_the_price_context_cap_counts_from_the_last_price_word():
    text = "Our pricing is simple." + _LONG_PARAGRAPH + " Every plan is reviewed. GDPR fines can reach €20 million."
    assert len(_LONG_PARAGRAPH) > 600
    _assert_nothing_from_the_figure_is_emitted(text, "€", signal=False, splits=_light_splits)


#: Answers for the whole-answer and stream comparison: every list above, and the
#: held-sentence cap cases.
_HOLD_CAP_TAIL = " and it rose again" * 20
EQUIVALENCE = [
    *(text for text, _ in PRICE_LISTS),
    *CONTEXT_ENDED,
    *NOT_THE_COMPANYS_FEE,
    "Fines reach €20 million" + _HOLD_CAP_TAIL + " on the Pro plan.",
    "Fines reach €20 million" + _HOLD_CAP_TAIL + " and €30 million on the Pro plan.",
    "The fee is €20 million" + _HOLD_CAP_TAIL + " for us.",
    "Fines reach €20 million" + " and more" * 30 + " on the Pro plan.",
]


@pytest.mark.parametrize("text", EQUIVALENCE)
def test_the_whole_answer_decides_as_the_stream_does(text):
    whole = answer_trips_price_guard(text, signal=False)
    for chunks in _light_splits(text):
        guard, out = _feed(chunks)
        assert guard.tripped is whole, chunks
        if not whole:
            assert out == text, chunks


def test_a_price_word_past_the_hold_cap_does_not_trip_the_held_figure():
    """The whole answer tripped here while the stream released it (review, 2026-09-11)."""
    text = "Fines reach €20 million" + _HOLD_CAP_TAIL + " on the Pro plan."
    assert answer_trips_price_guard(text, signal=False) is False


@pytest.mark.parametrize(
    "abbreviation", ["p.m.", "p.a.", "a.m.", "approx.", "incl.", "excl.", "e.g.", "i.e.", "vs.", "no.", "nos.", "avg.",
                     "min.", "max.", "est.", "Rs.", "Dr.", "Mr.", "Mrs.", "Ms.", "St.", "Jr.", "Sr.", "Inc.", "Ltd.",
                     "Pvt.", "Co.", "Corp.", "Bros.", "Adv.", "Prof.", "No.", "S.", "S.K."]
)  # fmt: skip
def test_an_abbreviation_does_not_end_the_held_figures_sentence(abbreviation):
    text = f"Fines reach €20 million {abbreviation} on the Pro plan."
    _assert_nothing_from_the_figure_is_emitted(text, "€", signal=False, splits=_light_splits)


_NEW_CODES = [
    "AED", "SGD", "AUD", "CAD", "JPY", "CNY", "CHF", "NZD", "ZAR", "SAR", "QAR", "KWD", "MYR", "IDR", "PHP", "BDT",
    "LKR", "NPR", "PKR", "HKD", "SEK", "NOK", "DKK", "THB", "VND", "KRW", "BRL", "MXN", "TRY", "EGP", "NGN", "KES",
]  # fmt: skip


@pytest.mark.parametrize("code", _NEW_CODES)
def test_a_currency_code_before_an_amount_is_a_figure(code):
    _assert_nothing_from_the_figure_is_emitted(f"It is {code} 4,500 flat.", code, signal=True, splits=_light_splits)
    _assert_nothing_from_the_figure_is_emitted(f"It is {code} 49.99 flat.", code, signal=True, splits=_light_splits)


@pytest.mark.parametrize(
    "text",
    [
        "Try 3 options first.",
        "try 20 times.",
        "We support PHP 8.2 and PHP 7.4.",
        "Use CAD 3 for drafting.",
        "No 5 is out.",
    ],
)
def test_a_word_or_version_that_looks_like_a_currency_code_is_not_a_figure(text):
    guard, out = _feed(_chunked(text, 2), signal=True)
    assert guard.tripped is False
    assert out == text


@pytest.mark.parametrize("text", ["It costs 49.99 per month.", "It is 19.99/mo.", "It is 4.50 per user per month."])
def test_a_decimal_amount_billed_by_a_period_trips_a_signalled_guard(text):
    figure_start = next(ch for ch in text if ch.isdigit())
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=True, splits=_light_splits)


@pytest.mark.parametrize(
    "question",
    [
        "hw much",
        "how mcuh for vapt",
        "qoute for 3 sites",
        "whats the cots of soc",
        "hoe much is it",
        "hwo much for 50 seats",
        "hows much",
        "how mch",
        "how muhc",
        "how mich for SOC",
        "how mutch",
        "how expensive is SOC",
        "how pricey is it",
        "what plans do you offer?",
        "tell me about your SOC packages",
        "which plan suits 100 endpoints?",
        "do you have a subscription",
        "which tier do I need",
        "is there an enterprise edition",
        "prcie for soc",
        "cosst of vapt",
        "raets for pen testing",
        "fese for onboarding",
        "quoet for 3 sites",
        "what is the fee",
        "whats the rate",
        "our budget is limited",
        "send the tariff",
        "tarrif pls",
        "tarif pls",
        "pricelist",
        "price list please",
        "ratecard",
        "rate card please",
        "what are the charges",
        # Final review, 2026-09-11.
        "rtae for night guards",
        "what do u chrage",
        "chrage for setup",
        "budjet for a website",
        "subscripton options",
        "how muc is it",
        "which plans do you have for small clinics",
        "is there a tier for 3 users",
    ],
)
def test_a_typod_how_much_quote_or_plan_question_is_a_signal(question):
    assert question_has_fuzzy_price_word(question) is True


@pytest.mark.parametrize(
    "question",
    [
        "how many clients do you have",
        "what's your business continuity plan?",
        "do you have an incident response plan",
        "can you share an action plan",
        "what do most clients use",
        "is it quite secure",
        "what dates are you open",
        "where is your head office",
        "do you host on AWS",
        "I feel the dashboard is slow",
        "what is the prime benefit",
        "who won the prize",
        "can you post a case study",
        "is there a storage quota",
        "what gates do you check",
        "how long does onboarding take",
        "what certifications do you hold",
        "do you support SIEM integration",
        "how does it work",
        "what did we lose last year",
        # Final review, 2026-09-11.
        "who is in charge of onboarding",
        "is EV charging available at the office",
        "can I charge my phone at the venue",
        "do you have offices in tier 1 cities",
        "we are a tier 2 city startup",
        "do you hire in tier-3 towns",
        "what changes did you make to the app",
        "can I change the date",
        "is there a gate pass",
        "what is the average salary package for freshers",
        "do you accept health insurance plans",
        "can you share a treatment plan",
    ],
)
def test_an_ordinary_question_is_no_signal(question):
    assert question_has_fuzzy_price_word(question) is False


@pytest.mark.parametrize("question", ["hw much", "qoute for 3 sites", "whats the cots of soc", "how mcuh for vapt"])
def test_the_typo_signal_stays_out_of_the_gates_decision(question):
    assert is_pricing_question(question) is False


#: Amounts that are not the company's price, from the approval review's first set (2026-09-11).
REVIEW_NOT_OWN_PRICES = [
    "Under the CCPA, each intentional violation can draw a civil penalty of up to $7,500.",
    "The Consumer Protection Authority can impose a penalty of up to ₹10 lakh on a misleading advertisement, rising to ₹50 lakh for repeat offences.",
    "Under Singapore's PDPA, the regulator can fine an organisation up to S$1 million or 10% of its annual turnover in Singapore.",
    "India's cybersecurity services market is projected to cross USD 7.6 billion by 2027.",
    "The global SIEM market was valued at roughly $5.5 billion last year and is growing about 10% a year.",
    "The Startup India Seed Fund Scheme gives up to ₹20 lakh as a grant for proof of concept and up to ₹50 lakh as debt for market entry.",
    "The Chevening scholarship covers your tuition fees, a monthly stipend of around £1,400 and your return flights.",
    "Eligible students receive ₹12,000 a year under the National Means-cum-Merit Scholarship.",
    "With a net monthly salary of ₹75,000, you could be eligible for a home loan of about ₹55 lakh over 20 years, depending on your existing EMIs.",
    "Personal loans are available from ₹50,000 up to ₹40 lakh, with tenures of 12 to 72 months.",
    "For a two-wheeler loan we finance up to 95% of the on-road price, so a bike costing ₹1,20,000 needs a down payment of about ₹6,000.",
    "The policy covers hospitalisation expenses up to ₹5 lakh a year for the whole family.",
    "The personal accident rider pays ₹25 lakh to your nominee in case of accidental death.",
    "Motor third-party cover has no upper limit for death or injury, and damage to third-party property is covered up to ₹7.5 lakh.",
    "The government guideline value for residential sites in Whitefield is about ₹6,200 per sq ft.",
    "Stamp duty in Mumbai is 6%, so a flat with an agreement value of ₹1.2 crore attracts about ₹7.2 lakh in stamp duty.",
    "Registration charges are 1% of the property value, capped at ₹30,000 for properties in Mumbai.",
    "For a money recovery suit of ₹10 lakh in Delhi, the court fee works out to roughly ₹12,000 under the Court Fees Act.",
    "Filing a consumer complaint for claims up to ₹5 lakh is free at the District Commission.",
    "Under PM-KISAN, eligible farmer families get ₹6,000 a year, paid in three instalments of ₹2,000.",
    "The Atal Pension Yojana guarantees a monthly pension between ₹1,000 and ₹5,000 from age 60.",
    "Under the PM Surya Ghar scheme, households get a subsidy of up to ₹78,000 for a 3 kW rooftop solar system.",
    "Cash donations above ₹2,000 do not qualify for a deduction under Section 80G, so please donate online or by cheque.",
    "For any single gift of $250 or more, the IRS requires a written acknowledgment from the charity.",
    "The NotPetya attack in 2017 cost Maersk an estimated $300 million in lost business.",
    "Equifax agreed to a settlement of up to $700 million after its 2017 breach.",
    "Under the new regime for FY 2025-26, income from ₹4 lakh to ₹8 lakh is taxed at 5%, and a rebate makes income up to ₹12 lakh tax free.",
    "TDS on rent applies once payments cross ₹50,000 a month.",
    "Overtime is paid at twice the ordinary rate, so a worker earning ₹600 for an eight-hour day gets ₹150 for each overtime hour.",
    "In Delhi the minimum wage for unskilled workers is ₹18,066 a month from October.",
]

#: The approval review's second, independent set (2026-09-11).
REVIEW_BLIND_NOT_OWN_PRICES = [
    "Under the Motor Vehicles (Amendment) Act, 2019, driving without a valid licence can attract a fine of up to ₹5,000. Repeat offences may also lead to other action by the traffic authorities.",
    "The Central Consumer Protection Authority can impose a penalty of up to ₹10 lakh on a manufacturer or endorser for a false or misleading advertisement. For repeat offences this can go up to ₹50 lakh.",
    "In the US, each email that violates the CAN-SPAM Act can lead to civil penalties of up to $53,088, so it's worth checking your unsubscribe links and sender details.",
    "Most analyst reports put the global cloud computing market at over $600 billion in 2024, and it is still growing at double digits every year.",
    "Several industry estimates project India's D2C market to reach about $60 billion by 2027, driven mainly by beauty, fashion and food brands.",
    "According to Ecommerce Europe, B2C e-commerce turnover in Europe reached nearly €887 billion in 2023.",
    "The INSPIRE Scholarship for Higher Education offers ₹80,000 per year to students pursuing a degree in the natural and basic sciences.",
    "For the 2024 to 2025 award year, the maximum Federal Pell Grant is $7,395. Your actual award depends on your financial need and enrolment status.",
    "Under the Startup India Seed Fund Scheme, eligible startups can receive a grant of up to ₹20 lakh for proof of concept and prototype development.",
    "With a net monthly income of ₹50,000 and no existing EMIs, you may be eligible for a home loan of roughly ₹30 to 35 lakh. The final amount depends on your age, tenure and credit score.",
    "To apply for our personal loan, you need a minimum net monthly salary of ₹25,000 if you live in a metro city.",
    "Education loans of up to ₹7.5 lakh generally don't need any collateral, as they can be covered under the government's credit guarantee scheme.",
    "Our term plan lets you choose a sum assured anywhere from ₹25 lakh up to ₹5 crore, subject to your income and medical underwriting.",
    "Your family floater policy has a room rent limit of 1% of the sum insured, so on a ₹5 lakh cover you can claim up to ₹5,000 per day for the room.",
    "Our Schengen travel insurance includes medical cover of €30,000, which is the minimum the embassies require for a visa application.",
    "In Mumbai, stamp duty is 6% of the property value including the 1% metro cess, so a ₹1 crore flat would attract about ₹6 lakh.",
    "In Delhi, stamp duty is 6% for men and 4% for women, so a ₹50 lakh flat registered in a woman's name attracts around ₹2 lakh.",
    "From April 2025, first-time buyers in England pay no Stamp Duty Land Tax on homes priced up to £300,000.",
    "There is no court fee for filing a consumer complaint at the District Commission if the value of your claim is up to ₹5 lakh.",
    "Filing a civil case in a US federal district court costs $405, which covers the $350 filing fee and a $55 administrative fee.",
    "Under PM-KISAN, eligible farmer families receive ₹6,000 a year, paid in three equal instalments of ₹2,000 directly to their bank account.",
    "Ayushman Bharat PM-JAY gives eligible families free treatment cover of up to ₹5 lakh per family per year at empanelled hospitals.",
    "If you want to claim the 80G tax deduction, please donate by UPI, cheque or bank transfer, because cash donations above ₹2,000 are not eligible.",
    "If you're a UK taxpayer and tick the Gift Aid box, we can claim an extra 25p from HMRC for every £1 you donate, at no cost to you.",
    "IBM's Cost of a Data Breach Report 2024 puts the global average cost of a data breach at USD 4.88 million, the highest figure the report has recorded.",
    "The 2017 NotPetya attack caused an estimated $10 billion in damages worldwide, and Maersk alone reported losses of around $300 million.",
    "Under the new tax regime for FY 2025-26, income up to ₹4 lakh is tax-free, and with the Section 87A rebate you pay no tax on income up to ₹12 lakh.",
    "In the UK, the personal allowance is £12,570, and income between £12,571 and £50,270 is taxed at the basic rate of 20%.",
    "The US federal minimum wage is $7.25 an hour, and non-exempt employees must be paid 1.5 times their regular rate for any hours over 40 in a week.",
    "From April 2025, the UK National Living Wage for workers aged 21 and over is £12.21 per hour.",
]

#: The company's own prices named in the figure's sentence (review, 2026-09-11). "Charges for the VAPT
#: engagement come to INR 1.8 lakh." is left out: "charges" with no "our", "we" or "us" reads the same
#: as a registry's charges, and streams unless the question or session carries a signal. So is "You will
#: be invoiced ¥30,000 each month.": a hospital invoices too (final review, 2026-09-11).
REVIEW_OWN_PRICES = [
    "Our Growth plan is $49 per seat per month.",
    "The retainer is ₹1,50,000 a quarter.",
    "Annual subscription: €2,400.",
    "The Starter tier costs ₹9,999 a month and covers up to 50 endpoints.",
    "Managed SOC pricing begins at USD 3,500 monthly.",
    "We charge a one-time onboarding fee of Rs. 25,000.",
    "Implementation for a 200-seat rollout is quoted at ₹4.5 lakh.",
    "Our penetration testing packages start from $2,000 per application.",
    "Billed annually, the Pro plan works out to 1,20,000 rupees.",
    "The Enterprise package comes to INR 12 lakh a year.",
    "Endpoint protection is ₹450 per device per month.",
    "MDR is £12 per endpoint per month on the Essentials plan.",
    "Our audit fee is 75,000/year for up to 50 users.",
    "Premium support adds EUR 800 a year to your subscription.",
    "The Basic tariff is 2,999 per user per month.",
    "Here is the quotation for your three sites: ₹3,40,000 plus GST.",
    "Tier 2 is $ 1,299/mo with 24x7 monitoring.",
    "₹2,66,250 a month is what the SOC as a Service plan comes to for small teams.",
    "We will invoice you ¥30,000 each month.",
]


@pytest.mark.parametrize("answers", [REVIEW_NOT_OWN_PRICES, REVIEW_BLIND_NOT_OWN_PRICES], ids=["first", "blind"])
def test_the_reviews_amounts_that_are_not_the_companys_price_rarely_trip(answers):
    tripped = [text for text in answers if answer_trips_price_guard(text, signal=False)]
    assert len(answers) == 30
    assert len(tripped) <= 3, tripped


@pytest.mark.parametrize("text", REVIEW_NOT_OWN_PRICES + REVIEW_BLIND_NOT_OWN_PRICES)
def test_a_review_answer_streams_as_the_whole_answer_decides(text):
    whole = answer_trips_price_guard(text, signal=False)
    for size in (1, 3, 7):
        guard, out = _feed(_chunked(text, size))
        assert guard.tripped is whole, size
        if not whole:
            assert out == text, size


@pytest.mark.parametrize("text", REVIEW_OWN_PRICES)
def test_the_reviews_own_prices_trip_without_a_signal(text):
    figure_start = _FIGURE_START_RE.search(text).group()
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=False, splits=_light_splits)


_FIGURE_START_RE = price_guard_module._FIGURE_RE


# Final approval review, 2026-09-11: a company name with full stops ("S.K. Traders") made the cache
# check and the stream disagree, initials and titles ended a sentence early, "set by the court, not by
# us" opened a price context, and salary packages or insurance plans read as the company's plans.


def test_the_guard_takes_no_company_name():
    """Only a first-person word marks a fee or price as the company's own."""
    with pytest.raises(TypeError):
        PriceStreamGuard(company_name="S.K. Traders")
    with pytest.raises(TypeError):
        answer_trips_price_guard("The delivery charge is ₹200.", signal=False, company_name="S.K. Traders")


#: A company named in the third person, with full stops or price words in its name. No first-person
#: word makes the fee the company's own, so each streams.
THIRD_PERSON_COMPANY = [
    "The delivery charge is ₹200 at S.K. Traders.",
    "S.K. Traders' delivery charge is ₹200 per order.",
    "The GST registration fee is ₹0, but S.K. Traders can file it for you.",
    "Dr. Lal PathLabs charges ₹500 for a CBC test.",
    "The CBC test fee is ₹500 at Dr. Lal PathLabs.",
    "St. Mary's Clinic fee for a consultation is ₹800.",
    "A.I. Solutions's fee for the audit is $500.",
    "Yahoo! Japan charges ¥500 a month.",
    "Rate Plus's fee for the audit is $500.",
    "Price Chopper Movers charges ₹12,000 for a 2BHK move.",
    "The delivery charge is ₹200 at Sri Venkateshwara Security Pvt. Ltd.",
]


@pytest.mark.parametrize("text", THIRD_PERSON_COMPANY)
def test_a_company_named_in_the_third_person_does_not_make_a_fee_its_own(text):
    assert answer_trips_price_guard(text, signal=False) is False
    for chunks in _light_splits(text):
        guard, out = _feed(chunks)
        assert guard.tripped is False, chunks
        assert out == text, chunks


#: A title, a company suffix or an initial between a first-person word and a fee.
TITLES_AND_INITIALS = [
    "Our partner Dr. Rao sets the consultation fee at ₹800.",
    "We buy from Acme Inc. and Acme Pvt. Ltd. at a rate of $40 a unit.",
    "Our clinic on St. John's Road charges ₹500 for a CBC test.",
    "We asked Ms. Iyer and Mr. Das, and our Corp. rate is $90.",
    "Our lead, J. Smith Jr., sets the fee at $250.",
    "We work with S.K. Traders, and the delivery charge is ₹200.",
    "Our lawyer, Adv. Menon, sets the review fee at ₹5,000.",
    "We invited Prof. Shah, and our workshop fee is ₹2,000.",
]


@pytest.mark.parametrize("text", TITLES_AND_INITIALS)
def test_a_title_or_initial_does_not_end_the_sentence_of_a_first_person_word(text):
    figure_start = _FIGURE_START_RE.search(text).group()
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=False, splits=_light_splits)


#: A first-person word that says whose the fee is NOT, and billing by someone else.
NOT_BY_US = [
    "Visa fees are set by the government, not by us. The fee is $185.",
    "The renewal fee is set by the passport office, not by us. Expect Rs. 1,500.",
    "Court filing fees are set by the court itself, not our firm. Filing costs $75.",
    "Customs duty is set by the destination country's tariff schedule, not by us. On a €2,000 shipment that is about €80.",
    "The consular fee is paid to the embassy rather than us, and it is €90.",
    "Stamp duty goes to the state, never to us, and comes to about ₹6 lakh.",
    "Registration charges are paid to the registrar instead of us: roughly ₹30,000.",
    "Room charges are set independent of our clinic, at about $3,000 a night.",
    "Lab fees are collected by the lab, outside our clinic, at around ₹2,500.",
    "Ambulance transport is billed separately from our clinic services; expect $500 to $1,200.",
    "The hospital sends its own invoice, other than our bill, for about $3,000.",
    "Ambulance transport is billed at $500 to $1,200 by the provider.",
    "Invoices from the lab come to about ₹2,500.",
]


@pytest.mark.parametrize("text", NOT_BY_US)
def test_a_disclaimer_or_a_third_partys_bill_streams_intact(text):
    assert answer_trips_price_guard(text, signal=False) is False
    for chunks in _light_splits(text):
        guard, out = _feed(chunks)
        assert guard.tripped is False, chunks
        assert out == text, chunks


@pytest.mark.parametrize(
    "text",
    [
        "The court fee is set by the court, not by us; our own fee is ₹5,000.",
        "It is not our court fee, but we charge ₹5,000 for the filing.",
        "Filing is not included; our fee is $250.",
        "The embassy bills separately, and we are billed ₹1,500 for the courier.",
    ],
)
def test_a_first_person_word_outside_a_disclaimer_still_qualifies_a_fee(text):
    figure_start = _FIGURE_START_RE.search(text).group()
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=False, splits=_light_splits)


#: A salary package, a relief package, or a plan the visitor has with someone else.
NOT_THE_COMPANYS_PLAN = [
    "Our most recent placement report showed an average annual package of around ₹14.5 lakh.",
    "Freshers get a salary package of about ₹6 lakh a year.",
    "The relocation assistance package is worth up to $5,000.",
    "The government's stimulus package was worth $1.9 trillion.",
    "Patients with standard insurance plans pay about $3,200.",
    "Most health insurance plans cover up to ₹5 lakh.",
    "Your treatment plan may come to around $2,000 in total.",
    "An instalment plan spreads ₹60,000 over twelve months.",
    "A dental care plan from your employer may reimburse $1,500 a year.",
]


@pytest.mark.parametrize("text", NOT_THE_COMPANYS_PLAN)
def test_a_package_or_plan_in_another_sense_streams_intact(text):
    assert answer_trips_price_guard(text, signal=False) is False
    for chunks in _light_splits(text):
        guard, out = _feed(chunks)
        assert guard.tripped is False, chunks
        assert out == text, chunks


@pytest.mark.parametrize(
    "text",
    [
        "Our Growth plan for health teams is ₹5,000 a month.",
        "The insurance-grade Pro plan is $99 a month.",
        "Our care package is ₹5,000 a month.",
        "The salary is paid in full, and the Pro package is $99 a month.",
    ],
)
def test_a_plan_or_package_named_beside_another_word_still_counts(text):
    figure_start = _FIGURE_START_RE.search(text).group()
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=False, splits=_light_splits)


#: "Business" is one of the most common plan TIER names, so it must not exclude a
#: plan from being the company's own in an ANSWER, even though the question-side
#: exclusion still lets "what's your business plan?" through with no signal (see
#: ``test_an_ordinary_question_is_no_signal``). Production review, 2026-09-11.
BUSINESS_PLAN_IS_A_TIER = [
    "The Business plan costs $99 a month.",
    "Our Business Plan is ₹4,999 per month.",
    "Upgrade to the Business plan for $49/user.",
]


@pytest.mark.parametrize("text", BUSINESS_PLAN_IS_A_TIER)
def test_a_business_plan_named_as_a_tier_trips_without_a_signal(text):
    assert answer_trips_price_guard(text, signal=False) is True
    figure_start = _FIGURE_START_RE.search(text).group()
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=False, splits=_light_splits)


def test_a_business_plan_document_still_trips_on_the_bare_plan_word():
    """Dropping "business" from the answer-side exclusion is a plan-TIER fix, not a
    phrase-level one, so it cannot tell a consultancy's "business plan" document
    from a "Business" subscription tier. "Our consultants help you write a
    business plan..." keeps its own-price signal from the bare word "plan"
    (``_OWN_PRICE_WORDS`` reads it on its own) and the first-person "Our", so it
    still trips: this test pins that known, accepted tradeoff rather than
    asserting the sentence streams. A visitor wrongly handed to the team on a
    sentence that was never a price is the safer failure of the two, next to a
    company's own "$99 a month" streaming past the gate unsignalled.
    """
    text = "Our consultants help you write a business plan for about $2,000."
    assert answer_trips_price_guard(text, signal=False) is True
    figure_start = _FIGURE_START_RE.search(text).group()
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=False, splits=_light_splits)


def test_an_insurance_plan_with_no_first_person_word_still_streams_intact():
    """ "Insurance" stays on both the question- and answer-side exclusions, so a plan
    a visitor has elsewhere is unaffected by dropping "business" from the answer
    side, with or without a first-person word nearby."""
    text = "patients on standard insurance plans pay about $3,200 out of pocket"
    assert answer_trips_price_guard(text, signal=False) is False
    for chunks in _light_splits(text):
        guard, out = _feed(chunks)
        assert guard.tripped is False, chunks
        assert out == text, chunks


#: The section a price heading opened has ended before the figure.
SECTION_ENDED = [
    # A heading of the same level.
    "## Pricing\n\nAsk the team for details.\n\n## Compliance\n\nGDPR fines can reach €20 million.",
    # A heading of a higher level, with the figure on the heading's own line.
    "### Pricing\n\nAsk the team for details.\n\n## Compliance fines reach €20 million",
    # More than 1,200 characters after the heading.
    "## Pricing\n\nAsk the team for details."
    + "\n\nIt is reviewed every quarter." * 40
    + "\n\nGDPR fines reach €20 million.",
    # A heading that names no price.
    "## Compliance\n\nAsk the team for details.\n\nGDPR fines can reach €20 million.",
]


@pytest.mark.parametrize("text", SECTION_ENDED)
def test_a_figure_outside_a_price_section_streams_intact(text):
    assert answer_trips_price_guard(text, signal=False) is False
    for size in (1, 2, 3, 5, 8, 13, len(text)):
        guard, out = _feed(_chunked(text, size))
        assert guard.tripped is False, size
        assert out == text, size


@pytest.mark.parametrize(
    "text",
    [
        *THIRD_PERSON_COMPANY,
        *TITLES_AND_INITIALS,
        *NOT_BY_US,
        *NOT_THE_COMPANYS_PLAN,
        *SECTION_ENDED[:2],
        "Welcome to Plan B Travel! The Schengen visa fee is €90, paid to the embassy.",
        "Plan International raised €1.1 billion for children's rights last year.",
        "Our partner firm J.K. Associates handles filings; the ROC fee is ₹600.",
        "Acme Inc. charges $500 for setup.",
    ],
)
def test_the_whole_answer_decides_as_the_stream_does_with_names_titles_and_disclaimers(text):
    whole = answer_trips_price_guard(text, signal=False)
    for chunks in _light_splits(text):
        guard, out = _feed(chunks)
        assert guard.tripped is whole, chunks
        if not whole:
            assert out == text, chunks


#: Lines for the random whole-answer and stream comparison.
_FUZZ_LINES = [
    "We offer three plans:", "Here are our SOC packages.", "Our pricing is simple.", "## Pricing", "### Hourly",
    "## Compliance", "**Our plans**", "GDPR fines can reach €20 million.", "- Starter: ₹9,999/month", "- Growth",
    "  ₹24,999 a month", "| Plan | Price |", "| Service | Rate |", "| Law | Maximum |", "|---|---|",
    "| SOC | ₹2,66,250 |", "| GDPR | €20 million |", "", "", "The court fee is ₹12,000 under the Act.",
    "The delivery charge is ₹200 at S.K. Traders.", "S.K. Traders' delivery charge is ₹200 per order.",
    "Dr. Lal PathLabs charges ₹500 for a CBC test.", "Our partner Dr. Rao sets the fee at ₹800.",
    "St. Mary's Clinic, Pvt. Ltd. and Acme Corp. charge Rs. 5,000 approx. for teams.",
    "Visa fees are set by the government, not by us. The fee is $185.",
    "Court fees are set by the court, not our firm. Filing costs $75.",
    "Ambulance transport is billed separately from our clinic; expect $500 to $1,200.",
    "Freshers get an average annual package of ₹14.5 lakh.", "Patients with standard insurance plans pay about $3,200.",
    "Fines reach €20 million" + " and it rose again" * 18 + " on the Pro plan.", "We are in the US and the price is $350.",
    "It costs 49.99 per month.", "Our team of 1,200 analysts works 3 shifts per day.", "Mr. J. K. Rao, Jr. quoted it.",
    "It is not by us", "that our fee is ₹5,000.", "never", "us, and the rate is $40.",
]  # fmt: skip


def test_the_whole_answer_decides_as_the_stream_does_on_random_answers():
    """Seeded, so a failure reproduces: lines with names, titles, initials and disclaimers, split at random."""
    rng = random.Random(20260911)
    for _ in range(250):
        text = rng.choice(["\n", " "]).join(rng.choice(_FUZZ_LINES) for _ in range(rng.randint(1, 7)))
        if len(text) < 2:
            continue
        whole = answer_trips_price_guard(text, signal=False)
        cut_sets = [sorted(rng.sample(range(1, len(text)), min(len(text) - 1, rng.randint(1, 15)))) for _ in range(3)]
        splits = [list(text)] + [
            [text[a:b] for a, b in zip([0, *cuts], [*cuts, len(text)], strict=True)] for cuts in cut_sets
        ]
        for chunks in splits:
            guard, out = _feed(chunks)
            assert guard.tripped is whole, (text, chunks)
            if whole:
                assert text.startswith(out), (text, chunks)
            else:
                assert out == text, (text, chunks)


# Streaming review, 2026-09-11: the reader reads the last few dozen characters of the emitted answer again
# with each new piece. When that tail began just after the "D" of "Dr." or the "R" of "Rs.", the full stop
# lost the letters before it and was read as a sentence end, which forgot the sentence's "our": the whole
# answer tripped and the stream released the figure. 140 of 300 generated answers disagreed.

_DR_MEHTA = (
    "Our clinic is run by Dr. Mehta and a team of six experienced physiotherapists and nurses, "
    "and the consultation fee is Rs. 700."
)


def _stream_splits(text):
    """Chunks of 1, 2, 3, 4 and 7 characters, and four random splits into chunks of 1 to 9 characters."""
    for size in (1, 2, 3, 4, 7):
        yield _chunked(text, size)
    rng = random.Random(20260911)
    for _ in range(4):
        chunks, at = [], 0
        while at < len(text):
            size = rng.randint(1, 9)
            chunks.append(text[at : at + size])
            at += size
        yield chunks


def test_a_title_long_before_the_fee_does_not_end_the_sentence_in_a_stream():
    assert answer_trips_price_guard(_DR_MEHTA, signal=False) is True
    _assert_nothing_from_the_figure_is_emitted(_DR_MEHTA, "Rs. 700", signal=False, splits=_stream_splits)


_GAP_FILLER = "and a team that has served families across the city for many years " * 4


def _answer_with_gap(phrase, gap):
    """ "Our clinic works with <phrase> ..., and the consultation fee is ₹800.", ``gap`` characters from the phrase's full stop to "fee"."""
    head = f"Our clinic works with {phrase}"
    after_full_stop = len(head) - head.index(".") - 1
    lead = ", and the consultation "
    filler = _GAP_FILLER[: gap - after_full_stop - 1 - len(lead)]
    text = f"{head} {filler}{lead}fee is ₹800."
    assert text.index(" fee is") + 1 - (head.index(".") + 1) == gap
    return text


@pytest.mark.parametrize("gap", [60, 85, 150])
@pytest.mark.parametrize(
    "phrase", ["Mrs. Iyer", "No. 12 Park Road", "St. Mary's", "Acme Inc.", "J. Rao", "approx. 40 staff", "e.g. Pune"]
)
def test_an_abbreviation_or_initial_far_before_the_fee_decides_as_the_whole_answer_does(phrase, gap):
    text = _answer_with_gap(phrase, gap)
    assert answer_trips_price_guard(text, signal=False) is True
    _assert_nothing_from_the_figure_is_emitted(text, "₹", signal=False, splits=_stream_splits)


_GAP_OPENERS = ["Our clinic works with", "We hired", "Our team visited", "We buy from", "The court appointed",
                "Patients often see", "Our lawyer is", "The embassy uses"]  # fmt: skip
_GAP_MARKERS = [
    "Dr. Mehta", "Mrs. Iyer", "Mr. Das", "Ms. Pillai", "Prof. Shah", "Adv. Menon", "St. Mary's", "S.K. Traders",
    "J. K. Rao", "Acme Pvt. Ltd.", "Acme Inc.", "Nair Bros.", "Kumar Corp.", "No. 12 Park Road", "Rao Jr.",
    "Sr. Nurse A. Das", "approx. 40 staff", "e.g. Pune", "i.e. weekly", "Brightpath Co.", "vs. last year",
    "Rs. 0 extra", "a firm whose fees are set by the court, not by us,", "a lab billed separately from our clinic,",
    "branches in tier 1 and tier 2 cities", "a salary package",
]  # fmt: skip
_GAP_WORDS = ["who", "has", "worked", "in", "this", "field", "for", "many", "years", "and", "knows", "every", "detail",
              "of", "the", "local", "process"]  # fmt: skip
_GAP_PRICES = ["the consultation fee is", "our delivery charge is", "the Pro plan is", "the rate is",
               "it starts at", "the court fee is", "fines reach", "our session price is"]  # fmt: skip
_GAP_FIGURES = ["₹800", "$120", "Rs. 1,500", "INR 25,000", "€90", "AED 4,500", "12,000/month", "3 lakh rupees"]
_GAP_ENDS = [".", ". ", "!", "", ".\n"]


def _gap_sentence(rng):
    """A sentence with an abbreviation, an initial or a disclaimer 55 to 200 characters before its price word."""
    words = []
    target = rng.randint(55, 200) - len(" and ")
    while len(" ".join(words)) < target:
        words.append(rng.choice(_GAP_WORDS))
    return (
        f"{rng.choice(_GAP_OPENERS)} {rng.choice(_GAP_MARKERS)} {' '.join(words)}, and "
        f"{rng.choice(_GAP_PRICES)} {rng.choice(_GAP_FIGURES)}{rng.choice(_GAP_ENDS)}"
    )


def _gap_block(rng):
    kind = rng.random()
    if kind < 0.6:
        return _gap_sentence(rng)
    if kind < 0.7:
        return f"## {rng.choice(['About us', 'Team', 'Dr. Rao', 'FAQ'])}\n"
    if kind < 0.8:
        return f"| Name | Role |\n|---|---|\n| {rng.choice(_GAP_MARKERS)} | Lead |\n"
    if kind < 0.9:
        return f"- {_gap_sentence(rng).rstrip()}\n- {rng.choice(_GAP_MARKERS)} is on call.\n"
    return f"{rng.choice(_GAP_MARKERS)} is our partner."


def _whole_answer_trip_point(text):
    """Where the figure the whole answer trips on starts, or None: without a signal the guard reads everything it emits."""
    guard = PriceStreamGuard(signal=False)
    guard.feed(text)
    guard.flush()
    return guard._reader.position if guard.tripped else None


def test_the_whole_answer_decides_as_the_stream_does_with_abbreviations_far_before_the_price():
    """Seeded: 300 answers, each streamed in 12 chunkings, must decide exactly as the whole answer does."""
    rng = random.Random(5)
    disagreements = []
    for _ in range(300):
        text = rng.choice(["", " ", "\n", "\n\n"]).join(_gap_block(rng) for _ in range(rng.randint(1, 3)))
        trip_point = _whole_answer_trip_point(text)
        splits = [_chunked(text, size) for size in (1, 2, 3, 4, 5, 6, 7, 9, 13)]
        for _ in range(3):
            cuts = sorted(rng.sample(range(1, len(text)), min(len(text) - 1, rng.randint(5, 40))))
            splits.append([text[a:b] for a, b in zip([0, *cuts], [*cuts, len(text)], strict=True)])
        for chunks in splits:
            guard, out = _feed(chunks)
            if guard.tripped is not (trip_point is not None):
                disagreements.append((text, "trip" if guard.tripped else "no trip", len(chunks)))
            elif guard.tripped and not (text.startswith(out) and len(out) <= trip_point):
                disagreements.append((text, "emitted part of the figure", len(chunks)))
            elif not guard.tripped and out != text:
                disagreements.append((text, "output differs", len(chunks)))
    assert not disagreements, (len(disagreements), disagreements[:3])


#: "Tier 1 and tier 2 cities" is a kind of city, not a plan tier (blind review B3-09).
TIER_OF_CITIES = [
    "Retail chains in tier 1 and tier 2 cities pay a court fee of ₹12,000.",
    "**Client:** A fashion retailer with 64 stores across tier 1 and tier 2 cities\n"
    "**Client's project budget:** USD 180,000, set by their board for FY 2024/25",
    "Stamp duty in Tier II towns is about ₹6 lakh.",
    "GDPR fines reach €20 million in tier-1, tier-2 and tier-3 cities alike.",
    "Salaries in tier 2/3 cities average ₹4 lakh.",
    "A tier 2 city sees rents near ₹15,000 a month.",
    "Office rent in a tier-2 city 15,000/month is typical.",
]


@pytest.mark.parametrize("text", TIER_OF_CITIES)
def test_a_numbered_tier_of_cities_or_towns_is_not_a_plan_tier(text):
    assert answer_trips_price_guard(text, signal=False) is False
    for chunks in _light_splits(text):
        guard, out = _feed(chunks)
        assert guard.tripped is False, chunks
        assert out == text, chunks


@pytest.mark.parametrize(
    "text",
    [
        "The Growth tier costs 5 lakh a year.",
        "Across tier 1 cities, the Tier 2 option is ₹999 a month.",
        "Fines reach €20 million, and the tier 2 option is extra.",
        "Our tiers: 1, 2 and 3. Tier 2 is $1,299/mo.",
        "The tier 2 city plan is ₹999 a month.",
    ],
)
def test_a_tier_that_names_no_cities_still_counts(text):
    figure_start = _FIGURE_START_RE.search(text).group()
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=False, splits=_light_splits)


# Review, 2026-09-11: a "tier" waited until it could no longer become "tier 2 cities", but the text before a
# figure was read with only the figure's first character after it. "tier 2" can still become "tier 2 cities",
# so the figure was held with its "tier" undecided and released at the sentence end, whole and streamed.
# The letters of a currency code ("INR", "THB") are no tier numeral either.
TIER_BEFORE_A_FIGURE = [
    ("Our Scale tier 2,499/month includes SSO.", "2,499"),
    ("The Growth tier 1,20,000/year covers 50 users on our platform.", "1,20,000"),
    ("Our Premium tier 3 lakh rupees a year covers unlimited seats.", "3 lakh"),
    ("Our top tier INR 25,000 a month adds priority support.", "INR"),
    ("The Business tier 12,000/month includes 20 seats.", "12,000"),
    ("Each tier 2 lakh rupees a year.", "2 lakh"),
    ("The Pro tier THB 1,500 a month adds SSO.", "THB"),
    ("Pick tier 1, 2,999/month, for small teams.", "2,999"),
    ("- Starter tier 1,999/month\n- Growth tier 2,999/month", "1,999"),
]


@pytest.mark.parametrize(("text", "figure_start"), TIER_BEFORE_A_FIGURE, ids=lambda v: v)
def test_a_tier_followed_by_a_figure_is_a_plan_tier(text, figure_start):
    assert answer_trips_price_guard(text, signal=False) is True
    _assert_nothing_from_the_figure_is_emitted(text, figure_start, signal=False, splits=_stream_splits)


def test_a_table_header_naming_an_amount_opens_no_price_context():
    """A loan desk's "Typical loan amount" column tripped (blind review B3-22)."""
    text = (
        "| Lender type | Typical loan amount | Collateral |\n|---|---|---|\n"
        "| Public sector banks | Up to ₹1.5 crore | Required above ₹7.5 lakh |\n"
        "| NBFCs | Up to ₹75 lakh | Often not needed |"
    )
    assert answer_trips_price_guard(text, signal=False) is False
    for size in (1, 2, 3, 5, 8, 13, len(text)):
        guard, out = _feed(_chunked(text, size))
        assert guard.tripped is False, size
        assert out == text, size
