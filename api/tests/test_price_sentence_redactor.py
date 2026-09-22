"""A turn that asks the price and something else keeps the something else.

Evaluation, 2026-09-17: "whats the pricing, are you hiring, and where is your
office" on a bot whose pricing goes to the team was answered with the pricing
escalation alone. The price guard replaced the whole answer, so the hiring and
office parts were lost. On such a turn (the price decision is MIXED) only the
sentences that state a figure are dropped, and the escalation follows the rest.

A turn that reads as no price question at all keeps its answer the same way
(production, 2026-09-21), but drops far less: without the turn's signal a
sentence goes only where an unsignalled ``PriceStreamGuard`` would have tripped,
so a fine, a court fee or a third party's bill stays in the answer.

Every decision is made on text whose extent does not depend on how the answer
was chunked, so a whole answer (the cache and the tests) and a stream agree.
"""

import itertools
import time

import pytest

from app.services.price_guard import (
    PriceSentenceRedactor,
    PriceStreamGuard,
    answer_trips_price_guard,
    redact_price_sentences,
)


def _feed(chunks, *, signal=True):
    redactor = PriceSentenceRedactor(signal=signal)
    out = "".join(redactor.feed(c) for c in chunks)
    out += redactor.flush()
    return redactor, out


def _splits(text):
    """The whole text, every two-way split, a sample of three-way splits, one character at a time."""
    yield [text]
    for i in range(1, len(text)):
        yield [text[:i], text[i:]]
    for i, j in itertools.islice(itertools.combinations(range(1, len(text)), 2), 0, None, 7):
        yield [text[:i], text[i:j], text[j:]]
    yield list(text)


#: (answer, what is kept). Every kept text is what a whole answer and every split produce.
CASES = [
    (
        "Pricing for SOC starts at ₹2,66,250 per month. We are hiring for 19 roles. Our office is in Pune.",
        "We are hiring for 19 roles. Our office is in Pune.",
    ),
    (
        "We are hiring for 19 roles. Pricing starts at ₹2,66,250 per month. Our office is in Pune.",
        "We are hiring for 19 roles. Our office is in Pune.",
    ),
    (
        "We are hiring.\nOur SOC plan is ₹2,66,250 per month.\nOur office is in Pune.",
        "We are hiring.\nOur office is in Pune.",
    ),
    # A blank line left by a dropped paragraph is not doubled.
    (
        "We are hiring.\n\nSOC costs ₹2,66,250 a month.\n\nOur office is in Pune.",
        "We are hiring.\n\nOur office is in Pune.",
    ),
    (
        "SOC costs ₹2,66,250 a month.\n\nOur office is in Pune.",
        "Our office is in Pune.",
    ),
    # A list item with a figure goes; the other items stay.
    (
        "Here is what you asked:\n- **Pricing**: ₹4,999/month\n- **Hiring**: 19 open roles\n- **Office**: Pune",
        "Here is what you asked:\n- **Hiring**: 19 open roles\n- **Office**: Pune",
    ),
    # A lead whose whole list is dropped goes with it.
    (
        "Our plans:\n- Starter: ₹999 per month\n- Growth: ₹2,499 per month\n\nWe are hiring.",
        "We are hiring.",
    ),
    (
        "## Pricing\n\nStarter is ₹999 a month.\n\n## Careers\n\nWe are hiring.",
        "## Careers\n\nWe are hiring.",
    ),
    # A table with a figure in any row goes whole.
    (
        "| Plan | Price |\n|---|---|\n| Starter | ₹999 |\n\nWe are hiring.",
        "We are hiring.",
    ),
    # A dropped sentence that ended its line leaves the line break behind.
    ("We are hiring. SOC is ₹9,999 a month.\nOur office is in Pune.", "We are hiring. \nOur office is in Pune."),
    # A lead with no items is kept.
    ("Our offices:\n\nPune and Mumbai.", None),
    # A figure in a code the gate knows, and in words.
    ("Onboarding is Rs. 25,000 once. Support is 24x7.", "Support is 24x7."),
    ("A pilot comes to about 7 lakh. The team is in Pune.", "The team is in Pune."),
    # Nothing is dropped from an answer without a figure.
    ("We are hiring for 19 roles across 3 offices. Our office is in Pune.", None),
    ("We run 24/7 monitoring since 2019.\n\n\n- 3 regions\n- 99.9% uptime", None),
    # Every sentence states a figure.
    ("Starter is ₹999 a month. Growth is ₹2,499 a month.", ""),
]


