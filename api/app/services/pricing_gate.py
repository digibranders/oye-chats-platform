"""Pricing answer gate.

A visitor's pricing question is answered ONLY from the chunks of the page named
in ``bots.pricing_url``. If that page is not in the knowledge base, or is there
but carries no actual price content, the bot does NOT fall back to the rest of
the knowledge base: it routes the visitor to the team instead. A stale price
quoted confidently from an old uploaded rate card is a worse outcome than "let
me get you to someone who can confirm".

The gate has exactly ONE opt-out, and it is the bot owner's:
``Bot.pricing_from_knowledge_base`` (default False, outcome ``owner_optout``,
checked straight after the in-flight-quotation standdown). It exists because
the gate assumes a trustworthy price lives on a public pricing page, and that
is false for every customer whose price list is an uploaded PDF: those bots
escalated every pricing question to the team while holding the answer. Opting
out does NOT narrow chunks; the bot answers pricing from everything it knows,
which is what the owner asked for.

``pricing_url`` is not an opt-out: it selects the SOURCE a gated bot may price
from, not whether the restriction applies. With the default False, a bot that
names no pricing page routes every pricing question to the team
(``escalate_no_url``) rather than letting the general knowledge base answer one:
a stale rate card must never answer a pricing question by accident.

THE FREE CARVE-OUT. There is exactly one plan-shaped exception, and it exists
because on Free the escalation has nowhere to escalate TO. ``support_enabled``
is the PLAN half of the human-support gate (does the subscription include
``live_chat`` at all), and on Free it is False, which means no live queue AND no
leave-a-message form. A Free bot with no usable ``pricing_url`` therefore used to
produce a pure dead end: it refused to answer AND offered no alternative, because
the alternative it would normally offer does not exist on that plan.

The carve-out is now the fallback of LAST RESORT rather than the first response
to that plan, because a Free bot usually does have somewhere to send the visitor:
the customer's own public contact page, already mapped as a ``contact`` Smart
Link on most bots. So the Free priority chain for a pricing question is: a usable
``pricing_url`` answers from that page; failing that, a usable ``contact_url``
escalates (``escalate_no_url``, chunks emptied) and ``pricing_pivot`` hands the
contact link over as the whole reply; and only with NEITHER page does the gate
stand down (``no_support_path_standdown``), pass ``chunks`` through untouched and
let the knowledge base answer as it did before this feature existed. Refusing to
answer while offering nothing is a worse outcome for that visitor than an answer
from the knowledge base; refusing to answer while handing them the page that CAN
answer is a better one than either.

WHY handing over the contact page is not a paywall leak, kept here so nobody
undoes it as one: the paid feature is the in-chat CHANNEL (live queue,
leave-a-message form, operator inbox, notification emails). A public page on the
customer's own website is information, not a channel, and the Free copy promises
no follow-up through the chat: ``suggest_handoff`` and ``needs_message_card``
both stay False, so no queue is joined and no form is opened. It is the same
reasoning that already lets the Free pivot hand over ``pricing_url``, and the
same reasoning behind ``rag_service._no_info_pivot``'s Free branch, whose
phrasing this deliberately matches.

ACCEPTED CONSEQUENCE, stated plainly because it is the whole remaining cost of
the carve-out: a Free bot with NEITHER a pricing page NOR a contact page can
once again quote a stale price from an old uploaded document, and Free has the
least-maintained knowledge bases on the platform. The product owner accepted
that in exchange for not dead-ending the visitor. Note how narrow the hole now
is: it needs a bot that named no pricing page AND mapped no contact Smart Link,
because either one alone gives the visitor something useful and keeps the gate
firing.

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

6. The stale-price hole is narrow but real, and it is invisible to the admin.
   A Free bot that names no ``pricing_url`` AND maps no ``contact`` Smart Link
   answers pricing questions from its unrestricted knowledge base, so an old
   uploaded rate card can be quoted with full confidence. Mapping a contact
   page closes it (the gate escalates and hands that page over instead), and
   any paid plan closes it (the gate escalates to the team), but nothing in
   the admin UI tells an owner which side of that line their bot is on: the
   Smart Links editor never says a ``contact`` entry also governs pricing
   answers. The fix if this starts to bite is a warning in the Voice section,
   not a widening of the gate.

7. A bot whose pricing lives ONLY in an uploaded document cannot answer pricing
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


#: Long price words worth recognising through a single typo. Kept to words of
#: six letters or more on purpose: one edit away from "price" are "pride",
#: "prime" and "prize", and one edit from "cost" is "cast", all of which a
#: visitor types about things that are not our rates. At seven letters the
#: neighbourhood of "pricing" holds nothing a visitor plausibly means instead.
_NEAR_MISS_PRICE_WORDS = frozenset({"pricing", "quotation", "pricelist"})
_NEAR_MISS_MIN_LEN = 6
_WORD_RE = re.compile(r"[a-z]+")


def _within_one_edit(a: str, b: str) -> bool:
    """True when ``a`` and ``b`` differ by at most one insertion, deletion,
    substitution, or swap of two adjacent letters."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la == lb:
        diffs = [i for i in range(la) if a[i] != b[i]]
        if len(diffs) == 1:
            return True
        if len(diffs) == 2:
            i, j = diffs
            return j == i + 1 and a[i] == b[j] and a[j] == b[i]
        return False
    short, long_ = (a, b) if la < lb else (b, a)
    i = j = 0
    skipped = False
    while i < len(short) and j < len(long_):
        if short[i] == long_[j]:
            i += 1
            j += 1
        elif skipped:
            return False
        else:
            skipped = True
            j += 1
    return True


