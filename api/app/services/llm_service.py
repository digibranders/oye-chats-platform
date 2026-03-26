import time
import logging
from typing import Optional
from google import genai
from app.config import GOOGLE_API_KEY, GEMINI_MODEL

logger = logging.getLogger(__name__)

# Validate API Key on import
if not GOOGLE_API_KEY:
    logger.error("CRITICAL: GOOGLE_API_KEY is not set! Chat responses will fail. Check your .env file.")
else:
    logger.info(f"Gemini API Key loaded (ends with ...{GOOGLE_API_KEY[-4:]}), Model: {GEMINI_MODEL}")

# Initialize the client
client = genai.Client(api_key=GOOGLE_API_KEY)

def generate_response(prompt: str) -> str:
    """
    Generate a standard (non-streaming) response from Google Gemini.
    """
    if not GOOGLE_API_KEY:
        logger.error("Cannot generate response: GOOGLE_API_KEY is not set.")
        return "Configuration error: AI service is not configured. Please contact the administrator."
    try:
        logger.info(f"Generating Gemini response | model={GEMINI_MODEL} | prompt_length={len(prompt)}")
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt
        )
        if response and response.text:
            logger.info(f"Gemini response received | length={len(response.text)}")
            return response.text
        else:
            logger.warning(f"Gemini returned empty response. Candidates: {getattr(response, 'candidates', 'N/A')}")
            return "I'm sorry, I couldn't generate a response. Please try again."
    except Exception as e:
        logger.error(f"Gemini API Error ({type(e).__name__}): {e}", exc_info=True)
        return f"I encountered an error generating the response. Error: {type(e).__name__}"

def generate_response_stream(prompt: str):
    """
    Generate a streaming response from Google Gemini.
    Yields chunks of text as they are generated.
    """
    if not GOOGLE_API_KEY:
        logger.error("Cannot stream response: GOOGLE_API_KEY is not set.")
        yield "Configuration error: AI service is not configured. Please contact the administrator."
        return
    try:
        logger.info(f"Starting Gemini stream | model={GEMINI_MODEL} | prompt_length={len(prompt)}")
        for chunk in client.models.generate_content_stream(
            model=GEMINI_MODEL,
            contents=prompt
        ):
            if chunk.text:
                yield chunk.text
            else:
                # Log if chunk is empty (might be a safety block or finish)
                if hasattr(chunk, 'candidates') and chunk.candidates:
                    finish_reason = chunk.candidates[0].finish_reason
                    logger.info(f"Gemini stream chunk empty. Finish reason: {finish_reason}")
                else:
                    logger.info("Gemini stream chunk empty with no candidates.")
    except Exception as e:
        logger.error(f"Gemini Streaming Error ({type(e).__name__}): {e}", exc_info=True)
        yield f"I encountered an error generating the response. Error: {type(e).__name__}"


# ─────────────────────────────────────────────────────────────────────────────
# Langfuse v4 Observed Wrappers
# Uses @observe decorator and context manager APIs (OpenTelemetry-based).
# When Langfuse is disabled (no env vars), these delegate to the originals.
# ─────────────────────────────────────────────────────────────────────────────


def generate_response_observed(
    prompt: str,
    *,
    generation_name: str = "llm-generation",
    metadata: Optional[dict] = None,
    **kwargs,
) -> str:
    """
    Observed wrapper around generate_response().
    Creates a Langfuse generation context when Langfuse is enabled.
    """
    from app.core.langfuse_client import get_langfuse

    lf = get_langfuse()
    if lf is None:
        return generate_response(prompt)

    with lf.start_as_current_observation(
        name=generation_name,
        as_type="generation",
        model=GEMINI_MODEL,
        input=prompt[:500],
        metadata=metadata or {},
    ) as generation:
        if not GOOGLE_API_KEY:
            result = "Configuration error: AI service is not configured."
            generation.update(output=result, level="ERROR")
            return result

        try:
            response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)

            if response and response.text:
                result = response.text
                usage_meta = getattr(response, "usage_metadata", None)
                usage = {}
                if usage_meta:
                    usage = {
                        "input": getattr(usage_meta, "prompt_token_count", None),
                        "output": getattr(usage_meta, "candidates_token_count", None),
                        "total": getattr(usage_meta, "total_token_count", None),
                    }
                generation.update(output=result, usage_details=usage if usage else None)
                return result
            else:
                result = "I'm sorry, I couldn't generate a response. Please try again."
                generation.update(output=result, level="WARNING")
                return result

        except Exception as e:
            error_msg = f"Gemini API Error: {type(e).__name__}: {e}"
            logger.error(error_msg, exc_info=True)
            generation.update(output=error_msg, level="ERROR", status_message=str(e))
            return f"I encountered an error generating the response. Error: {type(e).__name__}"


def generate_response_stream_observed(
    prompt: str,
    *,
    generation_name: str = "llm-stream-generation",
    metadata: Optional[dict] = None,
    **kwargs,
):
    """
    Observed wrapper around generate_response_stream().
    Creates a Langfuse generation context and captures TTFT + accumulated output.
    Uses try/finally to ensure span is ended even if stream is interrupted.
    """
    from app.core.langfuse_client import get_langfuse

    lf = get_langfuse()
    if lf is None:
        yield from generate_response_stream(prompt)
        return

    accumulated = ""
    start_time = time.time()
    first_token_time = None

    with lf.start_as_current_observation(
        name=generation_name,
        as_type="generation",
        model=GEMINI_MODEL,
        input=prompt[:500],
        metadata=metadata or {},
    ) as generation:
        try:
            for chunk in generate_response_stream(prompt):
                if chunk and first_token_time is None:
                    first_token_time = time.time()
                accumulated += chunk
                yield chunk
        finally:
            ttft = round((first_token_time - start_time) * 1000) if first_token_time else None
            total_time = round((time.time() - start_time) * 1000)

            generation.update(
                output=accumulated,
                metadata={
                    "ttft_ms": ttft,
                    "total_time_ms": total_time,
                    **(metadata or {}),
                },
            )
