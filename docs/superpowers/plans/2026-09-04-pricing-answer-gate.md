# Pricing Answer Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a visitor asks about pricing, a bot with the gate enabled answers ONLY from the admin-configured pricing page, and otherwise routes the visitor to the support team (or, on the Free plan, gives a graceful bot-only pivot instead of promising a channel that does not exist).

**Architecture:** A new pure module `app/services/pricing_gate.py` holds URL normalization, pricing-intent detection, price-signal detection, the gate decision, and the pivot copy. Both RAG pipelines call it once, immediately after retrieval is finalized and before the CRAG relevance gate, and either narrow `final_results` to the pricing page's chunks or take a canned early return. Two new `Bot` columns (`pricing_url`, `pricing_gate_enabled`) drive it; the gate is OFF by default so no existing bot changes behavior.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy, Alembic, pytest, ruff. Admin UI: React 19 + TypeScript, Vitest.

---

## Design decisions (already made, do not relitigate)

1. **New dedicated fields, not the Smart Links (`answer_links`) field.** Smart Links are cosmetic keyword hyperlinks and are documented as never restricting what the bot may answer ([models.py:569](../../../api/app/db/models.py)). Reusing them would silently turn a cosmetic setting into an answering restriction for every existing customer.
2. **OFF by default.** `pricing_gate_enabled` defaults `false`. A bot whose pricing legitimately lives in an uploaded PDF must keep working untouched.
3. **Free plan gets a graceful bot-only pivot.** On Free, `plan_entitlements_service.is_live_chat_enabled_for_bot` returns False, there is no live queue and no leave-a-message form. The pivot must never say "connect you with the team". This mirrors the existing `_no_info_pivot(support_enabled=False)` contract.
4. **Post-retrieval filter, not a SQL change.** Scoping happens by filtering the fused/reranked `Document` list on `document_name`. Retrieval SQL is the hottest path in the system and is left alone.
5. **Fail open.** If pricing intent is not detected (including any non-Latin-script question, because the detector is English-only), the turn behaves exactly as today. This is the safe failure direction and is a KNOWN LIMITATION recorded in Task 12.

---

## File Structure

**Create**
- `platform/api/app/services/pricing_gate.py` — the whole gate: normalization, detection, decision, pivot copy. Pure functions, no DB, no I/O, no imports from `rag_service` (avoids a circular import).
- `platform/api/alembic/versions/b1000003pricing_answer_gate.py` — two nullable/defaulted columns.
- `platform/api/tests/test_pricing_gate.py` — unit tests for the pure module.
- `platform/api/tests/test_pricing_gate_pipeline.py` — drives the real `rag_pipeline_stream` against throwaway Postgres.

**Modify**
- `platform/api/app/db/models.py` — two columns on `Bot`.
- `platform/api/app/api/bot_routes.py` — create/update request schemas, response schema, response builder, public widget config.
- `platform/api/app/api/auth.py` — bot cache payload so a cached bot load still carries the new fields.
- `platform/api/app/services/rag_service.py` — call the gate in both pipelines; merge the pricing URL into smart links at both `build_hybrid_prompt` callsites.
- `platform/app/src/features/agents/experience/experience-model.ts` — draft field, section map, parse, normalize, staleness list, patch, validation.
- `platform/app/src/features/agents/experience/VoiceSection.tsx` — the admin card.
- `platform/app/src/features/agents/experience/experience-model.test.ts` — parse/patch coverage.

---

## Task 1: URL normalization

**Files:**
- Create: `platform/api/app/services/pricing_gate.py`
- Create: `platform/api/tests/test_pricing_gate.py`

- [ ] **Step 1: Write the failing test**

Create `platform/api/tests/test_pricing_gate.py`:

```python
"""The pricing answer gate: pure decision logic, no DB and no I/O.

The gate exists because a pricing question answered from a stale uploaded rate
card is worse than no answer at all. When an admin turns it on and names the
pricing page, that page is the ONLY source the bot may quote a price from.
"""

from app.services.pricing_gate import normalize_url


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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.pricing_gate'`

- [ ] **Step 3: Write the minimal implementation**

Create `platform/api/app/services/pricing_gate.py`:

```python
"""Pricing answer gate.

When a bot's admin turns this on and names a pricing page, a visitor's pricing
question is answered ONLY from that page's chunks. If the page is not in the
knowledge base, or is there but carries no actual price content, the bot does
NOT fall back to the rest of the knowledge base — it routes the visitor to the
team instead. A stale price quoted confidently from an old uploaded rate card
is a worse outcome than "let me get you to someone who can confirm".

Pure module by design: no DB, no I/O, and no import from ``rag_service`` (which
imports this one). Everything here is a decision the callers act on.
"""

from __future__ import annotations

import re
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
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https"):
        return None
    try:
        host = (parsed.hostname or "").lower()
    except ValueError:
        # urlsplit defers IPv6/port parse errors to ``.hostname``.
        return None
    if not host:
        return None
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path.rstrip("/")
    return f"{host}{path}" if path else f"{host}/"
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py -v
```

Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/services/pricing_gate.py api/tests/test_pricing_gate.py && git commit -m "feat(pricing-gate): add URL normalization for pricing page matching"
```

---

## Task 2: Pricing-intent detection

**Files:**
- Modify: `platform/api/app/services/pricing_gate.py`
- Modify: `platform/api/tests/test_pricing_gate.py`

- [ ] **Step 1: Write the failing test**

Append to `platform/api/tests/test_pricing_gate.py`:

```python
import pytest

