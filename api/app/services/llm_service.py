import logging

import litellm

from app.config import LLM_MODEL, OPENAI_API_KEY

logger = logging.getLogger(__name__)

if not OPENAI_API_KEY:
    logger.error("CRITICAL: OPENAI_API_KEY is not set! Chat responses will fail. Check your .env file.")


def generate_response(prompt: str, *, metadata: dict | None = None) -> str:
    """Generate a non-streaming response via LiteLLM."""
    if not OPENAI_API_KEY:
        logger.error("Cannot generate response: OPENAI_API_KEY is not set.")
        return "Configuration error: AI service is not configured. Please contact the administrator."
    try:
        logger.info(f"Generating LLM response | model={LLM_MODEL} | prompt_length={len(prompt)}")
        response = litellm.completion(
            model=LLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            metadata=metadata,
        )
        content = response.choices[0].message.content
        if content:
            logger.info(f"LLM response received | length={len(content)}")
            return content
        else:
            logger.warning("LLM returned empty response.")
            return "I'm sorry, I couldn't generate a response. Please try again."
    except Exception as e:
        logger.error(f"LLM API Error ({type(e).__name__}): {e}", exc_info=True)
        return f"I encountered an error generating the response. Error: {type(e).__name__}"


def generate_response_stream(prompt: str, *, metadata: dict | None = None):
    """Generate a streaming response via LiteLLM. Yields text chunks."""
    if not OPENAI_API_KEY:
        logger.error("Cannot stream response: OPENAI_API_KEY is not set.")
        yield "Configuration error: AI service is not configured. Please contact the administrator."
        return
    try:
        logger.info(f"Starting LLM stream | model={LLM_MODEL} | prompt_length={len(prompt)}")
        response = litellm.completion(
            model=LLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            stream=True,
            metadata=metadata,
        )
        for chunk in response:
            content = chunk.choices[0].delta.content
            if content:
                yield content
    except Exception as e:
        logger.error(f"LLM Streaming Error ({type(e).__name__}): {e}", exc_info=True)
        yield f"I encountered an error generating the response. Error: {type(e).__name__}"
