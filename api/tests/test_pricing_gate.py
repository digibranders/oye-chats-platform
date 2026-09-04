"""The pricing answer gate: pure decision logic, no DB and no I/O.

The gate exists because a pricing question answered from a stale uploaded rate
card is worse than no answer at all. There is no opt-in and no opt-out anywhere
in the product: the page named in ``pricing_url`` is the ONLY source a bot may
quote a price from, and on any plan that includes human support a bot that names
no page routes every pricing question to its team rather than answering one from
the general knowledge base.

Two standdowns, and they are different in kind. ``quote_standdown`` is per TURN:
an active or pending BANT quotation is the better pricing answer while it is in
flight. ``no_support_path_standdown`` is per BOT CONFIGURATION and is the Free
carve-out, now narrowed to a genuine last resort: a plan with no live queue and
no leave-a-message form, on a bot with neither a usable pricing page NOR a
usable contact page, has nothing at all to point the visitor at, so the gate
stands down and the knowledge base answers rather than dead-ending them.

The contact page is what narrowed it. A Free bot that maps a ``contact`` Smart
Link now ESCALATES a pricing question it cannot source (``escalate_no_url``,
empty chunks, no LLM call) and the pivot hands that public page over. That is
not a paywall leak: the paid feature is the in-chat CHANNEL (live queue,
leave-a-message form, operator inbox, notification emails), and a public page on
the customer's own website is information, not a channel. So the stale-price
hole is now open only for a Free bot with no pricing page AND no contact page,
and the tests below say exactly that out loud.
"""

from types import SimpleNamespace
from typing import get_args

import pytest

from app.services.pricing_gate import (
    GateOutcome,
    evaluate_pricing_gate,
    has_price_signal,
    is_pricing_question,
    merge_pricing_smart_link,
    no_support_path_standdown,
    normalize_url,
    pricing_pivot,
)


def test_normalize_url_strips_scheme_www_and_trailing_slash():
    assert normalize_url("https://www.acme.com/pricing/") == "acme.com/pricing"
    assert normalize_url("http://acme.com/pricing") == "acme.com/pricing"


def test_normalize_url_drops_query_and_fragment():
    assert normalize_url("https://acme.com/pricing?utm_source=x#plans") == "acme.com/pricing"


def test_normalize_url_is_case_insensitive_on_host_only():
    assert normalize_url("https://ACME.com/Pricing") == "acme.com/Pricing"


def test_normalize_url_bare_domain_keeps_root_path():
    assert normalize_url("https://acme.com") == "acme.com/"


def test_normalize_url_rejects_non_http_and_blank():
    assert normalize_url("javascript:alert(1)") is None
    assert normalize_url("ftp://acme.com/pricing") is None
    assert normalize_url("   ") is None
    assert normalize_url(None) is None
    assert normalize_url(42) is None


def test_normalize_url_returns_none_for_a_malformed_ipv6_url_instead_of_raising():
    """``urlsplit("http://[::1")`` raises ValueError: Invalid IPv6 URL.

    This runs on every retrieved chunk's document_name on every gated pricing
    turn, so one malformed crawled URL must not 500 the chat turn.
    """
    assert normalize_url("http://[::1") is None
    assert normalize_url("https://[not-an-ipv6/pricing") is None


@pytest.mark.parametrize(
    "question",
    [
        "what is your pricing?",
        "How much does it cost",
        "can I get a quote",
        "whats the price for the pro plan",
        "do you have a rate card",
        "what are your fees",
        "is it ₹5000 per month?",
        "PRICING",
    ],
)
def test_is_pricing_question_true(question):
    assert is_pricing_question(question) is True


@pytest.mark.parametrize(
    "question",
    [
        "how much time does onboarding take",
        "we will support you at all costs",
        "how much longer until it is ready",
        "do you offer a free trial",
        "what services do you offer",
        "who is the founder",
        "",
    ],
)
def test_is_pricing_question_false(question):
    assert is_pricing_question(question) is False


