import logging

from app.services.llm_service import generate_response

logger = logging.getLogger(__name__)


def _detect_intent_raw(question: str) -> bool:
    """Detect sales intent via LLM. No observability instrumentation (LiteLLM auto-traces)."""
    prompt = f"""
    Analyze the following user query and determine if the user is expressing "Sales Intent" or "Business Interest".

    Sales Intent indicators:
    - Asking about services, products, or what the company does.
    - Asking about pricing, costs, or plans.
    - Asking for a demo, consultation, or meeting.
    - Expressing a business problem they want to solve.
    - Asking about partnership or collaboration.

    Query: "{question}"

    Respond with ONLY 'YES' if sales intent is detected, or 'NO' if it is just a general question, small talk, or unrelated.
    """

    response = generate_response(prompt, metadata={"generation_name": "intent-detection"})
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
    prompt = f"""
    Analyze the following user message and determine if the user wants to be connected
    to a human agent, support representative, or real person — rather than continuing
    with an AI chatbot.

    Human handoff indicators:
    - Asking to speak with a human, agent, person, or representative.
    - Expressing desire to escalate beyond the AI chatbot.
    - Phrases like: "talk to someone", "real person", "connect me with support",
      "speak to your team", "I want a human", "get me an agent", "talk to a person",
      "connect me with a human", "I want to speak with someone", "let me talk to support".

    Do NOT classify as handoff intent:
    - General product/service questions.
    - Help requests that don't express preference for human over AI.
    - Small talk or greetings.
    - Questions about pricing, features, or how things work.

    User message: "{question}"

    Respond with ONLY 'YES' or 'NO'.
    """
    response = generate_response(prompt, metadata={"generation_name": "handoff-intent-detection"})
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