def _has_near_miss_price_word(question: str) -> bool:
    """True when the visitor typed one of the long price words with one typo.

    The gate decides from the wording of the question, so it only ever fires on
    words it recognises. On 2026-09-10 a visitor on a live bot typed "iwant to
    know the soc pricng ?". "pricng" is not "pricing", the gate did not fire,
    and the turn went to the general knowledge base, which answered with rate
    figures. Two other visitors on the same bot spelled it correctly and were
    handed to the team. Same intent, opposite behaviour, decided by one missing
    letter, and it looked to the tester like the bot behaved differently on
    different devices.
    """
    for word in _WORD_RE.findall(question.lower()):
        if len(word) < _NEAR_MISS_MIN_LEN:
            continue
        if any(_within_one_edit(word, target) for target in _NEAR_MISS_PRICE_WORDS):
            return True
    return False


#: The price guard's question signal (see ``price_guard``): each long word with
#: the number of edits it tolerates. Wider than ``_NEAR_MISS_PRICE_WORDS`` on
#: purpose. The gate acts on the question alone, so a near miss there escalates a
#: question the knowledge base could answer; the guard also needs a figure in the
#: answer, so a question that only looks like a pricing question changes nothing
#: on an answer without one. ``is_pricing_question`` does not use it.
_FUZZY_PRICE_WORDS: tuple[tuple[str, int], ...] = (
    ("pricing", 2),
    ("prices", 1),
    ("quotation", 1),
    ("costing", 1),
)
#: Words of five letters or more are tried against ``_FUZZY_PRICE_WORDS``.
_FUZZY_MIN_LEN = 5
#: Short price words read through one typo, a swap of two letters included ("cots",
#: "qoute", "prcie"), in words of four or five letters.
_SHORT_PRICE_WORDS = ("cost", "costs", "quote", "price", "rates", "fees")
_SHORT_WORD_LENGTHS = range(4, 6)
#: Price words read through one typo, a swap of two letters included, only in words
#: of these lengths: "rtae", "chrage", "budjet", "subscripton". The lengths keep
#: "rated", "charging" and "budge" out.
_TYPO_PRICE_WORDS: tuple[tuple[str, range], ...] = (
    ("rate", range(4, 5)),
    ("charge", range(6, 8)),
    ("charges", range(6, 8)),
    ("budget", range(6, 8)),
    ("subscription", range(11, 14)),
)
#: Ordinary words within the tolerated edits of a price word. "most" is one edit
#: from "cost", "quite" from "quote", "writing" two from "pricing"; none of them
#: is a pricing question.
_NOT_A_PRICE_TYPO = frozenset(
    {
        # cost, costs
        "cast", "casts", "coast", "coat", "coats", "colt", "colts", "coot", "cosh", "cosy", "cyst", "cysts",
        "host", "hosts", "lost", "most", "post", "posts",
        # quote
        "quite", "quota", "quoth",
        # price, prices
        "pride", "prides", "prime", "primes", "prize", "prizes", "prick", "pricks", "rice", "trice",
        # rates
        "rated", "rater", "dates", "gates", "hates", "mates", "fates", "races", "rakes", "raves", "rites", "rats",
        "rotes", "pates",
        # fees
        "bees", "feed", "feeds", "feel", "feels", "feet", "fess", "foes", "feds", "fens", "sees", "tees", "lees",
        "frees", "flees",
        # pricing
        "arcing", "bracing", "bricking", "dicing", "driving", "griping", "icing", "paining", "piecing", "piking",
        "piling", "pining", "piping", "praising", "prancing", "prating", "praying", "pricking", "prickling",
        "priding", "priming", "printing", "prosing", "proving", "pruning", "prying", "racing", "riding", "rising",
        "riving", "slicing", "spicing", "splicing", "tracing", "tricking", "uprising", "voicing", "writing",
        # charges, costing
        "charger", "chargers", "charles", "casting", "coasting", "coating", "hosting", "posting",
        # rate
        "date", "fate", "gate", "hate", "kate", "late", "mate", "nate", "pate", "race", "rage", "rake", "rape",
        "rare", "rath", "rave", "raze", "rite", "rote", "sate", "tate",
        # charge, charges, budget
        "change", "changes", "chargee", "budged", "budger", "budges",
    }
)  # fmt: skip
#: Price words the guard's signal takes only as spelled: one edit from "fee" is
#: "fed", one from "rate" is "date".
_EXACT_PRICE_WORDS = frozenset({"fee", "rate", "budget", "tariff", "tarrif", "tarif", "pricelist", "ratecard"})
#: "how much", typos included, and the other ways of asking what something costs.
_HOW_MUCH_RE = re.compile(
    r"\b(?:(?:how|hw|hoe|hwo|hows)\s+(?:much|muc|mch|mcuh|muhc|mich|mutch)|how\s+(?:expensive|pricey)"
    r"|price\s+list|rate\s+card)\b",
    re.IGNORECASE,
)
#: Plan words in a question: "what plans do you offer?", "your SOC packages".
_PLAN_QUESTION_RE = re.compile(r"\b(?:plans?|packages?|subscriptions?|tiers?|editions?)\b", re.IGNORECASE)
#: A word up to two words before "plan" or "plans" that makes it a plan the visitor
#: or a third party has, not one the company sells: "health insurance plan",
#: "treatment plan", "business continuity plan". Question-side only: a visitor who
#: asks about one of these is not asking what the company charges.
#:
#: ``price_guard`` reads answers with ``_NOT_OWN_PLAN_WORDS_ANSWER`` below, a
#: shorter list, because a word that is a safe question-side exclusion can still be
#: a common plan TIER name in an answer: "The Business plan costs $99 a month."
#: (production review, 2026-09-11) must trip even though "what's your business
#: plan?" must not signal. "Care" and "Recovery" are dropped for the same reason
#: (a healthcare or DR vendor's own tier), leaving both only on the question side.
_NOT_OWN_PLAN_WORDS = (
    "insurance", "health", "medical", "dental", "vision", "treatment", "payment", "instalment", "installment",
    "meal", "study", "lesson", "business", "continuity", "action", "floor", "project", "response", "retirement",
    "pension", "savings", "investment", "care", "recovery", "evacuation",
)  # fmt: skip
#: The answer-side list: ``_NOT_OWN_PLAN_WORDS`` minus the words that are commonly
#: a plan TIER name a company sells under ("business", "care", "recovery"). See the
#: note above; ``price_guard`` builds its exclusion phrase from this list.
_NOT_OWN_PLAN_WORDS_ANSWER = tuple(word for word in _NOT_OWN_PLAN_WORDS if word not in {"business", "care", "recovery"})
#: The same for "package" or "packages": "salary package", "relief package", and a
#: placement report's "average annual package".
_NOT_OWN_PACKAGE_WORDS = (
    "salary", "compensation", "pay", "ctc", "relocation", "benefit", "benefits", "severance", "stimulus", "relief",
    "aid", "average", "median",
)  # fmt: skip
#: Phrases whose price or plan word is not a pricing question: a plan or package in
#: another sense, "tier 2 cities", "in charge" and "charge my phone".
_NOT_A_PRICE_PHRASE_RE = re.compile(
    rf"\b(?:{'|'.join(_NOT_OWN_PLAN_WORDS)})\s+(?:[a-z]+\s+)?plans?\b"
    rf"|\b(?:{'|'.join(_NOT_OWN_PACKAGE_WORDS)})\s+(?:[a-z]+\s+)?packages?\b"
    r"|\btiers?[\s-]*(?:[1-3]|i{1,3}|one|two|three)\s+(?:cit(?:y|ies)|towns?)\b"
    r"|\b(?:in|take|takes|took|taking)\s+charge\b"
    r"|\bcharge\s+(?:(?:my|your|the|a|an|his|her|their|our)\s+)?"
    r"(?:phones?|mobiles?|laptops?|batter(?:y|ies)|devices?|cars?|evs?|tablets?|watch(?:es)?|scooters?|vehicles?)\b",
    re.IGNORECASE,
)


