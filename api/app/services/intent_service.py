import logging
import re

from app.services import runtime_config
from app.services.llm_service import generate_response

logger = logging.getLogger(__name__)

# Budget for the per-turn handoff classifier. It sits on the visitor's critical
# path: ``rag_service`` awaits it (with its own 4s ceiling) before retrieval can
# proceed, so the call gets ONE attempt and a bound that fits inside that
# ceiling. A same-model retry could not finish in time anyway; it would only
# pin the worker thread past the point where the caller has already given up
# and fallen back to the keyword result.
_HANDOFF_LLM_TIMEOUT_S = 3.0
_HANDOFF_LLM_NUM_RETRIES = 0

# Compiled regex for fast keyword-based handoff detection.
#
# A match is the decision in ``detect_handoff_intent`` (no LLM call is made),
# and ``rag_service`` also uses it directly as the fallback when the LLM task
# exceeds its ceiling.
#
# Two design notes:
#   • Use \s+ (not literal spaces) so noisy whitespace / typos like
#     "iw  th" (extra spaces between tokens) still match.
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


def _detect_handoff_intent_raw(question: str) -> bool:
    """Detect human handoff intent via LLM: a one-word YES/NO classification.

    Runs on the gate-tier model (AR-10) with a single tightly bounded attempt.
    This ran on the PRIMARY model with the default 60s × 3-attempt budget on
    every turn, for a one-word YES/NO: the most expensive tier in the platform
    doing the cheapest classification, and the same reasoning tier the
    relevance gate already proved adequate for exactly this kind of judgement.
    No cross-provider fallback: :func:`detect_handoff_intent` degrades to "no
    handoff" on any error, which is the right answer for a message the keyword
    regex has already cleared.
    """
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
        prompt,
        temperature=0,
        max_tokens=16,
        metadata={"generation_name": "handoff-intent-detection"},
        model=runtime_config.get_gate_model(),
        timeout=_HANDOFF_LLM_TIMEOUT_S,
        num_retries=_HANDOFF_LLM_NUM_RETRIES,
    )
    result = response.strip().upper()
    has_intent = "YES" in result
    logger.info("Handoff Intent Detection for '%s': %s", question, result)
    return has_intent


def detect_handoff_intent_keywords(question: str) -> bool:
    """Fast keyword-based handoff detection, no LLM call.

    Returns True if the message matches common handoff phrases. A match is
    authoritative in :func:`detect_handoff_intent`; ``rag_service`` also calls
    this directly as the fallback when the LLM task exceeds its ceiling.
    """
    return bool(_HANDOFF_KEYWORDS_RE.search(question))


def detect_handoff_intent(question: str) -> bool:
    """Hybrid handoff detection: keyword match first, LLM only for the rest.

    Flow:
        1. Keyword regex (instant, zero cost). A match IS the decision. The
           previous version still asked the LLM here and then overrode its NO
           with the keyword result, so on exactly the turns where the answer
           was already known the LLM call was pure latency and cost. Users who
           type "connect me with your team" are never silently ignored.
        2. No keyword match → the LLM makes the YES/NO call.
        3. LLM fails → False. There is no keyword signal to fall back on, and
           a missed handoff offer is recoverable (the visitor can rephrase)
           while a blocked turn is not.
    """
    if detect_handoff_intent_keywords(question):
        logger.info("Handoff keywords matched for: '%s'", question)
        return True

    try:
        return _detect_handoff_intent_raw(question)
    except Exception as e:
        logger.error("Handoff LLM failed for '%s': %s, no keyword signal, skipping", question, e)
        return False
