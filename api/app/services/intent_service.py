import logging
import re

from app.services.llm_service import generate_response

logger = logging.getLogger(__name__)

# Compiled regex for fast keyword-based handoff detection.
# Used as a fallback when the LLM intent call times out or fails.
#
# Two design notes:
#   • Use \s+ (not literal spaces) so noisy whitespace / typos like
#     "iw  th" — extra spaces between tokens — still match.
#   • Cover both "live connection" intents (talk to a human now) AND
#     "leave a message" intents (send/leave/drop a message). Both flows
#     funnel through the same handoff form on the widget; the form then
#     decides between live-queue vs offline-message based on operator
#     availability.
_HANDOFF_KEYWORDS_RE = re.compile(
    r"(?i)\b("
    # talk/speak/chat/connect/transfer to a human / agent / team / support
    r"(?:talk|speak|chat|connect|transfer)\s+(?:me\s+|us\s+)?(?:to|wit[h]?)\s+(?:a\s+|an\s+|the\s+)?"
    r"(?:human|person|someone|anybody|anyone|agent|representative|rep|operator|support|team|your\s+team|support\s+team|customer\s+(?:support|service|care))"
    # real / actual / live human|person|agent
    r"|(?:real|actual|live)\s+(?:human|person|agent)"
    # get me a human / agent / operator / representative
    r"|get\s+(?:me\s+|us\s+)?(?:a\s+|an\s+)?(?:human|agent|operator|representative)"
    # let me talk / speak / chat
    r"|let\s+me\s+(?:talk|speak|chat)"
    # need a human / real person / actual person
    r"|need\s+(?:a\s+)?(?:human|real\s+person|actual\s+person)"
    # contact / reach / message / email / get in touch with (the|your)? support|team|...
    r"|(?:contact|reach|message|email|get\s+in\s+touch\s+wit[h]?)\s+(?:the\s+|your\s+|a\s+)?"
    r"(?:support|team|your\s+team|support\s+team|customer\s+(?:support|service|care))"
    # can / could I talk|speak|chat|connect to|with
    r"|(?:can|could)\s+i\s+(?:talk|speak|chat|connect)\s+(?:to|wit[h]?)"
    # I want / need / would like / wanna [to] talk|speak|chat|connect|contact|reach|message|email
    r"|(?:i\s+(?:want|need|wanna|would\s+like|'?d\s+like))\s+(?:to\s+)?"
    r"(?:talk|speak|chat|connect|contact|reach|message|email)"
    # send / leave / drop / write a message / note / email (to someone)
    r"|(?:send|leave|drop|write)\s+(?:me\s+|us\s+|you\s+)?(?:a\s+|an\s+)?"
    r"(?:message|note|email|mail)"
    # escalate
    r"|escalate"
    # transfer me / us to (someone)
    r"|transfer\s+(?:me\s+|us\s+)?to"
    # how can / do I|we connect|talk|speak|chat|contact|reach
    r"|how\s+(?:can|do)\s+(?:i|we)\s+(?:connect|talk|speak|chat|contact|reach)"
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

    response = generate_response(prompt, temperature=0, max_tokens=16, metadata={"generation_name": "intent-detection"})
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

TASK: Determine whether the user wants to be connected to a live human operator or support team member.

CLASSIFY AS YES when the user:
- Explicitly requests a human, agent, operator, or real person
- Asks to connect with, reach, or get in touch with the team or support
- Expresses frustration with the AI and demands human help
- Asks to be transferred, escalated, or connected to support
- Says they are done talking to the bot and want a person
- Uses phrasing like "how can I connect with the team" or "I want to talk to someone"

CLASSIFY AS NO when the user:
- Asks for specific contact DATA (email address, phone number, office address) without requesting a live connection
- Asks general help, product, or pricing questions
- Makes small talk, greetings, or thank-you messages
- Mentions "support" or "team" in a non-transfer context (e.g., "does your support team work weekends?")

KEY RULE: When the message is ambiguous between wanting contact info and wanting a live connection, classify as YES. A false handoff offer is far less harmful than ignoring a connection request.

User message: "{question}"

Respond with ONLY the word YES or NO. No explanation."""
    response = generate_response(
        prompt, temperature=0, max_tokens=16, metadata={"generation_name": "handoff-intent-detection"}
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

    Flow:
        1. Keyword regex pre-screens (instant, zero cost).
        2. LLM makes the final YES/NO decision.
        3. If LLM says YES → return True.
        4. If LLM says NO but keywords matched → trust the explicit
           keyword signal (override). Users who type "connect me with
           your team" should never be silently ignored.
        5. If LLM fails → fall back to keyword result.
    """
    has_keyword = detect_handoff_intent_keywords(question)
    if has_keyword:
        logger.info("Handoff keywords matched for: '%s' — requesting LLM confirmation", question)

    try:
        llm_result = _detect_handoff_intent_raw(question)
        if llm_result:
            return True
        # LLM said NO — but if keywords matched, trust the explicit signal
        if has_keyword:
            logger.info(
                "LLM declined handoff for '%s' but keywords matched — overriding to YES",
                question,
            )
            return True
        return False
    except Exception as e:
        if has_keyword:
            logger.error("Handoff LLM failed for '%s': %s — trusting keyword match", question, e)
            return True
        logger.error("Handoff LLM failed for '%s': %s — no keyword signal, skipping", question, e)
        return False
