import asyncio
import logging

import litellm

from app.config import FALLBACK_MODEL, FALLBACK_MODEL_KEY_SET, LLM_FALLBACKS, LLM_MODEL, PRIMARY_MODEL_KEY_SET

logger = logging.getLogger(__name__)


def _bare_model(model: str) -> str:
    """Strip a LiteLLM provider prefix (``openai/``, ``azure/`` …) from a model id."""
    return model.split("/", 1)[1] if "/" in model else model


def _apply_model_family_kwargs(kwargs: dict, model: str) -> None:
    """Inject family-specific parameters into a LiteLLM ``completion`` kwargs dict.

    gpt-5 family models default to ``reasoning_effort="medium"``, which spends
    most of the output-token budget on hidden reasoning tokens before any
    visible content is produced. With our typical RAG prompts (≈25k chars of
    context) this manifests as empty completions — Sentry: "LLM returned empty
    response". The two sub-families use different "no reasoning" sentinels:

    * gpt-5.4 family (gpt-5.4, gpt-5.4-mini, …): ``reasoning_effort="none"``
      (``"minimal"`` is rejected with ``Unsupported value`` from OpenAI;
      valid values are ``none|low|medium|high|xhigh``).
    * Older gpt-5 family (gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-codex):
      ``reasoning_effort="minimal"`` (``"none"`` is not supported there;
      valid values are ``minimal|low|medium|high``).

    ``litellm.drop_params=True`` (set in ``app/main.py`` and
    ``app/worker/settings.py``) silently strips this for non-OpenAI providers
    if the LiteLLM fallback path retries with Gemini.
    """
    bare = _bare_model(model)
    if bare.startswith("gpt-5.4"):
        kwargs.setdefault("reasoning_effort", "none")
    elif bare.startswith("gpt-5"):
        kwargs.setdefault("reasoning_effort", "minimal")


def generate_response(
    prompt: str,
    *,
    max_tokens: int | None = None,
    temperature: float | None = None,
    metadata: dict | None = None,
) -> str:
    """Generate a non-streaming response via LiteLLM."""
    if not PRIMARY_MODEL_KEY_SET:
        logger.error(f"Cannot generate response: API key for primary model '{LLM_MODEL}' is not set.")
        return "Configuration error: AI service is not configured. Please contact the administrator."
    try:
        logger.info(f"Generating LLM response | model={LLM_MODEL} | prompt_length={len(prompt)}")
        kwargs: dict = {
            "model": LLM_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "metadata": metadata,
            "fallbacks": LLM_FALLBACKS,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if temperature is not None:
            kwargs["temperature"] = temperature
        _apply_model_family_kwargs(kwargs, LLM_MODEL)
        response = litellm.completion(**kwargs)
        content = response.choices[0].message.content
        if content:
            logger.info(f"LLM response received | length={len(content)}")
            return content
        else:
            logger.warning("LLM returned empty response.")
            return "I'm sorry, I couldn't generate a response. Please try again."
    except Exception as e:
        logger.error(f"LLM API Error ({type(e).__name__}): {e}", exc_info=True)
        return "I encountered an error generating the response. Please try again."


def extract_brand_tone(content_sample: str, *, metadata: dict | None = None) -> str | None:
    """Analyze scraped website content and extract a concise brand tone description.

    Returns a short tone description (e.g., "Professional and friendly, uses simple language")
    or None if extraction fails.
    """
    if not PRIMARY_MODEL_KEY_SET or not content_sample.strip():
        return None
    try:
        prompt = f"""Analyze this website content and describe the brand's communication tone in 1-2 sentences.

Focus on: formality level (formal/casual/mixed), personality (friendly/authoritative/playful/neutral), vocabulary complexity (simple/technical/mixed), and overall voice.

Example outputs:
- "Professional and approachable. Uses simple language with a warm, helpful tone."
- "Technical and authoritative. Industry jargon is common, formal sentence structure."
- "Casual and playful. Short sentences, conversational, uses humor."

Website content:
{content_sample[:3000]}

Return ONLY the tone description, nothing else."""

        kwargs: dict = {
            "model": LLM_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 100,
            "metadata": metadata or {"generation_name": "brand-tone-extraction"},
            "fallbacks": LLM_FALLBACKS,
        }
        _apply_model_family_kwargs(kwargs, LLM_MODEL)
        response = litellm.completion(**kwargs)
        tone = (response.choices[0].message.content or "").strip()
        if tone and len(tone) < 500:
            logger.info(f"Brand tone extracted: {tone[:80]}...")
            return tone
        return None
    except Exception as e:
        logger.warning(f"Brand tone extraction failed (non-blocking): {e}")
        return None


def extract_company_context(content_sample: str, *, metadata: dict | None = None) -> dict | None:
    """Analyze scraped website content and extract the company name and description.

    Returns ``{"name": "Acme Corp", "description": "Acme Corp is a ..."}``
    or *None* if extraction fails.
    """
    if not PRIMARY_MODEL_KEY_SET or not content_sample.strip():
        return None
    try:
        prompt = f"""Analyze this website content and extract two things:

1. COMPANY NAME: The exact official company/brand name (e.g., "Fynix Digital", "Acme Corp").
2. COMPANY DESCRIPTION: A 2-3 sentence factual description of what the company does, its core services/products, and industry. Write in third person.

Respond in EXACTLY this format (two lines, no extra text):
NAME: <company name>
DESCRIPTION: <company description>

Example:
NAME: Fynix Digital
DESCRIPTION: Fynix Digital is a branding and marketing agency based in India. They specialize in brand strategy, UI/UX design, website development, SEO, and paid advertising for businesses of all sizes.

Website content:
{content_sample[:4000]}"""

        kwargs: dict = {
            "model": LLM_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 250,
            "metadata": metadata or {"generation_name": "company-context-extraction"},
            "fallbacks": LLM_FALLBACKS,
        }
        _apply_model_family_kwargs(kwargs, LLM_MODEL)
        response = litellm.completion(**kwargs)
        text = (response.choices[0].message.content or "").strip()
        if not text:
            return None

        # Parse structured response
        name = None
        description = None
        for line in text.splitlines():
            line = line.strip()
            if line.upper().startswith("NAME:"):
                name = line[5:].strip().strip('"')
            elif line.upper().startswith("DESCRIPTION:"):
                description = line[12:].strip().strip('"')

        if not name and not description and len(text) < 1000:
            # Fallback: treat entire response as description
            description = text

        result = {}
        if name and 2 <= len(name) <= 100:
            result["name"] = name
        if description and len(description) < 1000:
            result["description"] = description

        if result:
            logger.info(
                f"Company context extracted: name={result.get('name')}, desc={result.get('description', '')[:60]}..."
            )
            return result
        return None
    except Exception as e:
        logger.warning(f"Company context extraction failed (non-blocking): {e}")
        return None


_STREAM_CHUNK_TIMEOUT_S = 30


async def _stream_from_model(
    model: str,
    prompt: str,
    max_tokens: int | None,
    metadata: dict | None,
    temperature: float | None = None,
):
    """Async inner generator: stream chunks from ``model``, enforcing per-chunk timeout.

    Uses ``litellm.acompletion`` so the event loop is never blocked waiting for
    the next chunk. Each chunk read is wrapped in ``asyncio.wait_for`` so a
    stalled upstream connection (TCP open but no bytes flowing) raises
    ``TimeoutError`` within ``_STREAM_CHUNK_TIMEOUT_S`` seconds.

    Raises on connection / API error so the caller can fall back to another model.

    The underlying LiteLLM stream wrapper holds an httpx ``AsyncClient`` stream;
    if the SSE consumer disconnects mid-response the generator is closed via
    ``GeneratorExit`` and the httpx task leaks (Sentry: "Task was destroyed but
    it is pending!"). The ``finally`` block below explicitly aborts the wrapper.
    """
    kwargs: dict = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
        "metadata": metadata,
    }
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    if temperature is not None:
        kwargs["temperature"] = temperature
    _apply_model_family_kwargs(kwargs, model)
    response = await litellm.acompletion(**kwargs)
    try:
        response_iter = response.__aiter__()
        while True:
            try:
                chunk = await asyncio.wait_for(
                    response_iter.__anext__(),
                    timeout=_STREAM_CHUNK_TIMEOUT_S,
                )
            except StopAsyncIteration:
                break
            except TimeoutError as exc:
                raise TimeoutError(f"LLM chunk timeout after {_STREAM_CHUNK_TIMEOUT_S}s — upstream stalled") from exc
            content = chunk.choices[0].delta.content
            if content:
                yield content
    finally:
        aclose = getattr(response, "aclose", None)
        if aclose is not None:
            try:
                await aclose()
            except Exception as close_err:
                logger.debug(f"LiteLLM stream aclose() raised on cleanup: {close_err}")


