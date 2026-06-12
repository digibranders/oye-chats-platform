"""FlashRank cross-encoder reranker.

Lazy-loads the ms-marco-MiniLM-L-2-v2 model on first use (~8 MB RAM).
The model stays resident in memory for the lifetime of the process.

Feature flag: ``RERANK_ENABLED`` (default: false).
Set ``RERANK_ENABLED=true`` in .env to activate.

Falls back silently to the original document order on any error so the
RAG pipeline is never blocked by a reranker failure.
"""

import logging
import os

logger = logging.getLogger(__name__)

RERANK_ENABLED: bool = os.getenv("RERANK_ENABLED", "false").lower() in ("1", "true", "yes")
RERANK_TOP_N: int = int(os.getenv("RERANK_TOP_N", "5"))

# Lazy singleton — loaded once on first rerank() call
_ranker = None
_ranker_unavailable: bool = False


def _get_ranker():
    """Return the FlashRank Ranker singleton, or None if unavailable.

    Failure handling distinguishes two cases:

    * ``ImportError`` — the ``flashrank`` package isn't installed. This will
      not recover without a redeploy, so we sticky-disable to avoid spamming
      logs every request.
    * Any other exception (model file missing, OOM, transient ``/tmp`` wipe)
      is treated as **transient**: we log a warning but DO NOT sticky-disable,
      so the next request retries the load. Previously a single transient
      error silently disabled reranking for the entire process lifetime and
      degraded RAG quality with no visibility.
    """
    global _ranker, _ranker_unavailable

    if _ranker_unavailable:
        return None
    if _ranker is not None:
        return _ranker

    try:
        from flashrank import Ranker

        _ranker = Ranker(model_name="ms-marco-MiniLM-L-2-v2", cache_dir="/tmp/flashrank_cache")
        logger.info("FlashRank reranker loaded (ms-marco-MiniLM-L-2-v2)")
        return _ranker
    except ImportError as exc:
        logger.warning(
            "FlashRank package not installed — reranking permanently disabled this process: %s",
            exc,
        )
        _ranker_unavailable = True
        return None
    except Exception as exc:
        logger.warning(
            "FlashRank load failed (transient — will retry on next call): %s",
            exc,
        )
        return None


def rerank(query: str, documents: list, top_n: int | None = None) -> list:
    """Rerank *documents* for *query* using a cross-encoder and return top_n.

    Parameters
    ----------
    query:
        The user question (after any rewriting).
    documents:
        List of OyeChats ``Document`` model objects (must have ``.content``).
    top_n:
        How many to keep. Defaults to ``RERANK_TOP_N`` env var (5).

    Returns
    -------
    list
        Reranked subset of *documents* (most relevant first).
        Returns the original list (up to top_n) unchanged if reranking fails.
    """
    if not RERANK_ENABLED or not documents:
        return documents[: top_n or RERANK_TOP_N]

    effective_top_n = top_n if top_n is not None else RERANK_TOP_N

    ranker = _get_ranker()
    if ranker is None:
        # Surface the skip so silent quality degradation is observable.
        logger.info("rerank_skipped: ranker unavailable, returning RRF order (top_n=%d)", effective_top_n)
        return documents[:effective_top_n]

    try:
        from flashrank import RerankRequest

        passages = [{"id": i, "text": doc.content} for i, doc in enumerate(documents)]
        request = RerankRequest(query=query, passages=passages)
        results = ranker.rerank(request)

        # results is a list of dicts sorted by score descending
        reranked: list = []
        for result in results[:effective_top_n]:
            original_idx = result["id"]
            reranked.append(documents[original_idx])

        logger.debug(
            "Reranked %d → %d docs for query=%r",
            len(documents),
            len(reranked),
            query[:60],
        )
        return reranked

    except Exception as exc:
        logger.warning("Reranking failed, using original order: %s", exc)
        return documents[:effective_top_n]