def test_is_pricing_question_fails_open_on_non_latin_script():
    """English-only by construction. A Hindi pricing question does not match,
    so the gate never fires and the turn behaves exactly as it does today."""
    assert is_pricing_question("आपकी कीमत क्या है") is False


# ── A bare currency amount is a STATEMENT, not a question about us ───────────
#
# The bot runs a BANT qualification flow that asks visitors about Budget, often
# with pre-written budget pills, so a currency amount arriving in a turn is far
# more often the visitor ANSWERING that question than asking what we charge.
# Firing on a bare amount intercepted the turn before generation: the Budget
# dimension was never scored, and a visitor who had just stated their budget was
# answered with "pricing is best confirmed by the team". The codebase already
# draws this line in the BANT extraction prompt's "STATEMENT vs QUESTION" block;
# these two lists are the same rule, encoded in the detector.


@pytest.mark.parametrize(
    ("case", "question"),
    [
        # The currency rule, corroborated by a question mark.
        ("rupee_per_month_question", "is it ₹5000 per month?"),
        ("rupee_bare_amount_question", "₹1,49,999?"),
        ("dollar_per_month_question", "is it $500 a month?"),
        # The currency rule, corroborated by a second-person reference.
        ("second_person_no_qmark", "is $500 your monthly rate"),
        # English tokens are self-sufficient and never touch the currency rule.
        ("token_pricing", "what is your pricing?"),
        ("token_cost", "how much does it cost"),
        ("token_quote", "can i get a quote"),
    ],
)
def test_a_currency_amount_fires_only_with_evidence_the_visitor_is_asking_us(case, question):
    assert is_pricing_question(question) is True, case


@pytest.mark.parametrize(
    ("case", "question"),
    [
        # Every one of these is a real BANT budget answer. A pill tap, a typed
        # range, a bare figure: all statements the visitor makes about
        # THEMSELVES, none a question about what we charge.
        ("bant_budget_pill", "$20K+/mo"),
        ("budget_stated_prose", "our budget is around $20k"),
        ("spend_stated_prose", "we can spend $5000 a month"),
        ("bare_rupee_amount", "₹5,00,000"),
        ("bare_dollar_amount", "$500"),
    ],
)
def test_a_bare_monetary_amount_is_a_budget_statement_and_does_not_fire(case, question):
    """A false positive here is not a cosmetic miss: it kills the
    revenue-critical qualification path on every bot that runs BANT."""
    assert is_pricing_question(question) is False, case


@pytest.mark.parametrize(
    "text",
    [
        "Starter is ₹4,999 per month",
        "Pro: $49/mo billed annually",
        "Plans start at 1999 INR",
        "Team plan is USD 30 per seat",
        "Enterprise: custom pricing",
        "Contact sales for a quote",
        "Our free tier includes 100 messages",
        "Starts from £20",
    ],
)
def test_has_price_signal_true(text):
    assert has_price_signal(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "We are a design agency based in Thane.",
        "Our team has 12 people and 8 years of experience.",
        "Read our 2026 case study.",
        "",
    ],
)
def test_has_price_signal_false(text):
    assert has_price_signal(text) is False


def _chunk(document_name: str, content: str) -> SimpleNamespace:
    """A stand-in for a ``Document`` row: the gate only reads these two fields."""
    return SimpleNamespace(document_name=document_name, content=content)


_PRICED = _chunk("https://www.acme.com/pricing/", "Starter is ₹4,999 per month")
_UNPRICED = _chunk("https://acme.com/pricing", "We believe in transparent partnerships.")
_OTHER = _chunk("rate-card-2024.pdf", "Legacy retainer: ₹80,000 per month")


def test_an_active_quote_returns_chunks_untouched():
    """The only standdown left, and it is per turn rather than per bot: an
    admin-authored quotation card in flight is the better pricing answer, so the
    gate yields the turn to it and hands back the chunk list unchanged."""
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=True,
        pricing_url="https://acme.com/pricing",
        chunks=[_PRICED, _OTHER],
    )
    assert decision.fired is False
    assert decision.outcome == "quote_standdown"
    assert decision.chunks == [_PRICED, _OTHER]


