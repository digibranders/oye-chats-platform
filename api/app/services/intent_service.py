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
