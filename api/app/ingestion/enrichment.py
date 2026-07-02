"""Contextual chunk enrichment for RAG ingestion.

Prepends a short LLM-generated context summary to each chunk before embedding.
Inspired by Anthropic's Contextual Retrieval technique — reported 49–67%
reduction in failed retrievals.

Feature flag: ``CHUNK_ENRICHMENT_ENABLED`` (default: false).
Model:        ``ENRICHMENT_MODEL`` (default: gemini/gemini-2.5-flash — cheapest capable).

Cost estimate: ~$0.001/chunk at ingestion (one-time per document).
A 50-page site with ~200 chunks ≈ $0.20 total.

Important: enrichment happens BEFORE embedding so the vector captures the
contextual summary. It does NOT replace the chunk text — it prepends
``[Context: <summary>]`` to it.
"""

import logging
import os
import time

import litellm

from app.core.langfuse_client import langfuse_generation

logger = logging.getLogger(__name__)

CHUNK_ENRICHMENT_ENABLED: bool = os.getenv("CHUNK_ENRICHMENT_ENABLED", "false").lower() in (
    "1",
    "true",
    "yes",
)
ENRICHMENT_MODEL: str = os.getenv("ENRICHMENT_MODEL", "gemini/gemini-2.5-flash")

# Keep enrichment summaries short — they're prepended to chunks for embedding
_SUMMARY_MAX_TOKENS = 80
# Inter-call delay (seconds) to avoid hitting rate limits on cheap models
_RATE_LIMIT_DELAY = 0.5


def _build_enrichment_prompt(chunk_text: str, document_summary: str) -> str:
    return f"""You are helping to improve document search. Given a document excerpt and the chunk of text below, write a 1-2 sentence context that explains what this chunk is about within the document. Be concise and factual.

Document excerpt (for context only):
{document_summary[:1500]}

Chunk to contextualize:
{chunk_text[:800]}

Respond with ONLY the 1-2 sentence context. No preamble, no labels."""


def enrich_chunk(chunk_text: str, document_summary: str) -> str:
    """Generate a short contextual summary for *chunk_text* and prepend it.

    Returns the original chunk unchanged on any LLM failure so ingestion
    is never blocked by enrichment errors.
    """
    if not chunk_text.strip() or not document_summary.strip():
        return chunk_text

    prompt = _build_enrichment_prompt(chunk_text, document_summary)
    try:
        with langfuse_generation("chunk-enrichment", model=ENRICHMENT_MODEL, prompt=prompt) as gen:
            response = litellm.completion(
                model=ENRICHMENT_MODEL,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=_SUMMARY_MAX_TOKENS,
                metadata={"generation_name": "chunk-enrichment"},
            )
            summary = (response.choices[0].message.content or "").strip()
            gen.record_litellm(response, output=summary)
        if summary and len(summary) < 500:
            return f"[Context: {summary}] {chunk_text}"
    except Exception as exc:
        logger.warning("Chunk enrichment failed (non-blocking): %s", exc)

    return chunk_text


def enrich_chunks_batch(chunks: list[str], document_summary: str) -> list[str]:
    """Enrich a list of chunks sequentially with a short inter-call delay.

    Parameters
    ----------
    chunks:
        Raw chunk text strings to enrich.
    document_summary:
        A representative excerpt from the full document used as context.
        Typically the first ~1500 chars of the cleaned document text.

    Returns
    -------
    list[str]
        Enriched chunk strings. Any chunk that failed enrichment is returned
        unchanged so ingestion continues unblocked.
    """
    if not CHUNK_ENRICHMENT_ENABLED or not chunks:
        return chunks

    enriched: list[str] = []
    for i, chunk in enumerate(chunks):
        enriched.append(enrich_chunk(chunk, document_summary))
        # Small delay between calls to avoid rate-limit bursts on cheap models
        if i < len(chunks) - 1:
            time.sleep(_RATE_LIMIT_DELAY)

    logger.info("Enriched %d/%d chunks", len(enriched), len(chunks))
    return enriched