def test_a_quote_standdown_does_not_leak_the_stale_card_back_when_no_quote_runs():
    """The inverse of the case above, and the one that actually matters: with no
    quote in flight there is nothing that can stand the gate down, so the same
    bot and the same chunks escalate. This is the pair that would catch
    ``quote_active`` being wired up with its sense inverted."""
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url=None,
        chunks=[_PRICED, _OTHER],
    )
    assert decision.fired is True
    assert decision.outcome == "escalate_no_url"
    assert decision.chunks == []


def test_non_pricing_question_returns_chunks_untouched():
    decision = evaluate_pricing_gate(
        question="who is the founder?",
        quote_active=False,
        pricing_url="https://acme.com/pricing",
        chunks=[_PRICED, _OTHER],
    )
    assert decision.fired is False
    assert decision.outcome == "not_pricing"
    assert decision.chunks == [_PRICED, _OTHER]


def test_no_pricing_url_configured_escalates():
    decision = evaluate_pricing_gate(
        question="how much does it cost?",
        quote_active=False,
        pricing_url=None,
        chunks=[_OTHER],
    )
    assert decision.fired is True
    assert decision.outcome == "escalate_no_url"
    assert decision.chunks == []


def test_no_pricing_url_escalates_even_when_a_priced_chunk_is_right_there():
    """The platform-wide behaviour change, at the unit level. This is the old
    "gate off, so the rate card answers" case inverted: an unconfigured bot used
    to pass its pricing turn straight through to whatever retrieval found. Now
    the priced chunk is dropped and the visitor goes to the team."""
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url=None,
        chunks=[_PRICED, _OTHER],
    )
    assert decision.fired is True
    assert decision.outcome == "escalate_no_url"
    # Empty, not filtered-but-non-empty: the priced chunk the old pass-through
    # would have answered from is gone, and so is everything else.
    assert decision.chunks == []


# ── The Free carve-out: no human path AND no usable page ────────────────────
#
# ``support_enabled`` is the PLAN half of the human-support gate. False means the
# subscription includes no live queue and no leave-a-message form, so an
# escalation has nowhere to go. Combined with no usable ``pricing_url`` the old
# behaviour was a pure dead end: refuse to answer, offer nothing. These pin the
# inversion, and just as importantly they pin everything the inversion must NOT
# touch.


@pytest.mark.parametrize(
    ("case", "unusable_url"),
    [
        ("null", None),
        ("empty", ""),
        ("whitespace", "   "),
        ("non_http_scheme", "javascript:alert(1)"),
        ("schemeless", "//acme.com/pricing"),
        ("malformed_ipv6", "http://[::1"),
        ("not_a_url_at_all", "rate-card-2026.pdf"),
        ("not_even_a_string", 42),
    ],
)
def test_no_human_path_no_usable_url_and_no_contact_page_stands_the_gate_down(case, unusable_url):
    """The fallback of last resort, and now only half of the old case.

    With neither a pricing page nor a contact page there is nothing to point the
    visitor at, so a knowledge-base answer still beats a dead end. The companion
    test below covers the other half: the same bot WITH a contact page escalates
    and hands that page over instead.

    Unusability is decided by ``normalize_url``, not by truthiness, so every
    value the gate itself would have rejected as ``escalate_no_url`` takes the
    standdown instead. A truthiness test here would leave the non-empty
    unusable values (``javascript:``, a PDF filename, ``42``) escalating into the
    dead end this carve-out exists to remove.
    """
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url=unusable_url,
        chunks=[_PRICED, _OTHER],
        support_enabled=False,
        contact_url=None,
    )
    assert decision.fired is False, case
    assert decision.outcome == "no_support_path_standdown", case
    # Untouched, not filtered: the whole point is that normal RAG runs and the
    # knowledge base answers exactly as it did before this feature existed.
    assert decision.chunks == [_PRICED, _OTHER], case