@pytest.mark.parametrize(("text", "kept"), CASES, ids=lambda v: v[:40] if isinstance(v, str) else v)
def test_only_the_sentences_that_state_a_figure_are_dropped_however_the_answer_is_split(text, kept):
    expected = text if kept is None else kept
    whole, redacted = redact_price_sentences(text)
    assert whole == expected
    assert redacted is (kept is not None)
    for chunks in _splits(text):
        redactor, out = _feed(chunks)
        assert out == expected, chunks
        assert redactor.emitted == expected, chunks
        assert redactor.redacted is (kept is not None), chunks
        assert redactor.tripped is False


@pytest.mark.parametrize(("text", "kept"), CASES, ids=lambda v: v[:40] if isinstance(v, str) else v)
def test_no_figure_is_ever_emitted_even_for_a_moment(text, kept):
    """What is emitted is always a prefix of the final kept text: nothing is shown and then taken back."""
    expected = text if kept is None else kept
    for chunks in _splits(text):
        redactor = PriceSentenceRedactor()
        shown = ""
        for chunk in chunks:
            shown += redactor.feed(chunk)
            assert expected.startswith(shown), (chunks, shown)
        shown += redactor.flush()
        assert shown == expected


def test_a_figure_split_across_a_line_break_drops_both_lines():
    text = "Growth comes to 50\nlakh for the year.\nWe are hiring."
    assert redact_price_sentences(text) == ("We are hiring.", True)


def test_a_long_sentence_is_cut_without_letting_a_figure_through():
    text = "word " * 200 + "and it costs ₹2,66,250 for the whole team. We are hiring."
    kept, redacted = redact_price_sentences(text)
    assert redacted is True
    assert "2,66,250" not in kept
    assert "₹" not in kept
    assert kept.endswith("We are hiring.")
    for size in (1, 5, 64):
        _, out = _feed([text[i : i + size] for i in range(0, len(text), size)])
        assert out == kept, size


def test_held_is_what_has_not_been_shown():
    redactor = PriceSentenceRedactor()
    assert redactor.feed("We are hiring. Pricing is ₹9") == ""
    assert "We are hiring." in redactor.held
    assert redactor.emitted == ""


def test_a_sentence_streams_once_it_and_a_short_lookahead_have_arrived():
    redactor = PriceSentenceRedactor()
    first = "We are hiring for 19 roles. "
    assert redactor.feed(first) == ""
    assert redactor.feed("x" * 64) == first


def test_redaction_matches_the_signalled_guard_on_what_counts_as_a_figure():
    """A sentence is dropped exactly when a signalled guard would trip on it alone."""
    for sentence in (
        "SOC is ₹2,66,250 per month.",
        "It is USD 499.",
        "Budget about 50 lakh.",
        "We process 10,000 requests / hour.",
        "Python 3.11 and Node 20 LTS.",
        "Our SLA credits are 10% of monthly fees.",
    ):
        guard = PriceStreamGuard(signal=True)
        guard.feed(sentence)
        guard.flush()
        assert redact_price_sentences(sentence)[1] is guard.tripped, sentence


def test_a_long_answer_is_redacted_in_linear_time():
    paragraph = "We are hiring for many roles across the country. Our SOC plan is ₹2,66,250 a month.\n"
    short = paragraph * 50
    long = paragraph * 400
    timings = []
    for text in (short, long):
        started = time.perf_counter()
        _feed([text[i : i + 3] for i in range(0, len(text), 3)])
        timings.append(time.perf_counter() - started)
    assert timings[1] < 16 * max(timings[0], 1e-3)
    assert timings[1] < 2.0


def test_a_long_run_without_a_sentence_end_streams_quickly():
    text = ",".join(str(560001 + i) for i in range(1000))[:6000]
    started = time.perf_counter()
    redactor, out = _feed([text[i : i + 2] for i in range(0, len(text), 2)])
    assert time.perf_counter() - started < 2.0
    assert redactor.redacted is False
    assert out == text


def test_redact_price_sentences_reads_anything():
    assert redact_price_sentences("") == ("", False)
    assert redact_price_sentences(None) == ("", False)


# ── A turn with no price signal ───────────────────────────────────────────────

