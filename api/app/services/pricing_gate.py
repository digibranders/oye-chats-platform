"""Pricing answer gate.

A visitor's pricing question is answered ONLY from the chunks of the page named
in ``bots.pricing_url``. If that page is not in the knowledge base, or is there
but carries no actual price content, the bot does NOT fall back to the rest of
the knowledge base: it routes the visitor to the team instead. A stale price
quoted confidently from an old uploaded rate card is a worse outcome than "let
me get you to someone who can confirm".

The gate has no per-bot opt-in and no opt-out. There is no toggle anywhere in
the product, and ``pricing_url`` is not one: it selects the SOURCE a bot may
price from, not whether the restriction applies. On every paid plan a bot that
names no pricing page routes every pricing question to the team
(``escalate_no_url``) rather than letting the general knowledge base answer one,
which is precisely the behaviour the product owner asked for: a stale rate card
must never answer a pricing question.

THE FREE CARVE-OUT. There is exactly one plan-shaped exception, and it exists
because on Free the escalation has nowhere to escalate TO. ``support_enabled``
is the PLAN half of the human-support gate (does the subscription include
``live_chat`` at all), and on Free it is False, which means no live queue AND no
leave-a-message form. A Free bot with no usable ``pricing_url`` therefore used to
produce a pure dead end: it refused to answer AND offered no alternative, because
the alternative it would normally offer does not exist on that plan. So in that
one combination (no human path AND no usable page) the gate stands down entirely
(``no_support_path_standdown``), ``chunks`` pass through untouched, and the turn
is answered from the knowledge base exactly as it was before this feature
existed. Refusing to answer while offering nothing is a worse outcome for that
visitor than an answer from the knowledge base.

ACCEPTED CONSEQUENCE, stated plainly because it is the whole cost of the
carve-out: a Free bot with no pricing page can once again quote a stale price
from an old uploaded document, and Free has the least-maintained knowledge bases
on the platform. The product owner accepted that in exchange for not dead-ending
the visitor. Note how narrow the hole is: a Free bot that DOES name a usable
pricing page is still fully gated, because ``pricing_pivot`` can hand that page
over and the visitor gets something useful either way.

The other standdown is per-turn rather than per-bot: while a BANT quotation is
active or pending for the session, ``quote_active`` stands the gate down for that
turn. The quotation card is an admin-authored priced document, so it is the
better pricing answer while it is in flight.

Callers must keep any "will the gate intercept this turn?" precondition in step
with the standdown, which is why ``no_support_path_standdown`` is exported as a
predicate rather than being inlined inside ``evaluate_pricing_gate``. Both
pipelines bypass their QA answer cache on pricing intent, and on a bot that is
going to stand down that bypass buys nothing and costs a full pipeline run; both
callsites reuse the predicate below so the two can never drift apart.

Pure module by design: no DB, no I/O, and no import from ``rag_service`` (which
imports this one). Everything here is a decision the callers act on.

KNOWN LIMITATIONS (deliberate, revisit with evidence):

1. English-only intent detection, and WEAKER than it looks. ``is_pricing_question``
   is a regex over English tokens, so a pricing question in Hindi, Spanish, or
   any non-Latin script does NOT fire the gate and the turn is answered from the
   unrestricted knowledge base. This is the safe failure direction relative to
   the pre-gate behaviour (nothing regresses for those visitors) but it does mean
   a multilingual visitor can still get a price from a stale uploaded document.

   The currency rule is the ONLY signal in the detector that survives
   translation, and it no longer fires on its own. It now requires corroboration
   in the same turn: a question mark, one of the English price tokens, or a
   second-person reference (``you`` / ``your`` / ``yours``). In practice that
   means a non-English pricing question is now caught only when it is punctuated
   as a question ("₹5000?"), so the already-weak multilingual coverage is weaker
   still.

   That narrowing was deliberate and is worth the loss. A BARE monetary amount is
   overwhelmingly a BANT budget ANSWER, not a pricing question: this bot asks
   visitors about Budget and offers pre-written budget pills, so "$20K+/mo",
   "our budget is around $20k" and "₹5,00,000" are the single most common way a
   currency amount reaches this function. Firing on those intercepted the turn
   before generation, so the Budget dimension was never scored and a visitor who
   had just told us their budget was answered with "pricing is best confirmed by
   the team". Breaking budget capture on every bot on the platform is a far worse
   harm than missing a non-English pricing question the detector was already
   missing for want of an English token.

   The same English-only constraint already applies to ``_ON_SCOPE_HINTS_RE``
   and the CRAG judge in ``rag_service``; fix them together, not separately.

2. URL matching is exact after normalization. A pricing page reachable at more
   than one path, or crawled under a URL the admin did not paste, will not
   match and every pricing question escalates. Nothing warns the admin about
   this today: the Voice section saves the URL without checking it against the
   knowledge base, so a typo or an unmatched path is a silent misconfiguration
   whose only symptom is that every pricing question escalates.

3. ``has_price_signal`` is a heuristic, not a classifier. A pricing page that
   states prices in a form none of its patterns cover reads as "no price
   content" and escalates. Escalating is the intended failure direction: the
   alternative is answering a pricing question from the rest of the knowledge
   base, which is the exact behaviour this gate exists to prevent.

4. Scoping to one page makes staleness more visible, not less. The named page
   is the single source, so a stale crawl is quoted with full confidence. There
   is no last-crawled indicator anywhere in the admin UI, so an admin cannot
   tell how old the chunks behind a gated answer are without re-crawling the
   page.

5. The gate filters the FINALIZED top-15 retrieval result, not the whole
   knowledge base. On a large knowledge base a phrasing that fails to surface
   the pricing page inside that top-15 window escalates even though the page
   is present and priced, and a retrieval miss is indistinguishable here from
   a missing page: both arrive as "no chunk matched the target URL" and both
   report ``escalate_no_content``. Filtering the finalized list is deliberate
   (it composes with fusion and rerank instead of duplicating retrieval), but
   it means the escalation rate is bounded below by retrieval recall.

6. A bot whose pricing lives ONLY in an uploaded document cannot answer pricing
   at all. ``pricing_url`` is matched against ``documents.document_name``, and
   an uploaded file's ``document_name`` is a filename ("rate-card-2026.pdf"),
   never a URL, so ``normalize_url`` rejects it and it can never equal the
   configured target. Such a bot escalates EVERY pricing question, including
   ones its own uploaded rate card answers correctly. This is the cost the
   product owner accepted when the gate became unconditional: the gate cannot
   tell a current uploaded rate card from a stale one, and quoting the stale
   one is the failure it exists to prevent. The workaround for an affected bot
   is to crawl the pricing page and set ``pricing_url`` to it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit


def normalize_url(raw: object) -> str | None:
    """Reduce a URL to the ``host/path`` form both sides of a comparison share.

    The admin pastes a link by hand and the crawler stores whatever URL it
    fetched, so ``https://www.acme.com/pricing/`` and ``http://acme.com/pricing``
    must compare equal or the gate escalates every pricing question on a bot
    that is in fact configured correctly.

    Dropped: scheme, ``www.``, port, trailing slash, query string, fragment.
    Query strings are dropped because an admin routinely pastes a link with a
    ``?utm_...`` tail; a site that genuinely serves different pricing per query
    parameter is out of scope for this gate.

    Host is lowercased (case-insensitive by DNS); path is NOT (case-sensitive on
    most servers). Returns None for anything that is not an http(s) URL.
    """
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    if not value:
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https"):
            return None
        host = (parsed.hostname or "").lower()
    except ValueError:
        # ``urlsplit`` ITSELF raises on a malformed bracketed IPv6 literal
        # (``urlsplit("http://[::1")`` -> ValueError: Invalid IPv6 URL), so the
        # parse has to be inside the try. It is not deferred to ``.hostname``,
        # which on CPython 3.11 does no validation at all (``.port`` is the
        # attribute that raises, and this function never reads it). The
        # ``.hostname`` read stays inside the try as cheap insurance against
        # that split moving between versions. This runs on every retrieved
        # chunk's document_name on every gated pricing turn, so an unhandled
        # raise here 500s the whole chat turn.
        return None
    if not host:
        return None
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path.rstrip("/")
    return f"{host}{path}" if path else f"{host}/"


# A visitor asking us what we charge. Deliberately NARROW: a false positive
# escalates a question the knowledge base could have answered, which is a
# visible regression, while a false negative just leaves today's behaviour in
# place. Everything in this set is English-only (see the module note on failing
# open for non-Latin scripts); the currency rule below is the one exception, and
# it is deliberately kept out of this set because it needs corroboration.
_PRICE_TOKENS_RE = re.compile(
    r"(?:\bpricing\b|\bprices?\b|\bpriced\b"
    r"|\bcosts?\b|\bcosting\b"
    r"|\bfees?\b|\bcharges?\b"
    r"|\bquotation\b|\bquotes?\b"
    r"|\brate\s*card\b|\bprice\s*list\b"
    r"|\bhow\s+much\b)",
    re.IGNORECASE,
)

# A monetary amount: a currency symbol carrying a digit. This is the one signal
# in the whole detector that survives translation, so it stays, but it may NOT
# fire the gate on its own.
#
# The reason is that this bot runs a BANT qualification flow, and the single
# most common way a visitor writes a currency amount is as the ANSWER to the
# bot's own Budget question ("$20K+/mo", "our budget is around $20k",
# "₹5,00,000"), often by tapping a pre-written budget pill. A visitor STATING
# their budget is not a visitor ASKING what we charge, and treating it as one
# was catastrophic: the gate intercepted the turn before generation, so the
# Budget dimension was never scored and someone who had just told us their
# budget was answered with "pricing is best confirmed by the team". That
# regressed the revenue-critical path on every paid bot.
#
# The distinction the gate was missing is one the codebase already draws
# elsewhere: the BANT extraction prompt in ``rag_service`` ("STATEMENT vs
# QUESTION") says to extract budget only from statements the user makes about
# THEMSELVES, and that "what is your pricing?" is a question about us, not a
# budget signal about the user. This regex pair encodes the same rule.
_CURRENCY_AMOUNT_RE = re.compile(r"[₹$€£¥]\s*\d")

# The corroboration an amount needs before it counts as a pricing QUESTION:
# either the turn is punctuated as a question, or it points at us. A bare
# amount is a statement about the visitor; "is it ₹5000 per month?" and "is
# $500 your monthly rate" are about us. The English price tokens above are the
# third form of corroboration, but they need no wiring here because any one of
# them already fires the gate on its own.
_ASKING_US_RE = re.compile(r"(?:\?|\byou\b|\byour\b|\byours\b)", re.IGNORECASE)

# Phrases that contain a price token but are NOT a request for our prices.
# Checked FIRST, so "how much time does onboarding take" keeps reaching the
# knowledge base instead of being escalated to a human.
_PRICE_IDIOM_RE = re.compile(
    r"(?:\bat\s+all\s+costs?\b"
    r"|\bcost\s+of\s+living\b"
    r"|\bworth\s+the\s+cost\b"
    r"|\bcosts?\s+(?:me|us|them|you)\s+(?:time|nothing|effort)\b"
    r"|\bhow\s+much\s+(?:time|longer|experience|notice|data|storage)\b"
    r"|\bfree\s+(?:trial|demo)\b)",
    re.IGNORECASE,
)


def is_pricing_question(question: object) -> bool:
    """True when the visitor is asking what we charge.

    Order matters twice over.

    Idioms are excluded before anything is matched, because every idiom above
    contains a token that would otherwise fire the gate.

    Then the English tokens are tried BEFORE the currency rule, because they are
    self-sufficient and the currency rule is not: an amount fires only when the
    turn also carries evidence that the visitor is asking US something. Putting
    the tokens first means "what is your pricing?" never reaches the
    corroboration check, and "is it $500 a month?" is caught by the currency
    branch on its question mark. A bare amount ("$20K+/mo") reaches neither and
    is correctly read as the BANT budget answer it almost always is.
    """
    if not isinstance(question, str) or not question.strip():
        return False
    if _PRICE_IDIOM_RE.search(question):
        return False
    if _PRICE_TOKENS_RE.search(question):
        return True
    return bool(_CURRENCY_AMOUNT_RE.search(question) and _ASKING_US_RE.search(question))


# Does a chunk of the pricing page actually carry price content? A page can be
# in the knowledge base and still say nothing about money (a stub page, a
# redirect landing, a crawl that captured only the nav). Answering "our pricing
# is..." from such a page produces an invented figure, so the gate treats it the
# same as a missing page and routes to the team.
#
# The "no figure" shapes (custom pricing / contact sales / free tier) count as
# price signal on purpose: they ARE the page's pricing answer, and relaying them
# verbatim is correct and useful.
_PRICE_SIGNAL_RE = re.compile(
    r"(?:[₹$€£¥]\s*\d"
    r"|\b\d[\d,]*(?:\.\d+)?\s*(?:usd|inr|eur|gbp|rs\.?|rupees?|dollars?|euros?|pounds?)\b"
    r"|\b(?:usd|inr|eur|gbp|rs\.?)\s*\d"
    r"|\b\d[\d,]*(?:\.\d+)?\s*(?:/|per\s+)(?:mo|month|yr|year|user|seat|licen[cs]e)\b"
    r"|\bcustom\s+pricing\b"
    r"|\bcontact\s+(?:us|sales|our\s+team)\s+for\s+(?:a\s+)?(?:price|pricing|quote)\b"
    r"|\bfree\s+(?:plan|tier|forever)\b"
    r"|\bstarts?\s+(?:at|from)\s*[₹$€£¥]?\s*\d)",
    re.IGNORECASE,
)


def has_price_signal(text: object) -> bool:
    """True when ``text`` plausibly contains price content. Heuristic by design."""
    if not isinstance(text, str) or not text.strip():
        return False
    return bool(_PRICE_SIGNAL_RE.search(text))


GateOutcome = Literal[
    "quote_standdown",
    "no_support_path_standdown",
    "not_pricing",
    "answer",
    "escalate_no_url",
    "escalate_no_content",
]


@dataclass(frozen=True)
class PricingGateDecision:
    """What the caller should do with this turn.

    ``fired`` is False for the three pass-through outcomes
    (``quote_standdown``, ``no_support_path_standdown``, ``not_pricing``); in
    all three the caller must use ``chunks`` unchanged and continue exactly as
    it does today.

    The two standdowns are deliberately distinct values rather than one shared
    "standdown", because they are different failures to reason about and are
    counted separately: ``quote_standdown`` is per-TURN (a BANT quotation is in
    flight for this session, and that admin-authored priced document is the
    better answer) while ``no_support_path_standdown`` is per-BOT-CONFIGURATION
    (a plan with no human path, on a bot with no usable pricing page, so the
    gate has nothing to escalate to and nothing to answer from). Collapsing them
    would make it impossible to tell a healthy quote flow from the Free
    carve-out re-opening the stale-price hole.

    There is still no "off" outcome, because nothing turns the gate off: a Free
    bot that names a usable pricing page is gated exactly like a paid one.

    When ``fired`` is True the caller either narrows retrieval to ``chunks``
    (``answer``) or takes a canned early return (both ``escalate_*`` outcomes,
    where ``chunks`` is always empty so no other source can leak into the reply).
    """

    fired: bool
    outcome: GateOutcome
    chunks: list


def no_support_path_standdown(*, support_enabled: bool, pricing_url: object) -> bool:
    """True when this bot has neither a human path NOR a page it may price from.

    ``support_enabled`` is the PLAN half of the human-support gate: does the
    subscription funding this bot include ``live_chat`` at all. On Free it is
    False, which means no live queue and no leave-a-message form, so an
    escalation has nowhere to go. Combined with no usable ``pricing_url`` there
    is neither a source to answer from nor a human to hand over to, and the gate
    would produce a pure dead end. So it stands down and the knowledge base
    answers, as it did before this feature existed.

    Usability is decided by ``normalize_url``, NOT by truthiness, so this agrees
    with ``evaluate_pricing_gate`` (which reaches ``escalate_no_url`` precisely
    when ``normalize_url`` returns None) and with ``pricing_pivot`` /
    ``merge_pricing_smart_link`` (which both refuse to hand a visitor a value
    ``normalize_url`` rejected). A truthiness test here would leave
    ``pricing_url="javascript:alert(1)"`` on a Free bot escalating into the dead
    end this exists to remove.

    Exported so the pipelines can ask the same question the gate asks. Both of
    them bypass their QA answer cache on pricing intent, and on a bot that is
    going to stand down that bypass is pure waste: it buys a full uncached
    pipeline run to protect against an interception that will not happen. Reusing
    one predicate is what stops the bypass condition and the gate's own standdown
    from drifting apart as either side is edited.
    """
    return not support_enabled and normalize_url(pricing_url) is None


def evaluate_pricing_gate(
    *,
    question: object,
    quote_active: bool,
    pricing_url: object,
    chunks: list,
    support_enabled: bool = True,
) -> PricingGateDecision:
    """Decide how a turn should be handled under the pricing answer gate.

    There is no enable flag to pass, because there is no opt-out: every bot is
    gated on every pricing-intent turn, with the single carve-out below.

    ``quote_active`` is the per-TURN standdown: True means a BANT quotation is
    active or pending for this session, and that admin-authored priced document
    is the better pricing answer while it is in flight. It is passed positively
    ("a quote is running") rather than as an inverted "the gate may run" flag so
    the callsite reads as what it actually asks the DB
    (``quote_active=_quote_active_or_pending(...)``) with no negation to unpick.

    ``support_enabled`` is the PLAN half of the human-support gate: does the
    subscription funding this bot include ``live_chat`` at all. It is the same
    value ``pricing_pivot`` takes, and the callsites pass the same
    ``_plan_support_allowed`` to both. It exists here for one combination only:
    a plan with no human path AND no usable ``pricing_url`` has nowhere to
    escalate to, so the gate stands down rather than dead-ending the visitor
    (see ``no_support_path_standdown`` and the module docstring for the cost
    that buys). It defaults to True so a caller that forgets it gets the
    fully-gated PAID behaviour, which is the safe direction: a missed
    ``support_enabled=False`` costs one Free visitor a knowledge-base answer,
    whereas a defaulted-False would silently un-gate the whole platform.

    ``chunks`` is the finalized retrieval result (fused, trimmed, reranked): a
    list of anything exposing ``document_name`` and ``content``.
    """
    if quote_active:
        return PricingGateDecision(fired=False, outcome="quote_standdown", chunks=chunks)
    if not is_pricing_question(question):
        return PricingGateDecision(fired=False, outcome="not_pricing", chunks=chunks)

    # Checked AFTER intent, not before, so a non-pricing turn on a Free bot
    # still reports ``not_pricing``: the two say very different things about
    # what happened, and the standdown count is only meaningful if it counts
    # turns the gate would otherwise have intercepted.
    if no_support_path_standdown(support_enabled=support_enabled, pricing_url=pricing_url):
        return PricingGateDecision(fired=False, outcome="no_support_path_standdown", chunks=chunks)

    target = normalize_url(pricing_url)
    if target is None:
        # No pricing page named, or one this module cannot use. There is no
        # source we are allowed to price from, so do not try: an unconfigured
        # bot routes its pricing questions to the team rather than letting the
        # general knowledge base answer them. Only reachable on a plan that HAS
        # a team to route to; the standdown above took the other branch.
        return PricingGateDecision(fired=True, outcome="escalate_no_url", chunks=[])

    kept = [c for c in chunks if normalize_url(getattr(c, "document_name", None)) == target]
    if not kept or not any(has_price_signal(getattr(c, "content", None)) for c in kept):
        # Either the page never made it into the knowledge base, or it did and
        # says nothing about money. Both mean the same thing to the visitor.
        return PricingGateDecision(fired=True, outcome="escalate_no_content", chunks=[])

    return PricingGateDecision(fired=True, outcome="answer", chunks=kept)


@dataclass(frozen=True)
class PricingPivot:
    """The canned reply for an escalating pricing turn.

    ``text`` carries no card token, and the caller must not add one:
    ``LEAVE_MESSAGE_CARD_SENTINEL`` is an LLM-to-server token that both
    pipelines strip from the answer before persisting it, so appending it to a
    canned reply ships the literal token to the visitor and renders no form.

    ``needs_message_card`` instead tells the caller to set the
    ``show_leave_message`` metadata key (and mark the card shown for
    per-session dedupe) the way its own leave-message code path already does.
    Keeping the sentinel out of this module also keeps it defined in exactly
    one place (``rag_service``) and keeps this module free of a circular
    import.
    """

    text: str
    suggest_handoff: bool
    needs_message_card: bool


def pricing_pivot(
    *,
    company_name: str | None,
    pricing_url: str | None,
    support_enabled: bool,
    live_chat_enabled: bool,
) -> PricingPivot:
    """The reply for a pricing question the gate refuses to answer from the KB.

    ``support_enabled`` is the PLAN half of the human-support gate (does this
    bot's plan include ``live_chat`` at all). On Free it is False, meaning there
    is neither a live queue nor a leave-a-message form, so the copy must not
    name the team, promise a callback, or ask for a card. It hands over the
    pricing page if one is configured and otherwise stays a warm bot-only pivot.

    ``live_chat_enabled`` is the EFFECTIVE real-time value and only chooses
    between the live handoff and the async message card on a paid plan.

    NOTE on the Free-with-no-usable-URL branch below: since the Free carve-out
    landed, ``evaluate_pricing_gate`` stands down for that exact combination and
    never escalates it, so the pipelines can no longer reach that copy. It is
    kept, and kept tested, on purpose. This is a pure function with its own
    callers-in-waiting and its own test suite, its four branches are the
    complete truth table of its two flags, and deleting a branch to chase
    coverage would silently turn a future miswiring into an ``UnboundLocalError``
    instead of a warm bot-only reply. The gate is the thing that decides this
    combination never arrives; the pivot's job is to be correct if it does.
    """
    cn = f"**{company_name}**" if company_name else "us"

    # Both halves of this module must agree on what counts as a usable URL. The
    # gate reaches this pivot on ``escalate_no_url`` precisely BECAUSE
    # ``normalize_url`` rejected the configured value, so testing it here for
    # truthiness alone would turn round and hand the visitor the exact string
    # the gate just refused to price from ("the current pricing is here:
    # javascript:alert(1)"), shipped to the widget and persisted to
    # ``chat_messages.content``. ``merge_pricing_smart_link`` below already
    # guards the same way; an unusable URL is treated as no URL at all, which
    # takes the no-link copy.
    usable_url = pricing_url.strip() if isinstance(pricing_url, str) and normalize_url(pricing_url) else None

    if not support_enabled:
        if usable_url:
            return PricingPivot(
                text=(
                    f"I'd rather not quote a figure I can't confirm for {cn}. The current pricing is here: {usable_url}"
                ),
                suggest_handoff=False,
                needs_message_card=False,
            )
        return PricingPivot(
            text=(
                f"I don't have pricing I can confirm for {cn}. Is there something else about {cn} I can help you with?"
            ),
            suggest_handoff=False,
            needs_message_card=False,
        )

    if live_chat_enabled:
        return PricingPivot(
            text=(
                f"Pricing for {cn} is best confirmed by the team so you get an "
                f"accurate figure. Want me to connect you with them now?"
            ),
            suggest_handoff=True,
            needs_message_card=False,
        )

    return PricingPivot(
        text=(
            f"Pricing for {cn} is best confirmed by the team so you get an "
            f"accurate figure. I'll open a quick message form so they can get back to you."
        ),
        suggest_handoff=False,
        needs_message_card=True,
    )


def merge_pricing_smart_link(
    *,
    answer_links: list | None,
    pricing_url: object,
) -> list:
    """Add an implicit ``pricing`` smart link whenever a usable page is named.

    A gated pricing answer should always hand the visitor the page it came from,
    and the SMART LINKS prompt block already does that job. Merging here rather
    than adding a second linking mechanism keeps one code path for hyperlinks.

    A usable ``pricing_url`` is now the only precondition, because it is the
    only control the gate has: a bot that names a pricing page is gated to it,
    so the link is always the right one to offer. A bot that names none gets
    nothing merged, exactly as before.

    The admin's own entry always wins: if they already mapped the ``pricing``
    keyword, this returns the list untouched, even when it points somewhere else.
    """
    existing = list(answer_links or [])
    url = pricing_url if isinstance(pricing_url, str) else None
    if not url or normalize_url(url) is None:
        return existing
    for item in existing:
        if isinstance(item, dict) and (item.get("keyword") or "").strip().casefold() == "pricing":
            return existing
    return existing + [{"keyword": "pricing", "url": url.strip()}]