@pytest.mark.parametrize(
    ("case", "unusable_url"),
    [
        ("null", None),
        ("empty", ""),
        ("whitespace", "   "),
        ("non_http_scheme", "javascript:alert(1)"),
        ("schemeless", "//acme.com/pricing"),
        ("malformed_ipv6", "http://[::1"),
        ("not_a_url_at_all", "rate-card-2026.pdf"),
        ("not_even_a_string", 42),
    ],
)
def test_no_human_path_and_no_usable_url_but_a_contact_page_escalates(case, unusable_url):
    """The other half of the case above, and the behaviour change.

    A Free bot that maps a contact page is no longer a dead end, so the reason
    for standing down is gone and the gate fires again. ``escalate_no_url`` with
    EMPTY chunks is the assertion that matters: the visitor gets the contact link
    from ``pricing_pivot`` and no knowledge-base chunk can leak into the reply,
    which is the whole reason this is an escalation rather than a standdown with
    a link bolted on afterwards.
    """
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url=unusable_url,
        chunks=[_PRICED, _OTHER],
        support_enabled=False,
        contact_url="https://acme.com/contact",
    )
    assert decision.fired is True, case
    assert decision.outcome == "escalate_no_url", case
    assert decision.chunks == [], case


@pytest.mark.parametrize(
    ("case", "unusable_contact"),
    [
        ("null", None),
        ("empty", ""),
        ("whitespace", "   "),
        ("non_http_scheme", "javascript:alert(1)"),
        ("mailto", "mailto:hi@acme.com"),
        ("schemeless", "//acme.com/contact"),
        ("malformed_ipv6", "http://[::1"),
        ("not_even_a_string", 42),
    ],
)
def test_a_contact_url_normalize_url_rejects_does_not_re_open_the_gate(case, unusable_contact):
    """Usability is decided by ``normalize_url`` on the CONTACT side too.

    A truthiness test here would escalate on ``javascript:alert(1)`` and then ask
    ``pricing_pivot`` to hand it over, which the pivot refuses; the visitor would
    get the no-link copy on a turn the gate refused to answer, which is the exact
    dead end the carve-out exists to prevent. An unusable contact URL is no
    contact URL at all, so the standdown still applies.
    """
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url=None,
        chunks=[_PRICED, _OTHER],
        support_enabled=False,
        contact_url=unusable_contact,
    )
    assert decision.fired is False, case
    assert decision.outcome == "no_support_path_standdown", case
    assert decision.chunks == [_PRICED, _OTHER], case


def test_a_usable_pricing_url_outranks_a_contact_page_on_free():
    """Order inside the Free branch: the pricing page always wins.

    A bot that names both must still answer FROM the page rather than punting to
    a contact form. The contact link is the fallback for a bot with no priceable
    source, never a replacement for one.
    """
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url="http://acme.com/pricing",
        chunks=[_OTHER, _PRICED],
        support_enabled=False,
        contact_url="https://acme.com/contact",
    )
    assert decision.fired is True
    assert decision.outcome == "answer"
    assert decision.chunks == [_PRICED]


def test_a_contact_page_never_changes_a_paid_plan():
    """The path most likely to be broken by a careless edit. A paid bot with no
    pricing page escalates to its TEAM, and the contact link must not be
    substituted for the channel its plan actually includes."""
    for contact_url in (None, "https://acme.com/contact"):
        decision = evaluate_pricing_gate(
            question="what is your pricing?",
            quote_active=False,
            pricing_url=None,
            chunks=[_PRICED, _OTHER],
            support_enabled=True,
            contact_url=contact_url,
        )
        assert decision.fired is True, contact_url
        assert decision.outcome == "escalate_no_url", contact_url
        assert decision.chunks == [], contact_url


def test_contact_url_defaults_to_absent_so_a_forgetful_caller_keeps_the_standdown():
    """The safe direction for THIS argument is the opposite of ``support_enabled``.

    A caller that forgets ``contact_url`` costs one Free visitor a link they
    could have had; a caller that forgets it in the other direction would have
    the gate escalate with nothing to hand over. So the default is "no contact
    page", which is exactly the pre-change behaviour.
    """
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url=None,
        chunks=[_PRICED],
        support_enabled=False,
    )
    assert decision.outcome == "no_support_path_standdown"