#: (answer, what is kept) with ``signal=False``. None keeps the whole answer.
UNSIGNALLED_CASES = [
    # Production, 2026-09-21: the visitor asked about the services, and the whole
    # answer was replaced because it happened to quote the retainer.
    (
        "We build websites and brand systems. Our retainer is ₹2,66,250 per month. Our office is in Pune.",
        "We build websites and brand systems. Our office is in Pune.",
    ),
    # Someone else's figure stays: a fine, a court fee, a third party's bill.
    ("GDPR fines can reach €20 million or 4% of annual turnover.", None),
    ("For a ₹10 lakh suit in Delhi, the court fee works out to roughly ₹12,000 under the Act.", None),
    ("Domain renewal is billed separately by the registrar, at about ₹1,200 a year.", None),
    ("Visa fees are set by the government, not by us. The fee is $185.", None),
    ("We are hiring for 19 roles across 3 offices since 2019.", None),
    # A figure whose own sentence names no price still stays: only the turn's
    # signal makes every figure the company's.
    ("SOC as a Service comes to ₹2,66,250 a month for small teams.", None),
    # A price context opened on an earlier line reaches the figure under it.
    (
        "We offer three plans:\n- Starter: ₹9,999/month\n- Growth: ₹24,999/month\n\nWe are hiring.",
        "We are hiring.",
    ),
    (
        "Here are our SOC packages.\n\n**Essentials**: ₹1,20,000 a month.\n\nOur office is in Pune.",
        "Here are our SOC packages.\n\nOur office is in Pune.",
    ),
    # Every sentence names the company's price.
    ("Our Starter plan is ₹999 a month. Our Growth plan is ₹2,499 a month.", ""),
]


@pytest.mark.parametrize(("text", "kept"), UNSIGNALLED_CASES, ids=lambda v: v[:40] if isinstance(v, str) else v)
def test_without_a_signal_only_the_sentences_naming_our_own_price_are_dropped(text, kept):
    expected = text if kept is None else kept
    whole, redacted = redact_price_sentences(text, signal=False)
    assert whole == expected
    assert redacted is (kept is not None)
    for chunks in _splits(text):
        redactor, out = _feed(chunks, signal=False)
        assert out == expected, chunks
        assert redactor.emitted == expected, chunks
        assert redactor.redacted is (kept is not None), chunks
        assert redactor.tripped is False


@pytest.mark.parametrize(("text", "kept"), UNSIGNALLED_CASES, ids=lambda v: v[:40] if isinstance(v, str) else v)
def test_without_a_signal_no_dropped_text_is_emitted_even_for_a_moment(text, kept):
    expected = text if kept is None else kept
    for chunks in _splits(text):
        redactor = PriceSentenceRedactor(signal=False)
        shown = ""
        for chunk in chunks:
            shown += redactor.feed(chunk)
            assert expected.startswith(shown), (chunks, shown)
        shown += redactor.flush()
        assert shown == expected


@pytest.mark.parametrize("text", [text for text, _ in (*CASES, *UNSIGNALLED_CASES)])
@pytest.mark.parametrize("signal", [True, False])
def test_a_unit_is_dropped_exactly_when_the_guard_of_the_same_signal_would_trip(text, signal):
    """The cache reads a whole answer with ``answer_trips_price_guard`` and drops
    the entry when it trips, so the two must agree on every answer: a cached answer
    the turn would redact must never be replayed as if untouched."""
    assert redact_price_sentences(text, signal=signal)[1] is answer_trips_price_guard(text, signal=signal)


def test_a_sentence_ending_past_the_hold_cap_is_read_the_same_however_it_arrives():
    """The guard reads at most ``_HOLD_CAP_CHARS`` from a figure, so a first-person
    price word further away than that does not make the figure ours."""
    text = "The court fee is ₹12,000 " + "and the hearing is listed in Delhi " * 12 + "at our office.\nWe are hiring."
    assert redact_price_sentences(text, signal=False) == (text, False)
    for size in (1, 7, 64, 512):
        _, out = _feed([text[i : i + size] for i in range(0, len(text), size)], signal=False)
        assert out == text, size


def test_a_long_sentence_without_a_signal_is_cut_without_letting_our_price_through():
    text = "word " * 200 + "and our plan costs ₹2,66,250 for the whole team. We are hiring."
    kept, redacted = redact_price_sentences(text, signal=False)
    assert redacted is True
    assert "2,66,250" not in kept
    assert kept.endswith("We are hiring.")
    for size in (1, 5, 64):
        _, out = _feed([text[i : i + size] for i in range(0, len(text), size)], signal=False)
        assert out == kept, size


def test_a_long_answer_without_a_signal_is_redacted_in_linear_time():
    paragraph = "We are hiring for many roles across the country. Our SOC plan is ₹2,66,250 a month.\n"
    short = paragraph * 50
    long = paragraph * 400
    timings = []
    for text in (short, long):
        started = time.perf_counter()
        _feed([text[i : i + 3] for i in range(0, len(text), 3)], signal=False)
        timings.append(time.perf_counter() - started)
    assert timings[1] < 16 * max(timings[0], 1e-3)
    assert timings[1] < 4.0