def _within_edits(a: str, b: str, limit: int) -> bool:
    """True when ``a`` becomes ``b`` in at most ``limit`` insertions, deletions,
    substitutions or swaps of two adjacent letters."""
    if abs(len(a) - len(b)) > limit:
        return False
    before_previous: list[int] = []
    previous = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        row = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            row[j] = min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] != b[j - 1]))
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                row[j] = min(row[j], before_previous[j - 2] + 1)
        if min(row) > limit:
            return False
        before_previous, previous = previous, row
    return previous[-1] <= limit


def question_has_fuzzy_price_word(question: object) -> bool:
    """True when the visitor's question carries a price or plan word, typos included.

    "what is th picin for SOC" is two edits from "pricing", "hw much" and "qoute
    for 3 sites" are typos, and "what plans do you offer?" asks for plans. The
    gate reads none of them as a pricing question; the price guard still treats a
    figure in the answer as the company's price. A plan or package in another sense
    ("business continuity plan", "salary package"), "tier 2 cities" and "in charge"
    do not count. Pure, and not part of the gate's own decision.
    """
    if not isinstance(question, str) or not question.strip():
        return False
    if _HOW_MUCH_RE.search(question):
        return True
    question = _NOT_A_PRICE_PHRASE_RE.sub(" ", question)
    if _PLAN_QUESTION_RE.search(question):
        return True
    for word in _WORD_RE.findall(question.lower()):
        if word in _EXACT_PRICE_WORDS:
            return True
        if word in _NOT_A_PRICE_TYPO:
            continue
        if len(word) in _SHORT_WORD_LENGTHS and any(_within_edits(word, target, 1) for target in _SHORT_PRICE_WORDS):
            return True
        if len(word) >= _FUZZY_MIN_LEN and any(
            _within_edits(word, target, limit) for target, limit in _FUZZY_PRICE_WORDS
        ):
            return True
        if any(len(word) in lengths and _within_edits(word, target, 1) for target, lengths in _TYPO_PRICE_WORDS):
            return True
    return False


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
    if _has_near_miss_price_word(question):
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
    "owner_optout",
    "not_pricing",
    "answer",
    "escalate_no_url",
    "escalate_no_content",
    "escalate_deferred",
]