from app.services.pricing_gate import is_pricing_question


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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py -k pricing_question -v
```

Expected: FAIL with `ImportError: cannot import name 'is_pricing_question'`

- [ ] **Step 3: Write the minimal implementation**

Append to `platform/api/app/services/pricing_gate.py`:

```python
# A visitor asking us what we charge. Deliberately NARROW: a false positive
# escalates a question the knowledge base could have answered, which is a
# visible regression, while a false negative just leaves today's behaviour in
# place. Currency-symbol-followed-by-a-digit is included because it survives
# translation; everything else here is English-only (see the module note on
# failing open for non-Latin scripts).
_PRICE_TOKENS_RE = re.compile(
    r"(?:[₹$€£¥]\s*\d"
    r"|\bpricing\b|\bprices?\b|\bpriced\b"
    r"|\bcosts?\b|\bcosting\b"
    r"|\bfees?\b|\bcharges?\b"
    r"|\bquotation\b|\bquotes?\b"
    r"|\brate\s*card\b|\bprice\s*list\b"
    r"|\bhow\s+much\b)",
    re.IGNORECASE,
)

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

    Order matters: idioms are excluded before tokens are matched, because every
    idiom below contains a token that would otherwise fire the gate.
    """
    if not isinstance(question, str) or not question.strip():
        return False
    if _PRICE_IDIOM_RE.search(question):
        return False
    return bool(_PRICE_TOKENS_RE.search(question))
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py -v
```

Expected: all passed

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/services/pricing_gate.py api/tests/test_pricing_gate.py && git commit -m "feat(pricing-gate): add narrow English pricing-intent detection"
```

---

## Task 3: Price-signal detection in a chunk

**Files:**
- Modify: `platform/api/app/services/pricing_gate.py`
- Modify: `platform/api/tests/test_pricing_gate.py`

Branch 2 of the spec ("the linked page exists but pricing is not mentioned on it") needs a cheap answer to "does this text actually carry a price?". This is a heuristic, not a classifier: it costs nothing and it only ever decides between "answer from this page" and "route to the team".

- [ ] **Step 1: Write the failing test**

Append to `platform/api/tests/test_pricing_gate.py`:

```python
from app.services.pricing_gate import has_price_signal


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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py -k price_signal -v
```

Expected: FAIL with `ImportError: cannot import name 'has_price_signal'`

- [ ] **Step 3: Write the minimal implementation**

Append to `platform/api/app/services/pricing_gate.py`:

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py -v
```

Expected: all passed

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/services/pricing_gate.py api/tests/test_pricing_gate.py && git commit -m "feat(pricing-gate): detect whether a chunk carries real price content"
```

---

## Task 4: The gate decision

**Files:**
- Modify: `platform/api/app/services/pricing_gate.py`
- Modify: `platform/api/tests/test_pricing_gate.py`

- [ ] **Step 1: Write the failing test**

Append to `platform/api/tests/test_pricing_gate.py`:

```python
from types import SimpleNamespace

from app.services.pricing_gate import evaluate_pricing_gate


def _chunk(document_name: str, content: str) -> SimpleNamespace:
    """A stand-in for a ``Document`` row: the gate only reads these two fields."""
    return SimpleNamespace(document_name=document_name, content=content)


_PRICED = _chunk("https://www.acme.com/pricing/", "Starter is ₹4,999 per month")
_UNPRICED = _chunk("https://acme.com/pricing", "We believe in transparent partnerships.")
_OTHER = _chunk("rate-card-2024.pdf", "Legacy retainer: ₹80,000 per month")


def test_gate_off_returns_chunks_untouched():
    decision = evaluate_pricing_gate(
        question="what is your pricing?",
        gate_enabled=False,
        pricing_url="https://acme.com/pricing",
        chunks=[_PRICED, _OTHER],
    )
    assert decision.fired is False
    assert decision.outcome == "off"
    assert decision.chunks == [_PRICED, _OTHER]


def test_non_pricing_question_returns_chunks_untouched():
    decision = evaluate_pricing_gate(
        question="who is the founder?",
        gate_enabled=True,
        pricing_url="https://acme.com/pricing",
        chunks=[_PRICED, _OTHER],
    )
    assert decision.fired is False
    assert decision.outcome == "not_pricing"
    assert decision.chunks == [_PRICED, _OTHER]


def test_no_pricing_url_configured_escalates():
    decision = evaluate_pricing_gate(
        question="how much does it cost?",
        gate_enabled=True,
        pricing_url=None,
        chunks=[_OTHER],
    )
    assert decision.fired is True
    assert decision.outcome == "escalate_no_url"
    assert decision.chunks == []


def test_priced_page_narrows_chunks_to_that_page_only():
    decision = evaluate_pricing_gate(
        question="how much does it cost?",
        gate_enabled=True,
        pricing_url="http://acme.com/pricing",
        chunks=[_OTHER, _PRICED],
    )
    assert decision.fired is True
    assert decision.outcome == "answer"
    assert decision.chunks == [_PRICED]


def test_page_present_but_carries_no_price_escalates():
    decision = evaluate_pricing_gate(
        question="how much does it cost?",
        gate_enabled=True,
        pricing_url="https://acme.com/pricing",
        chunks=[_UNPRICED, _OTHER],
    )
    assert decision.fired is True
    assert decision.outcome == "escalate_no_content"
    assert decision.chunks == []


def test_page_absent_from_retrieval_escalates_and_never_uses_other_sources():
    decision = evaluate_pricing_gate(
        question="how much does it cost?",
        gate_enabled=True,
        pricing_url="https://acme.com/pricing",
        chunks=[_OTHER],
    )
    assert decision.fired is True
    assert decision.outcome == "escalate_no_content"
    assert decision.chunks == []
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py -k gate -v
```

Expected: FAIL with `ImportError: cannot import name 'evaluate_pricing_gate'`

- [ ] **Step 3: Write the minimal implementation**

Append to `platform/api/app/services/pricing_gate.py` (add `from dataclasses import dataclass` and `from typing import Literal` to the imports at the top of the file):

```python
GateOutcome = Literal["off", "not_pricing", "answer", "escalate_no_url", "escalate_no_content"]


@dataclass(frozen=True)
class PricingGateDecision:
    """What the caller should do with this turn.

    ``fired`` is False for the two pass-through outcomes (``off``,
    ``not_pricing``); in both the caller must use ``chunks`` unchanged and
    continue exactly as it does today.

    When ``fired`` is True the caller either narrows retrieval to ``chunks``
    (``answer``) or takes a canned early return (both ``escalate_*`` outcomes,
    where ``chunks`` is always empty so no other source can leak into the reply).
    """

    fired: bool
    outcome: GateOutcome
    chunks: list


def evaluate_pricing_gate(
    *,
    question: object,
    gate_enabled: bool,
    pricing_url: object,
    chunks: list,
) -> PricingGateDecision:
    """Decide how a turn should be handled under the pricing answer gate.

    ``chunks`` is the finalized retrieval result (fused, trimmed, reranked): a
    list of anything exposing ``document_name`` and ``content``.
    """
    if not gate_enabled:
        return PricingGateDecision(fired=False, outcome="off", chunks=chunks)
    if not is_pricing_question(question):
        return PricingGateDecision(fired=False, outcome="not_pricing", chunks=chunks)

    target = normalize_url(pricing_url)
    if target is None:
        # The admin enabled the gate but named no page (or named an unusable
        # one). There is no source we are allowed to price from, so do not try.
        return PricingGateDecision(fired=True, outcome="escalate_no_url", chunks=[])

    kept = [c for c in chunks if normalize_url(getattr(c, "document_name", None)) == target]
    if not kept or not any(has_price_signal(getattr(c, "content", None)) for c in kept):
        # Either the page never made it into the knowledge base, or it did and
        # says nothing about money. Both mean the same thing to the visitor.
        return PricingGateDecision(fired=True, outcome="escalate_no_content", chunks=[])

    return PricingGateDecision(fired=True, outcome="answer", chunks=kept)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py -v
```

Expected: all passed

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/services/pricing_gate.py api/tests/test_pricing_gate.py && git commit -m "feat(pricing-gate): add the gate decision over finalized retrieval"
```

---

## Task 5: The pivot copy, including the Free-plan branch

**Files:**
- Modify: `platform/api/app/services/pricing_gate.py`
- Modify: `platform/api/tests/test_pricing_gate.py`

The pivot must respect the same human-support gate every other canned early return in `rag_service` respects. On Free, `support_enabled` is False and there is NO live queue and NO message form, so the copy must not name the team at all.

The function returns a struct rather than pre-formatted text with a card token, because `LEAVE_MESSAGE_CARD_SENTINEL` lives in `rag_service` and importing it here would be circular. The caller appends it.

- [ ] **Step 1: Write the failing test**

Append to `platform/api/tests/test_pricing_gate.py`:

```python
from app.services.pricing_gate import pricing_pivot


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


def test_pivot_on_free_plan_without_a_url_stays_warm_and_bot_only():
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py -k pivot -v
```

Expected: FAIL with `ImportError: cannot import name 'pricing_pivot'`

- [ ] **Step 3: Write the minimal implementation**

Append to `platform/api/app/services/pricing_gate.py`:

```python
@dataclass(frozen=True)
class PricingPivot:
    """The canned reply for an escalating pricing turn.

    ``text`` carries no card token. ``needs_message_card`` tells the caller to
    append its own ``LEAVE_MESSAGE_CARD_SENTINEL`` on its own line, which keeps
    the sentinel defined in exactly one place (``rag_service``) and keeps this
    module free of a circular import.
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
    """
    cn = f"**{company_name}**" if company_name else "us"

    if not support_enabled:
        if pricing_url:
            return PricingPivot(
                text=(
                    f"I'd rather not quote a figure I can't confirm for {cn}. "
                    f"The current pricing is here: {pricing_url}"
                ),
                suggest_handoff=False,
                needs_message_card=False,
            )
        return PricingPivot(
            text=(
                f"I don't have pricing I can confirm for {cn}. "
                f"Is there something else about {cn} I can help you with?"
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py -v && uv run ruff check app/services/pricing_gate.py tests/test_pricing_gate.py && uv run ruff format app/services/pricing_gate.py tests/test_pricing_gate.py
```

Expected: all passed, ruff clean

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/services/pricing_gate.py api/tests/test_pricing_gate.py && git commit -m "feat(pricing-gate): add pivot copy with a Free-plan bot-only branch"
```

---

## Task 6: Database columns and migration

**Files:**
- Modify: `platform/api/app/db/models.py` (in `class Bot`, immediately after `answer_links = Column(JSONB, nullable=True)`)
- Create: `platform/api/alembic/versions/b1000003pricing_answer_gate.py`

- [ ] **Step 1: Add the columns to the model**

In `platform/api/app/db/models.py`, find this line inside `class Bot`:

```python
    answer_links = Column(JSONB, nullable=True)
```

Insert directly after it:

```python
    # Pricing answer gate. When ``pricing_gate_enabled`` is true a visitor's
    # pricing question is answered ONLY from ``pricing_url``'s chunks; if that
    # page is missing from the knowledge base or carries no price content the
    # bot routes to the team instead of falling back to the rest of the KB
    # (see ``app/services/pricing_gate.py``). Deliberately separate from
    # ``answer_links`` above: smart links are cosmetic and must keep their
    # documented "never restrict what the bot may answer" contract, so turning
    # one into an answering restriction would silently change every existing
    # bot. Defaults OFF, so a bot whose pricing lives in an uploaded rate card
    # is untouched until its owner opts in.
    pricing_url = Column(String, nullable=True)
    pricing_gate_enabled = Column(Boolean, nullable=False, default=False, server_default="false")
```

- [ ] **Step 2: Write the migration**

Create `platform/api/alembic/versions/b1000003pricing_answer_gate.py`:

```python
"""Pricing answer gate: pin a bot's pricing answers to one page.

