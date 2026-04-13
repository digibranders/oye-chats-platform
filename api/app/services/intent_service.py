import logging

from app.services.llm_service import generate_response

logger = logging.getLogger(__name__)


def _detect_intent_raw(question: str) -> bool:
    """Detect sales intent via LLM. No observability instrumentation (LiteLLM auto-traces)."""
    prompt = f"""Determine if the user query has sales intent.

Sales intent = asking about services, pricing, plans, demos, consultations, business problems, or partnerships.

Query: "{question}"

Respond with ONLY 'YES' or 'NO'."""

    response = generate_response(prompt, temperature=0, metadata={"generation_name": "intent-detection"})
    result = response.strip().upper()
    has_intent = "YES" in result
    logger.info(f"Intent Detection for '{question}': {result}")
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
    prompt = f"""Determine if the user wants to speak with a human agent or support representative instead of continuing with AI.

Handoff indicators: "talk to someone", "real person", "connect me with support", "speak to your team", "I want a human", "get me an agent", "let me talk to support", "connect with the team", "connect with support", "reach your team", "talk to a person", "speak with someone", "help from a human", "get in touch with", "contact support", "contact the team", "need a real person", "can I talk to someone", asking to escalate beyond the chatbot.

ONLY return YES if the user explicitly wants a human instead of AI. General help requests, product questions, pricing questions, small talk, or greetings = NO.

User message: "{question}"

Respond with ONLY 'YES' or 'NO'."""
    response = generate_response(prompt, temperature=0, metadata={"generation_name": "handoff-intent-detection"})
    result = response.strip().upper()
    has_intent = "YES" in result
    logger.info(f"Handoff Intent Detection for '{question}': {result}")
    return has_intent


def detect_handoff_intent(question: str) -> bool:
    """
    Analyzes the user's message to determine if they want to be connected to a human agent.
    Returns True if the user is requesting human support rather than AI assistance.
    LiteLLM auto-instruments with Langfuse via callbacks.
    """
    try:
        return _detect_handoff_intent_raw(question)
    except Exception as e:
        logger.error(f"Handoff intent detection failed: {e}")
        return False
