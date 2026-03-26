import logging

from google import genai

from app.config import GEMINI_MODEL, GOOGLE_API_KEY
from app.core.langfuse_client import get_langfuse

logger = logging.getLogger(__name__)

# Initialize the client
client = genai.Client(api_key=GOOGLE_API_KEY)


def _detect_intent_raw(question: str) -> bool:
    """Raw Gemini call to detect sales intent. No observability instrumentation."""
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

    response = client.models.generate_content(model=GEMINI_MODEL, contents=[prompt])

    result = response.text.strip().upper()
    has_intent = "YES" in result
    logger.info(f"Intent Detection for '{question}': {result}")
    return has_intent


def detect_sales_intent(question: str) -> bool:
    """
    Analyzes the user's question to determine if it has 'Business Intent' or 'Sales Intent'.
    Returns True if the user is asking about services, pricing, partnership, or business solutions.
    Instrumented with Langfuse v4 context manager when enabled.
    """
    lf = get_langfuse()
    if lf is None:
        try:
            return _detect_intent_raw(question)
        except Exception as e:
            logger.error(f"Intent detection failed: {e}")
            return False

    with lf.start_as_current_observation(
        name="intent-detection",
        as_type="generation",
        model=GEMINI_MODEL,
        input=question,
        metadata={"tags": ["intent"]},
    ) as observation:
        try:
            result = _detect_intent_raw(question)
            observation.update(output={"has_sales_intent": result})
            return result
        except Exception as e:
            logger.error(f"Intent detection failed: {e}")
            observation.update(output={"error": str(e)}, level="ERROR")
            return False