def test_no_human_path_but_a_usable_url_still_fires_the_gate():
    """The carve-out is the PAIR of conditions, not the plan alone. A Free bot
    that names a usable page is gated exactly like a paid one: if the page
    answers, it answers from the page, and if it cannot, ``pricing_pivot`` hands
    the link over, which is a useful reply rather than a dead end."""
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url="http://acme.com/pricing",
        chunks=[_OTHER, _PRICED],
        support_enabled=False,
    )
    assert decision.fired is True
    assert decision.outcome == "answer"
    assert decision.chunks == [_PRICED]


def test_no_human_path_and_a_usable_url_the_page_cannot_answer_still_escalates():
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url="https://acme.com/pricing",
        chunks=[_UNPRICED, _OTHER],
        support_enabled=False,
    )
    assert decision.fired is True
    assert decision.outcome == "escalate_no_content"
    assert decision.chunks == []


def test_a_paid_plan_with_no_url_is_completely_unchanged():
    """The path most likely to be broken by a careless implementation."""
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url=None,
        chunks=[_PRICED, _OTHER],
        support_enabled=True,
    )
    assert decision.fired is True
    assert decision.outcome == "escalate_no_url"
    assert decision.chunks == []


def test_support_enabled_defaults_to_the_fully_gated_paid_behaviour():
    """A caller that forgets the argument must get PAID behaviour. A defaulted
    False would silently un-gate every unconfigured bot on the platform, whereas
    a missed ``support_enabled=False`` costs one Free visitor a knowledge-base
    answer."""
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url=None,
        chunks=[_PRICED],
    )
    assert decision.fired is True
    assert decision.outcome == "escalate_no_url"


def test_the_standdown_is_checked_after_intent_not_before():
    """A non-pricing turn on a Free bot must still report ``not_pricing``.

    The two outcomes say different things about what happened, and the standdown
    count is only meaningful if it counts turns the gate would otherwise have
    intercepted rather than every turn on every Free bot.
    """
    decision = evaluate_pricing_gate(
        question="who is the founder?",
        quote_active=False,
        pricing_url=None,
        chunks=[_PRICED, _OTHER],
        support_enabled=False,
    )
    assert decision.fired is False
    assert decision.outcome == "not_pricing"


def test_an_active_quote_outranks_the_free_standdown():
    """Both are standdowns and both pass chunks through, so the only thing that
    separates them is the outcome label, and a quotation in flight on a Free bot
    must still be reported as the quote flow rather than as the carve-out."""
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=True,
        pricing_url=None,
        chunks=[_PRICED],
        support_enabled=False,
    )
    assert decision.outcome == "quote_standdown"


@pytest.mark.parametrize(
    ("support_enabled", "pricing_url", "contact_url", "expected"),
    [
        (False, None, None, True),
        (False, "javascript:alert(1)", None, True),
        (False, None, "javascript:alert(1)", True),
        (False, "javascript:alert(1)", "mailto:hi@acme.com", True),
        (False, None, "https://acme.com/contact", False),
        (False, "javascript:alert(1)", "https://acme.com/contact", False),
        (False, "https://acme.com/pricing", None, False),
        (False, "https://acme.com/pricing", "https://acme.com/contact", False),
        (True, None, None, False),
        (True, None, "https://acme.com/contact", False),
        (True, "https://acme.com/pricing", "https://acme.com/contact", False),
    ],
)
def test_the_exported_standdown_predicate_matches_the_gates_own_decision(
    support_enabled, pricing_url, contact_url, expected
):
    """The pipelines' answer-cache bypass calls this predicate directly, so it
    has to agree with ``evaluate_pricing_gate`` by construction. If the bypass
    were ever NARROWER than the gate, a pre-gate cached price would be served on
    a bot the gate does intercept: the exact failure the bypass exists to
    prevent, and the contact-page rows are the newly dangerous ones, because a
    bypass still reading only ``pricing_url`` would skip the bypass on exactly
    the Free bots that now escalate."""
    assert (
        no_support_path_standdown(support_enabled=support_enabled, pricing_url=pricing_url, contact_url=contact_url)
        is expected
    )

    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        quote_active=False,
        pricing_url=pricing_url,
        chunks=[_PRICED],
        support_enabled=support_enabled,
        contact_url=contact_url,
    )
    assert (decision.outcome == "no_support_path_standdown") is expected