async def generate_response_stream(
    prompt: str,
    *,
    max_tokens: int | None = None,
    temperature: float | None = None,
    metadata: dict | None = None,
):
    """Async generator: stream text chunks via LiteLLM.

    Fallback chain:
    1. Primary model (``LLM_MODEL`` — default: OpenAI gpt-5.4-mini)
    2. Fallback model (``FALLBACK_MODEL`` — default: Gemini 2.5 Flash) if primary raises
    3. Generic error message if both fail

    Each chunk read uses ``asyncio.wait_for`` so a stalled upstream TCP connection
    raises ``TimeoutError`` within ``_STREAM_CHUNK_TIMEOUT_S`` seconds instead of
    blocking the event loop forever.
    """
    if not PRIMARY_MODEL_KEY_SET:
        logger.error(f"Cannot stream response: API key for primary model '{LLM_MODEL}' is not set.")
        yield "Configuration error: AI service is not configured. Please contact the administrator."
        return

    logger.info(f"Starting LLM stream | model={LLM_MODEL} | prompt_length={len(prompt)}")
    try:
        async for chunk in _stream_from_model(LLM_MODEL, prompt, max_tokens, metadata, temperature):
            yield chunk
        return
    except TimeoutError as e:
        logger.error(str(e))
        yield " [Response timed out. Please try again.]"
        return
    except Exception as primary_err:
        logger.warning(
            f"Primary LLM stream failed ({type(primary_err).__name__}): {primary_err} "
            f"— attempting fallback to {FALLBACK_MODEL}"
        )

    # Fallback to secondary model
    if not FALLBACK_MODEL_KEY_SET:
        logger.error(f"Fallback model unavailable: API key for '{FALLBACK_MODEL}' is not set.")
        yield " [I encountered an error. Please try again.]"
        return

    try:
        logger.info(f"LLM stream fallback | model={FALLBACK_MODEL}")
        async for chunk in _stream_from_model(FALLBACK_MODEL, prompt, max_tokens, metadata, temperature):
            yield chunk
    except TimeoutError as e:
        logger.error(f"Fallback stream timed out: {e}")
        yield " [Response timed out. Please try again.]"
    except Exception as fallback_err:
        logger.error(
            f"Fallback LLM stream also failed ({type(fallback_err).__name__}): {fallback_err}",
            exc_info=True,
        )
        yield " [I encountered an error. Please try again.]"