@dataclass(frozen=True)
class PricingGateDecision:
    """What the caller should do with this turn.

    ``fired`` is False for the three pass-through outcomes
    (``quote_standdown``, ``no_support_path_standdown``, ``not_pricing``); in
    all three the caller must use ``chunks`` unchanged and continue exactly as
    it does today.

    ``escalate_deferred`` is not fired either: the gate would have escalated, but
    the visitor also asked something besides the price, so the caller keeps
    ``chunks``, generates, and lets the price guard trip on any figure.

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


def no_support_path_standdown(*, support_enabled: bool, pricing_url: object, contact_url: object) -> bool:
    """True when this bot has NOTHING at all to offer on a pricing question.

    ``support_enabled`` is the PLAN half of the human-support gate: does the
    subscription funding this bot include ``live_chat`` at all. On Free it is
    False, which means no live queue and no leave-a-message form, so an
    escalation has no CHANNEL to go to. That alone is not enough to stand the
    gate down, because an escalation does not have to end in a channel: it can
    end in a page. Only when there is no usable ``pricing_url`` to answer from
    AND no usable ``contact_url`` to point at is there genuinely nothing left,
    and only then does the gate stand down so the knowledge base can answer as it
    did before this feature existed.

    ``contact_url`` is the bot's own public contact page, extracted from its
    existing ``contact`` Smart Link by ``rag_service._contact_url_from_answer_links``.
    Handing it over is information rather than a channel, so it does not leak the
    paid in-chat feature (see the module docstring), and it is strictly better
    than letting a stale rate card answer.

    Usability is decided by ``normalize_url`` on BOTH urls, NOT by truthiness, so
    this agrees with ``evaluate_pricing_gate`` (which reaches ``escalate_no_url``
    precisely when ``normalize_url`` rejects the pricing URL) and with
    ``pricing_pivot`` / ``merge_pricing_smart_link`` (which all refuse to hand a
    visitor a value ``normalize_url`` rejected). A truthiness test on
    ``pricing_url`` would leave ``"javascript:alert(1)"`` on a Free bot escalating
    into the dead end this exists to remove; a truthiness test on ``contact_url``
    would do worse, escalating a turn whose pivot then finds nothing usable to
    hand over and falls back to the warm no-link copy, which is that same dead
    end reached by a longer route.

    ``contact_url`` is REQUIRED rather than defaulted, unlike the same argument on
    ``evaluate_pricing_gate``, because the two callers fail in opposite
    directions. A gate call that omits it merely stands down where it could have
    escalated, costing one Free visitor a link. A cache-bypass call that omits it
    reports a standdown for a bot the gate DOES intercept, so the bypass is
    skipped and a pre-gate cached price is served ahead of the gate: the exact
    failure the bypass exists to prevent. Forcing every callsite to pass it is
    what stops that from happening silently.

    Exported so the pipelines can ask the same question the gate asks. Both of
    them bypass their QA answer cache on pricing intent, and on a bot that is
    going to stand down that bypass is pure waste: it buys a full uncached
    pipeline run to protect against an interception that will not happen. Reusing
    one predicate is what stops the bypass condition and the gate's own standdown
    from drifting apart as either side is edited.
    """
    return not support_enabled and normalize_url(pricing_url) is None and normalize_url(contact_url) is None


def evaluate_pricing_gate(
    *,
    question: object,
    quote_active: bool,
    pricing_url: object,
    chunks: list,
    support_enabled: bool = True,
    contact_url: object = None,
    answer_from_knowledge_base: bool = False,
    asks_price: bool | None = None,
    asks_more: bool = False,
) -> PricingGateDecision:
    """Decide how a turn should be handled under the pricing answer gate.

    Every bot is gated on every pricing-intent turn unless its owner says
    otherwise. ``answer_from_knowledge_base`` is that decision
    (``Bot.pricing_from_knowledge_base``, default False), and it is the ONLY
    opt-out: it cannot be defaulted into, and a bot that never touches it is
    gated exactly as it was. It exists because the gate's assumption, that a
    trustworthy price lives on a public pricing page, is false for every
    customer whose price list is an uploaded PDF: those bots escalated every
    pricing question to the team while holding the answer. It is checked after
    ``quote_active`` so an in-flight quotation still wins, and it does NOT
    narrow chunks: the opted-out bot answers from everything it knows, which is
    what the owner asked for.

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
    a plan with no human path AND no usable ``pricing_url`` AND no usable
    ``contact_url`` has nothing whatsoever to offer, so the gate stands down
    rather than dead-ending the visitor (see ``no_support_path_standdown`` and
    the module docstring for the cost that buys). It defaults to True so a caller
    that forgets it gets the fully-gated PAID behaviour, which is the safe
    direction: a missed ``support_enabled=False`` costs one Free visitor a
    knowledge-base answer, whereas a defaulted-False would silently un-gate the
    whole platform.

    ``contact_url`` is the bot's own public contact page (its ``contact`` Smart
    Link), and it matters ONLY inside that same Free combination: it is what
    turns "nothing to escalate to" back into a real escalation. When support is
    off and no pricing page is usable but a contact page is, this returns
    ``escalate_no_url`` with EMPTY chunks, which is the point of routing it
    through the gate rather than appending a link to a knowledge-base answer:
    the answer must be the contact link and nothing else, so no chunk may reach
    the model. On every PAID plan it changes nothing at all, because the branch
    that reads it is behind ``not support_enabled``. It defaults to None, and
    that default is the SAFE direction here for the mirror-image reason
    ``support_enabled`` defaults True: a caller that forgets it stands down where
    it could have escalated, costing one Free visitor a link, rather than
    escalating with nothing to hand over.

    ``asks_price`` is the turn's price decision (``price_intent``): whether the
    visitor asks what this business charges for its own products or services.
    When it is given, the question's wording is not read at all, which is what
    keeps "can i get a quote from your leadership" and "whats the share price"
    from being escalated (production, 2026-09-11). None keeps the wording rule
    (``is_pricing_question``) for a caller that has no decision.

    ``asks_more`` says the visitor also asked something besides the price. An
    escalation replaces the whole answer, so it would drop that part of the turn;
    the escalation is deferred instead (``escalate_deferred``, chunks untouched)
    and generation answers the turn with the price guard watching every figure.
    An ``answer`` still narrows to the pricing page, and every standdown still
    wins.

    ``chunks`` is the finalized retrieval result (fused, trimmed, reranked): a
    list of anything exposing ``document_name`` and ``content``.
    """
    if quote_active:
        return PricingGateDecision(fired=False, outcome="quote_standdown", chunks=chunks)
    asks = is_pricing_question(question) if asks_price is None else asks_price
    if answer_from_knowledge_base and asks:
        return PricingGateDecision(fired=False, outcome="owner_optout", chunks=chunks)
    if not asks:
        return PricingGateDecision(fired=False, outcome="not_pricing", chunks=chunks)

    # Checked AFTER intent, not before, so a non-pricing turn on a Free bot
    # still reports ``not_pricing``: the two say very different things about
    # what happened, and the standdown count is only meaningful if it counts
    # turns the gate would otherwise have intercepted.
    if no_support_path_standdown(support_enabled=support_enabled, pricing_url=pricing_url, contact_url=contact_url):
        return PricingGateDecision(fired=False, outcome="no_support_path_standdown", chunks=chunks)

    target = normalize_url(pricing_url)
    if target is None:
        # No pricing page named, or one this module cannot use. There is no
        # source we are allowed to price from, so do not try: an unconfigured
        # bot routes its pricing questions to the team rather than letting the
        # general knowledge base answer them.
        #
        # Two different bots reach this line and ``pricing_pivot`` tells them
        # apart on the same ``support_enabled`` flag passed here: a PAID bot,
        # which is handed to its team, and a FREE bot that maps a usable contact
        # page, which is handed that page. A Free bot with no contact page never
        # gets here at all, because the standdown above took the other branch.
        # Chunks are emptied for both, so the contact link is the entire reply
        # rather than a link appended to a stale knowledge-base price.
        escalation: GateOutcome = "escalate_no_url"
    else:
        kept = [c for c in chunks if normalize_url(getattr(c, "document_name", None)) == target]
        if kept and any(has_price_signal(getattr(c, "content", None)) for c in kept):
            return PricingGateDecision(fired=True, outcome="answer", chunks=kept)
        # Either the page never made it into the knowledge base, or it did and
        # says nothing about money. Both mean the same thing to the visitor.
        escalation = "escalate_no_content"

    if asks_more:
        # The visitor asked something besides the price. The canned escalation
        # would be the whole reply and leave that unanswered, so generation
        # answers the turn from every chunk and the price guard, applied to this
        # outcome and told the turn asks the price, trips on any figure.
        return PricingGateDecision(fired=False, outcome="escalate_deferred", chunks=chunks)
    return PricingGateDecision(fired=True, outcome=escalation, chunks=[])


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
    contact_url: str | None = None,
    repeat: bool = False,
    subject: str | None = None,
) -> PricingPivot:
    """The reply for a pricing question the gate refuses to answer from the KB.

    ``repeat`` is True when this session has already been given a pricing
    escalation. Every branch used to return one fixed sentence, so a visitor who
    asked twice got the same words twice and, on a paid plan, the "Talk to a
    human" form a second time: reported from a live bot on 2026-09-10, where one
    session received the identical escalation four minutes apart. It read as a
    bot stuck in a loop.

    A repeat gets different words that acknowledge the answer has not changed,
    and it does NOT re-open the form or the message card, because the visitor
    has already been offered one. The paid repeats keep an offer the pipeline's
    ``bot_offers_handoff`` recognises, so a plain "yes" still routes straight into
    the handoff. The first-time copy is unchanged.

    ``support_enabled`` is the PLAN half of the human-support gate (does this
    bot's plan include ``live_chat`` at all). On Free it is False, meaning there
    is neither a live queue nor a leave-a-message form, so the copy must not
    name the team, promise a callback, or ask for a card. It hands over a page
    instead, and only stays a warm bot-only pivot when there is no page at all.

    ``live_chat_enabled`` is the EFFECTIVE real-time value and only chooses
    between the live handoff and the async message card on a paid plan.

    ``contact_url`` is the bot's own public contact page (its ``contact`` Smart
    Link) and is read ONLY on the Free branch, as the fallback when no usable
    ``pricing_url`` exists. The order inside that branch is deliberate: the
    pricing page wins whenever it is usable, because the owner named it as the
    place that states prices and a contact form is a worse answer than the page
    that answers; the contact page is what remains when there is no priceable
    source at all. Both stay ``suggest_handoff=False`` and
    ``needs_message_card=False``: Free has no in-chat channel, and this must
    remain a plain pointer to a public page rather than a promise of follow-up
    the plan cannot keep. See the module docstring for why that is information
    rather than a leak of the paid channel.

    NOTE on the Free-with-no-page-at-all branch below: ``evaluate_pricing_gate``
    stands down for exactly that combination and never escalates it, so the
    pipelines cannot reach that copy. It is kept, and kept tested, on purpose.
    This is a pure function with its own callers-in-waiting and its own test
    suite, its branches are the complete truth table of its flags, and deleting
    one to chase coverage would silently turn a future miswiring into an
    ``UnboundLocalError`` instead of a warm bot-only reply. The gate is the thing
    that decides this combination never arrives; the pivot's job is to be correct
    if it does.

    ``subject`` is the configured service the visitor asked the price OF, as
    ``pricing_subject`` found it ("SOC as a Service", "Red Teaming"), or None.
    With it the reply prices that service at the company ("Pricing for **Red
    Teaming** at **Acme**") instead of the whole company. Without it every branch
    is byte-identical to the wording before the argument existed. It is
    re-validated here, like both URLs, because it is rendered to the visitor and
    persisted: anything that is not a short run of letters, digits, spaces and
    ``& + . ' / -`` is dropped rather than trusted from the caller.
    """
    cn = f"**{company_name}**" if company_name else "us"
    subject_text = subject.strip() if isinstance(subject, str) else ""
    if not _SAFE_SUBJECT_RE.fullmatch(subject_text):
        subject_text = ""
    if subject_text:
        # What is being priced, and the preposition the "figure" sentences need
        # in front of it. Without a subject both collapse to the old wording.
        priced = f"**{subject_text}** at {cn}" if company_name else f"**{subject_text}**"
        figure_of = f"for {priced}"
    else:
        priced = cn
        figure_of = f"from {cn}"

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
    # Re-validated here for the same reason and with the same rule, rather than
    # trusted from the caller. ``_contact_url_from_answer_links`` already filters
    # on ``normalize_url``, but this text goes straight to a visitor and into
    # ``chat_messages.content``, so a future caller reading the URL from
    # somewhere else must still not be able to render "You can get in touch here:
    # javascript:alert(1)". An unusable value is treated as no contact page at
    # all, which falls through to the warm no-link copy.
    usable_contact_url = contact_url.strip() if isinstance(contact_url, str) and normalize_url(contact_url) else None

    if not support_enabled:
        if repeat:
            # Free has no in-chat channel on either ask, so the repeat carries
            # the same pointer in new words, and still names no team and
            # promises no follow-up.
            if usable_url:
                return PricingPivot(
                    text=f"The pricing page is still the most reliable place for a figure {figure_of}: {usable_url}",
                    suggest_handoff=False,
                    needs_message_card=False,
                )
            if usable_contact_url:
                return PricingPivot(
                    text=f"For a confirmed figure {figure_of}, the contact page is still the way in: {usable_contact_url}",
                    suggest_handoff=False,
                    needs_message_card=False,
                )
            return PricingPivot(
                text=f"I still can't confirm pricing for {priced}, sorry. Is there anything else about {cn} I can help with?",
                suggest_handoff=False,
                needs_message_card=False,
            )
        if usable_url:
            return PricingPivot(
                text=(
                    f"I'd rather not quote a figure I can't confirm for {priced}. The current pricing is here: {usable_url}"
                ),
                suggest_handoff=False,
                needs_message_card=False,
            )
        if usable_contact_url:
            # No page that states prices, but a page that reaches a human who
            # knows them. Phrasing matches ``rag_service._no_info_pivot``'s Free
            # branch word for word after the first sentence, so the bot has one
            # voice for one action ("here is where to go"), and it deliberately
            # promises nothing beyond the link: on Free there is no queue to join
            # and no form to open, so any wording that implied a reply was coming
            # would be a promise the plan cannot keep.
            return PricingPivot(
                text=f"I don't have pricing I can confirm for {priced}. You can get in touch here: {usable_contact_url}",
                suggest_handoff=False,
                needs_message_card=False,
            )
        return PricingPivot(
            text=(
                f"I don't have pricing I can confirm for {priced}. Is there something else about {cn} I can help you with?"
            ),
            suggest_handoff=False,
            needs_message_card=False,
        )

    if repeat:
        # The form was already offered this session. Showing it again is half of
        # what made the repeat read as a loop, so it is not re-opened; the offer
        # stays in the words instead, phrased so a bare "yes" is still read as a
        # handoff request by ``rag_service._last_bot_offered_handoff``.
        if live_chat_enabled:
            return PricingPivot(
                text=(
                    f"That one still sits with the team, since a figure for {priced} depends on your scope. "
                    f"Just say yes and I'll connect you with them."
                ),
                suggest_handoff=False,
                needs_message_card=False,
            )
        return PricingPivot(
            text=(
                f"That one still sits with the team, since a figure for {priced} depends on your scope. "
                f"Say yes and you can leave a message for them."
            ),
            suggest_handoff=False,
            needs_message_card=False,
        )

    if live_chat_enabled:
        return PricingPivot(
            text=(
                f"Pricing for {priced} is best confirmed by the team so you get an "
                f"accurate figure. Want me to connect you with them now?"
            ),
            suggest_handoff=True,
            needs_message_card=False,
        )

    return PricingPivot(
        text=(
            f"Pricing for {priced} is best confirmed by the team so you get an "
            f"accurate figure. I'll open a quick message form so they can get back to you."
        ),
        suggest_handoff=False,
        needs_message_card=True,
    )


# ── What the visitor asked the price OF ────────────────────────────────────────
#
# Every escalation used to price the whole company. On 2026-09-10 a live bot had
# answered "pricing of red teaming", "pricing for managed soc" and "soc pricng"
# with "Pricing for Eventus Security is best confirmed by the team" for two
# weeks: the visitor named a service and the reply named something else.
#
# The first fix recovered the service from capitalised phrases in the retrieved
# knowledge base, and on 2026-09-11 production replied "Pricing for **Story**",
# "Pricing for **INDIA**", "Pricing for **Data**" and "Pricing for **Per-User**":
# any capitalised word in the content could fill the slot. The slot now takes
# only a service the owner configured, and only when the visitor names it.

#: How many services each list contributes: the cap the prompt's SERVICES section reads.
_MAX_CONFIGURED_SERVICES = 50
#: A configured name of more words than this is a description, and is never rendered.
_SUBJECT_MAX_WORDS = 8
#: How many words of the visitor's message are searched for a service name.
_SUBJECT_MAX_QUESTION_WORDS = 400
_SUBJECT_WORD_RE = re.compile(r"[a-z0-9]+")
#: What ``pricing_pivot`` will render: a short run of letters, digits, spaces and
#: ``& + . ' / -`` ("Brand Identity & Storytelling", "C++ Training"), and never a
#: character markdown reads or a line break. Anything else is dropped there,
#: whoever computed it.
_SAFE_SUBJECT_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9 &+.'/\-]{0,58}[A-Za-z0-9+.])?")


def configured_service_names(services: object, quotation_catalog: object) -> list[str]:
    """The service names the bot owner configured, in order, without duplicates.

    ``services`` is ``Bot.services``: a list of names or of ``{"name", "url"}``
    objects, both shapes live (the prompt's SERVICES section reads both).
    ``quotation_catalog`` is ``Bot.quotation_catalog``, whose ``services`` are
    objects with a ``name``; a disabled catalog still names the owner's services.
    Anything else in either value is skipped. Names compare case-insensitively
    and the first spelling is kept.
    """
    candidates: list[object] = []
    if isinstance(services, list):
        candidates.extend(
            item.get("name") if isinstance(item, dict) else item for item in services[:_MAX_CONFIGURED_SERVICES]
        )
    catalog_services = quotation_catalog.get("services") if isinstance(quotation_catalog, dict) else None
    if isinstance(catalog_services, list):
        candidates.extend(
            item.get("name") for item in catalog_services[:_MAX_CONFIGURED_SERVICES] if isinstance(item, dict)
        )
    names: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, str):
            continue
        name = " ".join(candidate.split())
        if name and name.casefold() not in seen:
            seen.add(name.casefold())
            names.append(name)
    return names


def _run_in(words: list[str], target: list[str], *, plural: bool) -> bool:
    """Whether ``target`` appears in ``words`` as one run; with ``plural``, its last word may carry "s" or "es"."""
    size = len(target)
    head, last = target[:-1], target[-1]
    endings = {last, f"{last}s", f"{last}es"} if plural else {last}
    return any(words[i : i + size - 1] == head and words[i + size - 1] in endings for i in range(len(words) - size + 1))


def pricing_subject(question: object, company_name: object, service_names: object) -> str | None:
    """The configured service the visitor's message names, spelled as the owner spelled it, or None.

    ``service_names`` is ``configured_service_names``. A service counts only when
    every word of its name appears in the message as one run, in order: "pricing
    for managed soc" names "Managed SOC", and "soc pricing" does not name "SOC as
    a Service". Case and punctuation do not matter ("Red-Teaming"), and the last
    word may be plural ("landing pages"). The longest name wins, then the first
    configured.

    Never a name inside the company's own name, and never a name
    ``pricing_pivot`` would not render. Nothing the visitor typed is returned:
    only the owner's spelling of a service the owner configured. English-only,
    like the detector.
    """
    if not isinstance(question, str) or not isinstance(service_names, (list, tuple)):
        return None
    words = _SUBJECT_WORD_RE.findall(question.lower())[:_SUBJECT_MAX_QUESTION_WORDS]
    if not words:
        return None
    company = _SUBJECT_WORD_RE.findall(company_name.lower()) if isinstance(company_name, str) else []
    best_size, best = 0, None
    for candidate in service_names:
        if not isinstance(candidate, str):
            continue
        name = candidate.strip()
        if not _SAFE_SUBJECT_RE.fullmatch(name):
            continue
        target = _SUBJECT_WORD_RE.findall(name.lower())
        if not target or len(target) > _SUBJECT_MAX_WORDS or len(target) <= best_size:
            continue
        if company and _run_in(company, target, plural=False):
            continue
        if _run_in(words, target, plural=True):
            best_size, best = len(target), name
    return best


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