def test_there_is_no_outcome_that_turns_the_gate_off():
    """No opt-out under another name. The decision type's own vocabulary is the
    cheapest place to pin that: an ``off`` outcome reappearing means something
    grew a way to disable the gate again.

    ``no_support_path_standdown`` is the one addition and it is NOT an opt-out:
    it is not reachable from any setting an owner can flip, it needs a plan with
    no human path AND no usable pricing page together, and a Free bot that names
    a usable page is gated exactly like a paid one. It is a distinct value rather
    than being folded into ``quote_standdown`` because the two mean opposite
    things about the bot's health, and the Free carve-out is the one that
    re-opens the stale-price hole and therefore has to be countable on its own.
    """
    assert set(get_args(GateOutcome)) == {
        "quote_standdown",
        "no_support_path_standdown",
        "not_pricing",
        "answer",
        "escalate_no_url",
        "escalate_no_content",
    }
    # The thing actually being guarded: no outcome that reads as a switch.
    assert not [o for o in get_args(GateOutcome) if o in ("off", "disabled", "gate_off", "opted_out")]


def test_priced_page_narrows_chunks_to_that_page_only():
    decision = evaluate_pricing_gate(
        question="how much does it cost?",
        quote_active=False,
        pricing_url="http://acme.com/pricing",
        chunks=[_OTHER, _PRICED],
    )
    assert decision.fired is True
    assert decision.outcome == "answer"
    assert decision.chunks == [_PRICED]


def test_page_present_but_carries_no_price_escalates():
    decision = evaluate_pricing_gate(
        question="how much does it cost?",
        quote_active=False,
        pricing_url="https://acme.com/pricing",
        chunks=[_UNPRICED, _OTHER],
    )
    assert decision.fired is True
    assert decision.outcome == "escalate_no_content"
    assert decision.chunks == []


def test_page_absent_from_retrieval_escalates_and_never_uses_other_sources():
    decision = evaluate_pricing_gate(
        question="how much does it cost?",
        quote_active=False,
        pricing_url="https://acme.com/pricing",
        chunks=[_OTHER],
    )
    assert decision.fired is True
    assert decision.outcome == "escalate_no_content"
    assert decision.chunks == []


def test_pivot_on_free_plan_never_offers_a_human():
    pivot = pricing_pivot(
        company_name="Acme",
        pricing_url="https://acme.com/pricing",
        support_enabled=False,
        live_chat_enabled=False,
    )
    assert pivot.suggest_handoff is False
    assert pivot.needs_message_card is False
    assert "team" not in pivot.text.lower()
    assert "connect" not in pivot.text.lower()
    # A Free bot with a configured page still hands the visitor the page.
    assert "https://acme.com/pricing" in pivot.text


def test_pivot_treats_a_url_normalize_url_rejects_as_no_url_at_all():
    """The gate escalates ``escalate_no_url`` precisely because ``normalize_url``
    rejected the configured value, so the pivot must not turn round and hand the
    same unusable string to the visitor as the place to find pricing. Both halves
    of the module have to agree on what a usable URL is."""
    for unusable in ("javascript:alert(1)", "//acme.com/pricing", "http://[::1", "   ", "not a url", 12345, None):
        pivot = pricing_pivot(
            company_name="Acme",
            pricing_url=unusable,
            support_enabled=False,
            live_chat_enabled=False,
        )
        assert "http" not in pivot.text, unusable
        assert "javascript:" not in pivot.text, unusable
        assert pivot.suggest_handoff is False
        assert pivot.needs_message_card is False


def test_pivot_on_free_plan_still_hands_over_a_usable_url_with_stray_whitespace():
    """The admin pastes links by hand; padding is cosmetic, not unusable."""
    pivot = pricing_pivot(
        company_name="Acme",
        pricing_url="  https://acme.com/pricing  ",
        support_enabled=False,
        live_chat_enabled=False,
    )
    assert "https://acme.com/pricing" in pivot.text


