"""A turn that asks the price and something else keeps the something else.

Evaluation, 2026-09-17: "whats the pricing, are you hiring, and where is your
office" on a bot whose pricing goes to the team was answered with the pricing
escalation alone. The price guard replaced the whole answer, so the hiring and
office parts were lost. On such a turn (the price decision is MIXED) only the
sentences that state a figure are dropped, and the escalation follows the rest.

Every decision is made on text whose extent does not depend on how the answer
was chunked, so a whole answer (the cache and the tests) and a stream agree.
"""

import itertools
import time

import pytest

from app.services.price_guard import PriceSentenceRedactor, PriceStreamGuard, redact_price_sentences


def _feed(chunks):
    redactor = PriceSentenceRedactor()
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