A visitor asking "how much does it cost" was answered from whichever chunk won
retrieval, which on a bot with an old uploaded rate card meant a confidently
quoted stale price. These two columns let an owner name the one page the bot may
price from, and opt in to that restriction.

``bots.pricing_url``
    The page a pricing answer must come from. Compared against
    ``documents.document_name`` after normalization (scheme, ``www.``, trailing
    slash, query and fragment are all dropped), so the URL an admin pastes and
    the URL the crawler stored compare equal.

``bots.pricing_gate_enabled``
    The opt-in. NOT NULL DEFAULT false, so every existing bot keeps today's
    behaviour and nothing changes until an owner turns it on.

No index: both columns are read one row at a time, off a ``bots`` row already
loaded by primary key on every chat turn.

Revision ID: b1000003pricing
Revises: b1000002webhook
Create Date: 2026-09-04

"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000003pricing"
down_revision: str | None = "b1000002webhook"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("pricing_url", sa.String(), nullable=True))
    op.add_column(
        "bots",
        sa.Column(
            "pricing_gate_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("bots", "pricing_gate_enabled")
    op.drop_column("bots", "pricing_url")
```

- [ ] **Step 3: Run the migration**

```bash
cd platform/api && uv run alembic upgrade head
```

Expected: `Running upgrade b1000002webhook -> b1000003pricing`

- [ ] **Step 4: Verify the schema and the round trip**

```bash
cd platform/api && uv run alembic downgrade -1 && uv run alembic upgrade head
```

Expected: downgrade then upgrade both succeed with no error.

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/db/models.py api/alembic/versions/b1000003pricing_answer_gate.py && git commit -m "feat(pricing-gate): add bots.pricing_url and bots.pricing_gate_enabled"
```

---

## Task 7: API schemas and the response builder

**Files:**
- Modify: `platform/api/app/api/bot_routes.py`
- Create: `platform/api/tests/test_pricing_gate_routes.py`

- [ ] **Step 1: Write the failing test**

Create `platform/api/tests/test_pricing_gate_routes.py`:

```python
"""The pricing-gate fields on the bot create/update/read contract.

The gate is an answering restriction, so an unusable URL must be a visible 422
at write time rather than a bot that silently escalates every pricing question.
"""

import pytest
from pydantic import ValidationError

from app.api.bot_routes import BotResponse, UpdateBotRequest


def test_update_accepts_a_valid_pricing_url():
    req = UpdateBotRequest(pricing_url="https://acme.com/pricing", pricing_gate_enabled=True)
    assert req.pricing_url == "https://acme.com/pricing"
    assert req.pricing_gate_enabled is True


def test_update_rejects_a_non_http_pricing_url():
    with pytest.raises(ValidationError):
        UpdateBotRequest(pricing_url="javascript:alert(1)")


def test_update_accepts_an_empty_string_to_clear_the_url():
    assert UpdateBotRequest(pricing_url="").pricing_url == ""


def test_response_defaults_the_gate_off():
    fields = BotResponse.model_fields
    assert fields["pricing_gate_enabled"].default is False
    assert fields["pricing_url"].default is None
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate_routes.py -v
```

Expected: FAIL — `UpdateBotRequest` has no `pricing_url` field (pydantic `extra="forbid"` raises, or the attribute is missing)

- [ ] **Step 3: Write the implementation**

3a. In `platform/api/app/api/bot_routes.py`, find the `answer_links` field in `CreateBotRequest` (around line 775):

```python
    answer_links: Annotated[list[AnswerLink], bounded_list(_MAX_ANSWER_LINKS)] | None = None
```

Insert directly after it:

```python
    # Pricing answer gate. The URL is validated as a real http(s) link because
    # an unusable value here does not degrade gracefully, it makes the bot
    # escalate every pricing question. Empty string clears it.
    pricing_url: Annotated[str, AfterValidator(_validate_optional_http_url)] | None = Field(
        None, max_length=MAX_URL
    )
    pricing_gate_enabled: bool | None = None
```

Apply the identical two lines to `UpdateBotRequest` (it declares its own copy of the same fields; find its `answer_links` line and insert after it the same way).

3b. In `BotResponse` (around line 931), find:

```python
    answer_links: list[dict] | None = None
```

Insert directly after it:

```python
    pricing_url: str | None = None
    pricing_gate_enabled: bool = False
```

3c. In the response builder (around line 1073), find:

```python
        answer_links=_normalize_answer_links(bot.answer_links),
```

Insert directly after it:

```python
        pricing_url=bot.pricing_url,
        pricing_gate_enabled=bool(bot.pricing_gate_enabled),
```

3d. `_validate_optional_http_url` is referenced by 3a and does not exist yet. Add it next to `_normalize_answer_links` (around line 398):

```python
def _validate_optional_http_url(value: str) -> str:
    """An http(s) URL, or the empty string that clears the setting.

    ``HttpUrlStr`` alone rejects "", which is the only way the admin UI can
    unset a URL field, so the gate's URL gets this thin wrapper instead.
    """
    if value == "":
        return value
    return _validate_http_url(value)
```

Add `AfterValidator` to the `pydantic` import line at the top of the file, and add `_validate_http_url` to the existing `from app.schemas.validators import ...` line.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate_routes.py tests/test_bot_routes.py -v
```

Expected: all passed

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/api/bot_routes.py api/tests/test_pricing_gate_routes.py && git commit -m "feat(pricing-gate): expose pricing_url and pricing_gate_enabled on the bot API"
```

---

## Task 8: Carry the fields through the bot cache

**Files:**
- Modify: `platform/api/app/api/auth.py` (around line 1066)

The chat path loads the bot through a cache. Without this the gate reads `None` on every cache hit and silently never fires.

- [ ] **Step 1: Write the failing test**

Append to `platform/api/tests/test_pricing_gate_routes.py`:

```python
def test_bot_cache_payload_carries_the_pricing_gate_fields():
    """A cached bot load must still know about the gate, or it never fires."""
    import inspect

    from app.api import auth

    source = inspect.getsource(auth)
    assert '"pricing_url"' in source
    assert '"pricing_gate_enabled"' in source
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate_routes.py -k cache_payload -v
```

Expected: FAIL on the first assert

- [ ] **Step 3: Write the implementation**

In `platform/api/app/api/auth.py`, find (around line 1066):

```python
        "answer_links": getattr(bot, "answer_links", None),
```

Insert directly after it:

```python
        # Pricing answer gate. Cached with the rest of the answering config: a
        # cache hit that dropped these would leave the gate permanently off for
        # every bot that has it turned on.
        "pricing_url": getattr(bot, "pricing_url", None),
        "pricing_gate_enabled": bool(getattr(bot, "pricing_gate_enabled", False)),
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate_routes.py tests/test_bot_cache_roundtrip.py -v
```

Expected: all passed

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/api/auth.py api/tests/test_pricing_gate_routes.py && git commit -m "fix(pricing-gate): carry gate fields through the bot cache payload"
```

---

## Task 9: Always link the pricing page from a gated answer

**Files:**
- Modify: `platform/api/app/services/pricing_gate.py`
- Modify: `platform/api/app/services/rag_service.py` (lines 7143 and 8476)
- Modify: `platform/api/tests/test_pricing_gate.py`

When the gate answers, the reply should carry the pricing page as a link even if the admin never created a matching Smart Link. Smart Links already do exactly this job, so the gate merges an implicit `pricing` entry rather than inventing a second linking mechanism.

- [ ] **Step 1: Write the failing test**

Append to `platform/api/tests/test_pricing_gate.py`:

```python
from app.services.pricing_gate import merge_pricing_smart_link


def test_merge_adds_an_implicit_pricing_link_when_the_gate_is_on():
    merged = merge_pricing_smart_link(
        answer_links=[{"keyword": "careers", "url": "https://acme.com/jobs"}],
        pricing_url="https://acme.com/pricing",
        gate_enabled=True,
    )
    assert {"keyword": "pricing", "url": "https://acme.com/pricing"} in merged
    assert {"keyword": "careers", "url": "https://acme.com/jobs"} in merged


def test_merge_does_not_override_an_admins_own_pricing_keyword():
    existing = [{"keyword": "Pricing", "url": "https://acme.com/plans"}]
    merged = merge_pricing_smart_link(
        answer_links=existing,
        pricing_url="https://acme.com/pricing",
        gate_enabled=True,
    )
    assert merged == existing


def test_merge_is_a_no_op_when_the_gate_is_off():
    existing = [{"keyword": "careers", "url": "https://acme.com/jobs"}]
    assert merge_pricing_smart_link(
        answer_links=existing, pricing_url="https://acme.com/pricing", gate_enabled=False
    ) == existing


def test_merge_handles_no_existing_links():
    merged = merge_pricing_smart_link(
        answer_links=None, pricing_url="https://acme.com/pricing", gate_enabled=True
    )
    assert merged == [{"keyword": "pricing", "url": "https://acme.com/pricing"}]
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py -k merge -v
```

Expected: FAIL with `ImportError: cannot import name 'merge_pricing_smart_link'`

- [ ] **Step 3: Write the implementation**

Append to `platform/api/app/services/pricing_gate.py`:

```python
def merge_pricing_smart_link(
    *,
    answer_links: list | None,
    pricing_url: object,
    gate_enabled: bool,
) -> list:
    """Add an implicit ``pricing`` smart link when the gate is on.

    A gated pricing answer should always hand the visitor the page it came from,
    and the SMART LINKS prompt block already does that job. Merging here rather
    than adding a second linking mechanism keeps one code path for hyperlinks.

    The admin's own entry always wins: if they already mapped the ``pricing``
    keyword, this returns the list untouched, even when it points somewhere else.
    """
    existing = list(answer_links or [])
    if not gate_enabled:
        return existing
    url = pricing_url if isinstance(pricing_url, str) else None
    if not url or normalize_url(url) is None:
        return existing
    for item in existing:
        if isinstance(item, dict) and (item.get("keyword") or "").strip().casefold() == "pricing":
            return existing
    return existing + [{"keyword": "pricing", "url": url.strip()}]
```

Then in `platform/api/app/services/rag_service.py`, add to the imports near the other service imports at the top of the file:

```python
from app.services import pricing_gate as _pricing_gate
```

And at BOTH `build_hybrid_prompt` callsites (line 7143 in `rag_pipeline`, line 8476 in `rag_pipeline_stream`), replace:

```python
                answer_links=getattr(bot, "answer_links", None) if bot else None,
```

with:

```python
                answer_links=_pricing_gate.merge_pricing_smart_link(
                    answer_links=getattr(bot, "answer_links", None) if bot else None,
                    pricing_url=getattr(bot, "pricing_url", None) if bot else None,
                    gate_enabled=bool(getattr(bot, "pricing_gate_enabled", False)) if bot else False,
                ),
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate.py tests/test_rag_service.py -v
```

Expected: all passed

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/services/pricing_gate.py api/app/services/rag_service.py api/tests/test_pricing_gate.py && git commit -m "feat(pricing-gate): link the pricing page from gated answers via smart links"
```

---

## Task 10: Wire the gate into the streaming pipeline

**Files:**
- Modify: `platform/api/app/services/rag_service.py` (in `rag_pipeline_stream`, immediately after `sources = [doc.document_name for doc in final_results]` around line 8163)
- Create: `platform/api/tests/test_pricing_gate_pipeline.py`

The streaming pipeline is what the widget uses ([chat_routes.py:1631](../../../api/app/api/chat_routes.py)), so it goes first.

- [ ] **Step 1: Write the failing test**

Create `platform/api/tests/test_pricing_gate_pipeline.py`:

```python
"""The pricing answer gate driven through the REAL ``rag_pipeline_stream``.

Modelled on ``test_rag_pipeline_defects.py``: a real throwaway Postgres, with
only the outside world stubbed (LLM stream, query rewrite, embedding, relevance
gate, plan entitlements). The gate itself, retrieval scoping, the canned early
return and persistence all run unmocked.
"""

import pytest

from app.db.models import Bot, Client
from app.services import rag_service as rs

_seq = iter(range(1, 100_000))


def _make_client(db):
    n = next(_seq)
    client = Client(
        name=f"Gate Client {n}",
        email=f"gate{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"gate-test-key-{n}",
    )
    db.add(client)
    db.commit()
    return client


def _make_bot(db, client, **kwargs):
    n = next(_seq)
    bot = Bot(
        client_id=client.id,
        bot_key=f"bot-gate-{n}",
        name="Gate Bot",
        company_name="Acme",
        **kwargs,
    )
    db.add(bot)
    db.commit()
    return bot


@pytest.fixture()
def _stub_outside_world(monkeypatch):
    """Stub everything that leaves the process, and pin the plan gate ON."""
    monkeypatch.setattr(rs, "rewrite_query", lambda _sid, q, _h: q)
    monkeypatch.setattr(rs, "_embed_query_cached", lambda *_a, **_k: None)
    monkeypatch.setattr(rs, "RERANK_ENABLED", False)
    monkeypatch.setattr(
        rs.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *_a, **_k: True
    )


async def _collect(agen) -> str:
    return "".join([chunk async for chunk in agen])


@pytest.mark.asyncio
async def test_pricing_question_without_a_configured_url_escalates(
    db, _stub_outside_world
):
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_gate_enabled=True, pricing_url=None)

    out = await _collect(
        rs.rag_pipeline_stream(bot, "how much does it cost?", session_id="gate-no-url", bot_id=bot.id)
    )

    assert "connect you with them" in out
    # The gate must not have reached the LLM at all.
    assert "FINAL_METADATA" in out


@pytest.mark.asyncio
async def test_free_plan_pricing_escalation_never_promises_a_human(
    db, monkeypatch, _stub_outside_world
):
    monkeypatch.setattr(
        rs.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *_a, **_k: False
    )
    client = _make_client(db)
    bot = _make_bot(
        db, client, pricing_gate_enabled=True, pricing_url="https://acme.com/pricing"
    )

    out = await _collect(
        rs.rag_pipeline_stream(bot, "what is your pricing?", session_id="gate-free", bot_id=bot.id)
    )

    lowered = out.lower()
    assert "connect you" not in lowered
    assert "message form" not in lowered
    assert rs.LEAVE_MESSAGE_CARD_SENTINEL not in out
    # It still hands over the page the owner configured.
    assert "https://acme.com/pricing" in out


@pytest.mark.asyncio
async def test_non_pricing_question_is_untouched_by_an_enabled_gate(
    db, _stub_outside_world
):
    client = _make_client(db)
    bot = _make_bot(
        db, client, pricing_gate_enabled=True, pricing_url="https://acme.com/pricing"
    )

    out = await _collect(
        rs.rag_pipeline_stream(bot, "who is the founder?", session_id="gate-other", bot_id=bot.id)
    )

    assert "Pricing for" not in out
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate_pipeline.py -v
```

Expected: FAIL — the gate does not exist in the pipeline yet, so the bot answers or refuses through the normal path.

- [ ] **Step 3: Write the implementation**

In `platform/api/app/services/rag_service.py`, find this line in `rag_pipeline_stream` (around line 8163):

```python
            sources = [doc.document_name for doc in final_results]
```

Insert directly BEFORE it:

```python
            # ── Pricing answer gate ──────────────────────────────────────────
            # Runs after retrieval is finalized and BEFORE the CRAG gate, on the
            # finalized chunk list, so it composes with fusion/rerank instead of
            # duplicating retrieval. Off by default; see
            # ``app/services/pricing_gate.py`` for the decision table.
            #
            # Deliberately yields to the quote flow: the BANT quotation card is
            # an admin-authored priced document, so when one is active or pending
            # it is the better pricing answer and this gate stands down.
            _pricing_decision = _pricing_gate.evaluate_pricing_gate(
                question=question,
                gate_enabled=(
                    bool(getattr(bot, "pricing_gate_enabled", False))
                    and not _quote_active_or_pending(bot, chat_session, current_bant)
                ),
                pricing_url=getattr(bot, "pricing_url", None) if bot else None,
                chunks=final_results,
            )
            if _pricing_decision.fired and _pricing_decision.outcome == "answer":
                # Narrow the context to the pricing page and let the normal
                # generation path run: the answer is grounded in that page alone.
                final_results = _pricing_decision.chunks
            elif _pricing_decision.fired:
                _safety_net_metric(
                    "pricing_gate_escalation",
                    reason=_pricing_decision.outcome,
                    path="stream",
                    session=session_id,
                    bot_id=bid,
                )
                _pivot = _pricing_gate.pricing_pivot(
                    company_name=_company_name,
                    pricing_url=getattr(bot, "pricing_url", None) if bot else None,
                    support_enabled=_plan_support_allowed,
                    live_chat_enabled=live_chat_on,
                )
                _pivot_text = _name_ack_prefix(
                    _flow_name, _just_named, language, returning=_returning_by_name
                ) + _pivot.text
                if _pivot.needs_message_card:
                    _pivot_text = f"{_pivot_text}\n{LEAVE_MESSAGE_CARD_SENTINEL}"
                yield _stream_metadata(session_id, [], language)
                yield _pivot_text
                _bot_msg = add_chat_message(
                    session,
                    session_id,
                    client_id=cid,
                    role="bot",
                    content=_pivot_text,
                    bot_id=bid,
                    is_unanswered=True,
                    source_language=_lang_base(language),
                )
                session.flush()
                _msg_id = _bot_msg.id
                session.commit()
                yield f"\nFINAL_METADATA:{json.dumps({'message_id': _msg_id, 'suggest_handoff': _pivot.suggest_handoff})}\n"
                return
```

Both names the block relies on are already in scope at the insertion point: `chat_session` is assigned at `rag_service.py:7972` and `current_bant` at `rag_service.py:7973`, and the existing quote gate at `rag_service.py:8449` calls `_quote_active_or_pending(bot, chat_session, current_bant)` with exactly these two.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate_pipeline.py tests/test_rag_pipeline_defects.py -v
```

Expected: all passed

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/services/rag_service.py api/tests/test_pricing_gate_pipeline.py && git commit -m "feat(pricing-gate): enforce the gate in the streaming RAG pipeline"
```

---

## Task 11: Wire the gate into the non-streaming pipeline

**Files:**
- Modify: `platform/api/app/services/rag_service.py` (in `rag_pipeline`, immediately after the rerank line around 6795)
- Modify: `platform/api/tests/test_pricing_gate_pipeline.py`

`rag_pipeline` and `rag_pipeline_stream` duplicate their gate logic today; leaving one un-gated would mean the admin Preview and any non-streaming caller quote prices the widget refuses to.

- [ ] **Step 1: Write the failing test**

Append to `platform/api/tests/test_pricing_gate_pipeline.py`:

```python
def test_non_streaming_pipeline_escalates_a_pricing_question(db, _stub_outside_world):
    client = _make_client(db)
    bot = _make_bot(db, client, pricing_gate_enabled=True, pricing_url=None)

    result = rs.rag_pipeline(bot, "what is your pricing?", session_id="gate-sync", bot_id=bot.id)

    assert "connect you with them" in result["answer"]
    assert result["sources"] == []
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate_pipeline.py -k non_streaming -v
```

Expected: FAIL — the non-streaming path answers through the normal flow.

- [ ] **Step 3: Write the implementation**

In `platform/api/app/services/rag_service.py`, find these lines in `rag_pipeline` (around line 6794):

```python
                if RERANK_ENABLED and not _lang_is_non_english(language):
                    final_results = rerank(search_query, final_results, top_n=_retrieval_k)
```

Insert directly after them (note: one indent level OUT of the `else:` block, aligned with the `# ── Phase 4A: CRAG relevance gate` comment that follows):

```python
            # ── Pricing answer gate ──────────────────────────────────────────
            # Mirror of the block in ``rag_pipeline_stream``. The two pipelines
            # duplicate every gate they share; keeping this one in both is what
            # stops the dashboard Preview from quoting a price the widget won't.
            _pricing_decision = _pricing_gate.evaluate_pricing_gate(
                question=question,
                gate_enabled=(
                    bool(getattr(bot, "pricing_gate_enabled", False))
                    and not _quote_active_or_pending(bot, chat_session, current_bant)
                ),
                pricing_url=getattr(bot, "pricing_url", None) if bot else None,
                chunks=final_results,
            )
            if _pricing_decision.fired and _pricing_decision.outcome == "answer":
                final_results = _pricing_decision.chunks
            elif _pricing_decision.fired:
                _safety_net_metric(
                    "pricing_gate_escalation",
                    reason=_pricing_decision.outcome,
                    session=session_id,
                    bot_id=bid,
                )
                _pivot = _pricing_gate.pricing_pivot(
                    company_name=_company_name,
                    pricing_url=getattr(bot, "pricing_url", None) if bot else None,
                    support_enabled=_plan_support_allowed,
                    live_chat_enabled=live_chat_on,
                )
                _pivot_text = _name_ack_prefix(
                    _flow_name, _just_named, language, returning=_returning_by_name
                ) + _pivot.text
                if _pivot.needs_message_card:
                    _pivot_text = f"{_pivot_text}\n{LEAVE_MESSAGE_CARD_SENTINEL}"
                _bot_msg = add_chat_message(
                    session,
                    session_id,
                    client_id=cid,
                    role="bot",
                    content=_pivot_text,
                    bot_id=bid,
                    is_unanswered=True,
                    source_language=_lang_base(language),
                )
                session.commit()
                return {
                    "answer": _pivot_text,
                    "sources": [],
                    "session_id": session_id,
                    "message_id": _bot_msg.id,
                    "suggest_handoff": _pivot.suggest_handoff,
                }
```

Both names are in scope here too: `chat_session` is assigned at `rag_service.py:6695` and `current_bant` at `rag_service.py:6696`, and the existing quote gate at `rag_service.py:7115` uses the same pair.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd platform/api && uv run pytest tests/test_pricing_gate_pipeline.py tests/test_rag_pipeline_defects.py tests/test_rag_service.py -v
```

Expected: all passed

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/services/rag_service.py api/tests/test_pricing_gate_pipeline.py && git commit -m "feat(pricing-gate): enforce the gate in the non-streaming RAG pipeline"
```

---

## Task 12: Record the known limitations

**Files:**
- Modify: `platform/api/app/services/pricing_gate.py` (module docstring)

- [ ] **Step 1: Append the limitations to the module docstring**

Replace the closing paragraph of the `pricing_gate.py` module docstring with:

```python
"""
...

KNOWN LIMITATIONS (deliberate, revisit with evidence):

1. English-only intent detection. ``is_pricing_question`` is a regex over
   English tokens plus currency symbols, so a pricing question in Hindi,
   Spanish, or any non-Latin script does NOT fire the gate and the turn falls
   back to today's unrestricted behaviour. This is the safe failure direction
   (nothing regresses) but it does mean a multilingual visitor can still get a
   price from a stale uploaded document. The same English-only constraint
   already applies to ``_ON_SCOPE_HINTS_RE`` and the CRAG judge in
   ``rag_service``; fix them together, not separately.

2. URL matching is exact after normalization. A pricing page reachable at more
   than one path, or crawled under a URL the admin did not paste, will not
   match and every pricing question escalates. The admin UI warns at save time
   when the URL is not present in the knowledge base (see the admin Voice
   section), which is what turns this from a silent failure into a visible one.

3. ``has_price_signal`` is a heuristic, not a classifier. A pricing page that
   states prices in a form none of its patterns cover reads as "no price
   content" and escalates. Escalating is the intended failure direction: the
   alternative is answering a pricing question from the rest of the knowledge
   base, which is the exact behaviour this gate exists to prevent.

4. Scoping to one page makes staleness more visible, not less. Once the gate is
   on, that page is the single source, so a stale crawl is quoted with full
   confidence. The admin UI shows when the page was last crawled.
"""
```

- [ ] **Step 2: Verify formatting**

```bash
cd platform/api && uv run ruff check app/services/pricing_gate.py && uv run ruff format --check app/services/pricing_gate.py
```

Expected: clean

- [ ] **Step 3: Commit**

```bash
cd platform && git add api/app/services/pricing_gate.py && git commit -m "docs(pricing-gate): record the gate's known limitations"
```

---

## Task 13: Admin UI data model

**Files:**
- Modify: `platform/app/src/features/agents/experience/experience-model.ts`
- Modify: `platform/app/src/features/agents/experience/experience-model.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `platform/app/src/features/agents/experience/experience-model.test.ts`:

```ts
describe('pricing gate', () => {
  it('parses the pricing gate fields off the bot payload', () => {
    const draft = draftFromBot({
      ...RAW,
      pricing_url: 'https://acme.test/pricing',
      pricing_gate_enabled: true,
    });
    expect(draft.pricingUrl).toBe('https://acme.test/pricing');
    expect(draft.pricingGateEnabled).toBe(true);
  });

  it('defaults the gate off when the payload omits it', () => {
    const draft = draftFromBot({ ...RAW });
    expect(draft.pricingUrl).toBe('');
    expect(draft.pricingGateEnabled).toBe(false);
  });

  it('patches only the changed pricing fields', () => {
    const baseline = draftFromBot({ ...RAW });
    const draft = { ...baseline, pricingGateEnabled: true, pricingUrl: 'https://acme.test/pricing' };
    const patch = patchFromDraft(draft, baseline);
    expect(patch.pricing_gate_enabled).toBe(true);
    expect(patch.pricing_url).toBe('https://acme.test/pricing');
  });

  it('rejects enabling the gate without a valid URL', () => {
    const baseline = draftFromBot({ ...RAW });
    const draft = { ...baseline, pricingGateEnabled: true, pricingUrl: '' };
    expect(validateDraft(draft).pricingUrl).toBeTruthy();
  });

  it('accepts the gate off with an empty URL', () => {
    const baseline = draftFromBot({ ...RAW });
    expect(validateDraft(baseline).pricingUrl).toBeUndefined();
  });
});
```

These are the names the file already imports (`draftFromBot`, `patchFromDraft`, `validateDraft`) and the `RAW` bot fixture it already defines at the top, so no new imports are needed.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd platform/app && npx vitest run src/features/agents/experience/experience-model.test.ts
```

Expected: FAIL — `draft.pricingUrl` is `undefined`

- [ ] **Step 3: Write the implementation**

3a. In the `ExperienceDraft` interface, after `smartLinks: SmartLink[];` (around line 165):

```ts
  /**
   * The one page a pricing answer may come from while `pricingGateEnabled` is
   * on. Empty string when unset.
   */
  pricingUrl: string;
  /**
   * Opt-in to the pricing answer gate. Off by default: with it on, a pricing
   * question the pricing page cannot answer routes to the team instead of
   * falling back to the rest of the knowledge base.
   */
  pricingGateEnabled: boolean;
```

3b. In the section map, after `smartLinks: 'voice',` (around line 243):

```ts
  pricingUrl: 'voice',
  pricingGateEnabled: 'voice',
```

3c. In `draftFromBot`, after `smartLinks: parseSmartLinks(raw.answer_links),` (around line 572):

```ts
    pricingUrl: asString(raw.pricing_url),
    pricingGateEnabled: asBoolean(raw.pricing_gate_enabled),
```

3d. In `normalizeDraft`, after `smartLinks: normalizeSmartLinks(draft.smartLinks),` (around line 637):

```ts
    pricingUrl: draft.pricingUrl.trim(),
```

3e. In `ANSWER_FIELDS`, after `'smartLinks',` (around line 738):

```ts
  'pricingUrl',
  'pricingGateEnabled',
```

3f. In `patchFromDraft`, after `if (changed.has('smartLinks')) patch.answer_links = draft.smartLinks;` (around line 809):

```ts
  if (changed.has('pricingUrl')) patch.pricing_url = draft.pricingUrl;
  if (changed.has('pricingGateEnabled')) patch.pricing_gate_enabled = draft.pricingGateEnabled;
```

3g. In `validateDraft`, after the `draft.smartLinks.forEach(...)` block (around line 906):

```ts
  // The gate is an answering restriction, so it cannot be armed without a
  // destination: enabling it with no URL would escalate every pricing question.
  if (draft.pricingGateEnabled && !isHttpUrl(draft.pricingUrl.trim())) {
    errors.pricingUrl =
      translateNow('agents.pricingGateNeedsAUrl') ||
      'Add the pricing page link before turning this on.';
  } else if (draft.pricingUrl.trim().length > 0 && !isHttpUrl(draft.pricingUrl.trim())) {
    errors.pricingUrl =
      translateNow('agents.enterAFullLinkStarting') ||
      'Enter a full link starting with http:// or https://';
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd platform/app && npx vitest run src/features/agents/experience/experience-model.test.ts
```

Expected: all passed

- [ ] **Step 5: Commit**

```bash
cd platform && git add app/src/features/agents/experience/experience-model.ts app/src/features/agents/experience/experience-model.test.ts && git commit -m "feat(pricing-gate): add pricing gate fields to the admin experience model"
```

---

## Task 14: Admin UI card

**Files:**
- Modify: `platform/app/src/features/agents/experience/VoiceSection.tsx`

- [ ] **Step 1: Add the card**

In `platform/app/src/features/agents/experience/VoiceSection.tsx`, insert a new `<Card>` immediately AFTER the closing `</Card>` of the smart-links card (the one whose `eyebrow` is `"Links"`), and before the closing `</div>` of the component:

```tsx
      <Card>
        <CardHeader
          eyebrow="Pricing"
          titleAs="h2"
          title={t('agents.answerPricingFromOnePage') || 'Answer pricing from one page only'}
          description={
            t('agents.whenThisIsOnPricing') ||
            'When this is on, the chatbot quotes prices only from the page below. If that page cannot answer, it routes the visitor to your team instead of guessing.'
          }
        />
        <CardBody className="flex flex-col gap-4">
          <Input
            value={draft.pricingUrl}
            disabled={readOnly}
            spellCheck={false}
            inputMode="url"
            aria-label={t('agents.pricingPageLink') || 'Pricing page link'}
            placeholder="https://example.com/pricing"
            aria-invalid={errors.pricingUrl ? true : undefined}
            onChange={(event) => onChange({ pricingUrl: event.target.value })}
          />
          {errors.pricingUrl ? (
            <p role="status" className="text-xs text-danger">
              {errors.pricingUrl}
            </p>
          ) : null}
          <Switch
            checked={draft.pricingGateEnabled}
            disabled={readOnly}
            onCheckedChange={(pricingGateEnabled) => onChange({ pricingGateEnabled })}
            label={t('agents.onlyAnswerPricingFrom') || 'Only answer pricing from this page'}
          />
        </CardBody>
      </Card>
```

`Switch` is the house primitive (see `LanguageSection.tsx:121`), and `VoiceSection.tsx` does not import it yet. Add it to the existing `from '../../../ui'` import block at the top of the file, keeping the list alphabetical:

```tsx
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  Field,
  Input,
  RadioCards,
  Switch,
  Textarea,
  Tooltip,
  Well,
} from '../../../ui';
```

- [ ] **Step 2: Verify it renders and type-checks**

```bash
cd platform/app && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Run lint and the full app test suite**

```bash
cd platform/app && npm run lint && npx vitest run
```

Expected: lint clean, all tests passed

- [ ] **Step 4: Build**

```bash
cd platform/app && npm run build
```

Expected: build succeeds

- [ ] **Step 5: Commit**

```bash
cd platform && git add app/src/features/agents/experience/VoiceSection.tsx && git commit -m "feat(pricing-gate): add the pricing gate card to the agent Voice settings"
```

---

## Task 15: Full baseline checks

**Files:** none (verification only)

- [ ] **Step 1: Verify the branch**

```bash
cd platform && git branch --show-current
```

Expected: `development`. If it prints `main`, run `git checkout development` before going further and do not commit on `main`.

- [ ] **Step 2: Run the Python checks**

```bash
cd platform/api && uv run ruff check . && uv run ruff format --check . && uv run pytest
```

Expected: ruff clean, full suite passes. Fix and re-run until clean; do not proceed with failures.

- [ ] **Step 3: Run the admin dashboard checks**

```bash
cd platform/app && npm run lint && npx tsc --noEmit && npm run build
```

Expected: all clean

- [ ] **Step 4: Manual smoke test**

1. Start the API: `conda activate oye && cd platform/api && uv run uvicorn app.main:app --port 8000 --reload`
2. Start the admin: `cd platform/app && npm run dev` and open http://localhost:5174
3. On a paid test bot, crawl a pricing page, then set the pricing URL to that page and turn the gate on.
4. In the widget preview, ask "what is your pricing?" — expect an answer grounded in that page, with the page linked.
5. Set the pricing URL to a page that is NOT in the knowledge base. Ask again — expect the team pivot, not a price.
6. Clear the URL and leave the gate on. Ask again — expect the team pivot.
7. Repeat step 5 on a Free-plan bot — expect the bot-only pivot with the page link and no mention of the team.
8. Ask "how much time does onboarding take?" with the gate on — expect a normal knowledge-base answer, not an escalation.

- [ ] **Step 5: Report**

State in the final message which checks passed, in the form `ruff ✓ · pytest ✓ · lint ✓ · tsc ✓ · build ✓`, and list anything from the manual smoke test that did not behave as described.