def test_pivot_on_free_plan_without_a_url_or_a_contact_page_stays_warm_and_bot_only():
    """Only half of the old case: with neither page there is still nothing to
    hand over, so the warm bot-only copy is all that is left."""
    pivot = pricing_pivot(
        company_name="Acme",
        pricing_url=None,
        support_enabled=False,
        live_chat_enabled=False,
    )
    assert pivot.suggest_handoff is False
    assert pivot.needs_message_card is False
    assert "team" not in pivot.text.lower()
    assert "http" not in pivot.text


def test_pivot_on_free_plan_without_a_pricing_url_hands_over_the_contact_page():
    """The other half, and the behaviour change: the contact link IS the answer.

    Still no handoff and still no card, because Free has no in-chat channel and
    this must stay a plain pointer to a public page rather than a promise of
    follow-up. The phrasing deliberately matches ``_no_info_pivot``'s Free branch
    ("You can get in touch here:") so the bot has one voice for one action.
    """
    pivot = pricing_pivot(
        company_name="Acme",
        pricing_url=None,
        support_enabled=False,
        live_chat_enabled=False,
        contact_url="https://acme.com/contact",
    )
    assert pivot.text == (
        "I don't have pricing I can confirm for **Acme**. You can get in touch here: https://acme.com/contact"
    )
    assert pivot.suggest_handoff is False
    assert pivot.needs_message_card is False
    assert "team" not in pivot.text.lower()
    assert "connect" not in pivot.text.lower()


def test_pivot_on_free_plan_prefers_the_pricing_page_over_the_contact_page():
    """Order inside the Free branch. A bot that configured both wants the visitor
    on the page that actually states prices."""
    pivot = pricing_pivot(
        company_name="Acme",
        pricing_url="https://acme.com/pricing",
        support_enabled=False,
        live_chat_enabled=False,
        contact_url="https://acme.com/contact",
    )
    assert "https://acme.com/pricing" in pivot.text
    assert "https://acme.com/contact" not in pivot.text


@pytest.mark.parametrize(
    "unusable",
    [None, "", "   ", "javascript:alert(1)", "mailto:hi@acme.com", "//acme.com/contact", "http://[::1", 42],
)
def test_pivot_treats_a_contact_url_normalize_url_rejects_as_no_contact_page(unusable):
    """Re-validated here rather than trusted from the caller, exactly as the
    pricing URL already is: this text goes straight to a visitor and into
    ``chat_messages.content``, so "You can get in touch here: javascript:alert(1)"
    must be impossible even if a future caller reads the URL from somewhere the
    extractor does not guard."""
    pivot = pricing_pivot(
        company_name="Acme",
        pricing_url=None,
        support_enabled=False,
        live_chat_enabled=False,
        contact_url=unusable,
    )
    assert "http" not in pivot.text, unusable
    assert "javascript:" not in pivot.text, unusable
    assert "mailto:" not in pivot.text, unusable
    assert pivot.suggest_handoff is False
    assert pivot.needs_message_card is False


def test_pivot_hands_over_a_usable_contact_url_with_stray_whitespace():
    """The admin pastes links by hand; padding is cosmetic, not unusable."""
    pivot = pricing_pivot(
        company_name="Acme",
        pricing_url=None,
        support_enabled=False,
        live_chat_enabled=False,
        contact_url="  https://acme.com/contact  ",
    )
    assert "https://acme.com/contact" in pivot.text
    assert "  https" not in pivot.text


@pytest.mark.parametrize("live_chat_enabled", [True, False])
def test_pivot_on_a_paid_plan_ignores_the_contact_page_entirely(live_chat_enabled):
    """The paid branch is untouched: a paid bot has the real in-chat channel,
    which is a better answer than a link, so the contact page must not be
    substituted for it on either paid variant."""
    pivot = pricing_pivot(
        company_name="Acme",
        pricing_url=None,
        support_enabled=True,
        live_chat_enabled=live_chat_enabled,
        contact_url="https://acme.com/contact",
    )
    assert "https://acme.com/contact" not in pivot.text
    assert "team" in pivot.text.lower()
    assert pivot.suggest_handoff is live_chat_enabled
    assert pivot.needs_message_card is (not live_chat_enabled)


