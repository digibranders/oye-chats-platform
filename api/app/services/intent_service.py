import logging
import re

from app.services.llm_service import generate_response

logger = logging.getLogger(__name__)

# Compiled regex for fast keyword-based handoff detection.
# Used as a fallback when the LLM intent call times out or fails.
_HANDOFF_KEYWORDS_RE = re.compile(
    r"(?i)\b("
    r"talk to (?:a |an |the )?(?:human|person|someone|agent|representative|rep|operator|support)"
    r"|speak (?:to|with) (?:a |an |the )?(?:human|person|someone|agent|representative|rep|operator|support|team|your team)"
    r"|connect (?:me |us )?(?:to|with) (?:a |an |the )?(?:human|person|someone|agent|representative|support|team|your team|support team)"
    r"|real person"
    r"|get (?:me |us )?(?:a |an )?(?:human|agent|operator|representative)"
    r"|let me talk"
    r"|need (?:a )?(?:human|real person|actual person)"
    r"|(?:contact|reach|get in touch with) (?:the )?(?:support|team|your team|support team)"
    r"|(?:can|could) I (?:talk|speak|chat) (?:to|with)"
    r"|(?:i want|i need|i'd like) (?:a |to talk to |to speak (?:to|with) )?(?:a )?(?:human|person|agent|representative|support)"
    r"|escalate"
    r"|transfer (?:me |us )?to"
    r")\b"
)


def _detect_intent_raw(question: str) -> bool:
    """Detect sales intent via LLM. No observability instrumentation (LiteLLM auto-traces)."""
    prompt = f"""You are a sales-intent classifier for a customer-facing chatbot.

TASK: Determine whether the user's message signals business or sales intent.

CLASSIFY AS YES when the user:
- Asks about services, pricing, plans, or subscriptions
- Requests a demo, consultation, or meeting
- Describes a business problem they need solved
- Inquires about partnerships or integrations
- Compares your offerings to competitors

CLASSIFY AS NO when the user:
- Asks a general knowledge or support question
- Makes small talk or greetings
- Asks how-to or troubleshooting questions
- Requests contact information without buying intent

User message: "{question}"

Respond with ONLY the word YES or NO. No explanation."""

    response = generate_response(prompt, temperature=0, max_tokens=3, metadata={"generation_name": "intent-detection"})
    result = response.strip().upper()
    has_intent = "YES" in result
    logger.info("Sales Intent Detection for '%s': %s", question, result)
    return has_intent


def detect_sales_intent(question: str) -> bool:
    """
    Analyzes the user's question to determine if it has 'Business Intent' or 'Sales Intent'.
    Returns True if the user is asking about services, pricing, partnership, or business solutions.
    LiteLLM auto-instruments with Langfuse via callbacks.
    """
    try:
        return _detect_intent_raw(question)
    except Exception as e:
        logger.error(f"Intent detection failed: {e}")
        return False


def _detect_handoff_intent_raw(question: str) -> bool:
    """Detect human handoff intent via LLM. Same pattern as sales intent detection."""
    prompt = f"""You are a handoff-intent classifier for a customer-facing chatbot.

TASK: Determine whether the user wants to IMMEDIATELY be connected to a live human operator in THIS conversation — not merely asking about how to reach someone later.

CLASSIFY AS YES when the user:
- Explicitly requests a human, agent, operator, or real person RIGHT NOW
- Expresses frustration with the AI and demands human help
- Asks to be transferred, escalated, or connected to support NOW
- Says they are done talking to the bot and want a person

CLASSIFY AS NO when the user:
- Asks for contact information (email, phone, address) — they want DATA, not a live transfer
- Asks "how can I contact [company]?" — this is an informational question
- Asks general help, product, or pricing questions
- Makes small talk, greetings, or thank-you messages
- Mentions "support" or "team" in a non-transfer context (e.g., "does your support team work weekends?")
- Uses words like "escalate", "transfer", or "contact" while asking ABOUT a process, not requesting one

KEY DISTINCTION: "Connect me with support" = YES (immediate action request). "How do I contact support?" = NO (informational query). The difference is whether the user wants action NOW or information ABOUT how to act later.

User message: "{question}"

Respond with ONLY the word YES or NO. No explanation."""
    response = generate_response(
        prompt, temperature=0, max_tokens=3, metadata={"generation_name": "handoff-intent-detection"}
    )
    result = response.strip().upper()
    has_intent = "YES" in result
    logger.info("Handoff Intent Detection for '%s': %s", question, result)
    return has_intent


def detect_handoff_intent_keywords(question: str) -> bool:
    """Fast keyword-based handoff detection — no LLM call.

    Returns True if the message matches common handoff phrases.
    Used as a fallback when the LLM-based detection times out or errors.
    """
    return bool(_HANDOFF_KEYWORDS_RE.search(question))


def detect_handoff_intent(question: str) -> bool:
    """Hybrid handoff detection: keyword signal + LLM decision.

    Every message gets an LLM analysis — keywords only influence the
    fallback behaviour when the LLM is unavailable.

    Flow:
        1. Keyword regex pre-screens (instant, zero cost).
        2. LLM makes the final YES/NO decision for ALL messages.
        3. If LLM fails:
           - keyword match existed  → trust keywords  (user was explicit)
           - no keyword match       → return False     (ambiguous, safe default)
    """
    has_keyword = detect_handoff_intent_keywords(question)
    if has_keyword:
        logger.info("Handoff keywords matched for: '%s' — requesting LLM confirmation", question)

    try:
        return _detect_handoff_intent_raw(question)
    except Exception as e:
        if has_keyword:
            logger.error("Handoff LLM failed for '%s': %s — trusting keyword match", question, e)
            return True
        logger.error("Handoff LLM failed for '%s': %s — no keyword signal, skipping", question, e)
        return False