def test_pivot_with_live_chat_offers_a_live_handoff():
    pivot = pricing_pivot(
        company_name="Acme",
        pricing_url=None,
        support_enabled=True,
        live_chat_enabled=True,
    )
    assert pivot.suggest_handoff is True
    assert pivot.needs_message_card is False
    assert "team" in pivot.text.lower()


def test_pivot_without_live_chat_asks_for_the_message_card():
    pivot = pricing_pivot(
        company_name="Acme",
        pricing_url=None,
        support_enabled=True,
        live_chat_enabled=False,
    )
    assert pivot.suggest_handoff is False
    assert pivot.needs_message_card is True


def test_pivot_without_a_company_name_reads_naturally():
    pivot = pricing_pivot(
        company_name=None,
        pricing_url=None,
        support_enabled=True,
        live_chat_enabled=True,
    )
    assert "**None**" not in pivot.text
    assert pivot.text.strip()


def test_merge_adds_an_implicit_pricing_link_whenever_a_usable_url_exists():
    merged = merge_pricing_smart_link(
        answer_links=[{"keyword": "careers", "url": "https://acme.com/jobs"}],
        pricing_url="https://acme.com/pricing",
    )
    assert {"keyword": "pricing", "url": "https://acme.com/pricing"} in merged
    assert {"keyword": "careers", "url": "https://acme.com/jobs"} in merged


def test_merge_does_not_override_an_admins_own_pricing_keyword():
    existing = [{"keyword": "Pricing", "url": "https://acme.com/plans"}]
    merged = merge_pricing_smart_link(
        answer_links=existing,
        pricing_url="https://acme.com/pricing",
    )
    assert merged == existing


@pytest.mark.parametrize(
    "unusable",
    [None, "", "   ", "javascript:alert(1)", "acme.com/pricing", "rate-card-2024.pdf", "http://[::1", 42],
)
def test_merge_is_a_no_op_when_no_usable_pricing_url_is_configured(unusable):
    """The old no-op condition was "the owner left the gate off"; there is no
    such state now, so the only thing that suppresses the implicit link is the
    absence of a page worth linking to. An unusable value must be treated as no
    URL at all rather than shipped into the SMART LINKS prompt block."""
    existing = [{"keyword": "careers", "url": "https://acme.com/jobs"}]
    assert merge_pricing_smart_link(answer_links=existing, pricing_url=unusable) == existing


def test_merge_handles_no_existing_links():
    merged = merge_pricing_smart_link(answer_links=None, pricing_url="https://acme.com/pricing")
    assert merged == [{"keyword": "pricing", "url": "https://acme.com/pricing"}]


# ── The raw-question / rewritten-query pair the pipelines feed this module ───


def test_a_pronoun_followup_carries_the_pricing_intent_only_after_the_rewrite():
    """Why both pipelines test the raw question AND the rewritten search query.

    "do you have plans?" then "and that one?" is a real visitor sequence. The
    raw follow-up has no price token, so a gate that only reads it stands down
    and the unrestricted knowledge base answers a pricing question, which is
    the exact failure this feature exists to prevent.
    """
    assert is_pricing_question("and that one?") is False
    assert is_pricing_question("what is the pricing for the Pro plan?") is True


def test_the_two_phrasings_must_be_tested_separately_not_concatenated():
    """The idiom exclusion is checked before tokens, so joining the raw
    question and the rewrite into one string lets an idiom in either half
    suppress a genuine price token in the other."""
    raw = "how much time does onboarding take?"
    rewritten = "what is the pricing for onboarding?"

    assert is_pricing_question(raw) is False
    assert is_pricing_question(rewritten) is True
    # Concatenated, the idiom in the raw half wins and the gate never fires.
    assert is_pricing_question(f"{raw} {rewritten}") is False
