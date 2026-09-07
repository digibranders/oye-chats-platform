"""FlashRank cross-encoder reranker.

Lazy-loads the ms-marco-TinyBERT-L-2-v2 model on first use (~8 MB RAM).
The model stays resident in memory for the lifetime of the process.

Feature flag: ``RERANK_ENABLED`` (default: false).
Set ``RERANK_ENABLED=true`` in .env to activate.

Falls back silently to the original document order on any error so the
RAG pipeline is never blocked by a reranker failure.

AR-39: investigating whether to A/B-enable ``RERANK_ENABLED`` found a more
fundamental bug first, the model name previously requested here,
``ms-marco-MiniLM-L-2-v2``, is not a real FlashRank model (it doesn't exist
in flashrank's own ``model_file_map``; confirmed the HuggingFace zip 404s).
The reranker had been silently non-functional in EVERY environment since it
was added: `_get_ranker()`'s own well-designed transient-failure handling
made this invisible (fails open to unchanged RRF order every call, with
only a warning log), and since ``RERANK_ENABLED`` defaults false, no request
path was affected, but any admin who turned the flag on to test reranking
would have gotten zero actual reranking, silently, forever. Fixed to
``ms-marco-TinyBERT-L-2-v2``, the smallest real model in flashrank's map,
matching the original ~8MB-model intent, and confirmed to load successfully
(see the AR-39 A/B result below on whether to also flip the default).
"""

import logging
import os

from app.services import runtime_config

logger = logging.getLogger(__name__)

# AR-39 decision: kept the DEFAULT at false. A manual A/B check after fixing
# the model-name bug above showed real, correct-direction reordering (e.g. a
# "business hours" query moved the actual hours document from rank 5 to
# rank 1 ahead of unrelated pricing/team docs). Reranking works and helps
# once the model loads. But flipping the global default adds cross-encoder
# inference latency + an ~8MB resident model to every query for every
# existing customer; that's a product/latency tradeoff needing sign-off, not
# something to change unilaterally in a bug-fix pass. Recommend enabling via
# this env var for a real production A/B once the fixed model name has
# baked, rather than flipping the default here.
RERANK_ENABLED: bool = os.getenv("RERANK_ENABLED", "false").lower() in ("1", "true", "yes")
# Env default only. The effective value is resolved per call by
# ``_resolve_top_n`` through the super-admin runtime knob.
RERANK_TOP_N: int = int(os.getenv("RERANK_TOP_N", "5"))


def _resolve_top_n(top_n: int | None) -> int:
    """How many documents to keep for this call.

    An explicit ``top_n`` wins. Otherwise the super-admin runtime knob
    (``rag.rerank_top_n`` in pricing_config, read through ``runtime_config``)
    applies, falling back to the ``RERANK_TOP_N`` env default. Resolved per
    call, not at import: the knob was previously never read here, so the
    dashboard control saved a value nothing used, the same decorative-control
    shape as the AR-05 gate-model bug. Floored at 1 so a bad value can never
    empty the context handed to generation.
    """
    if top_n is not None:
        return max(1, int(top_n))
    return max(1, runtime_config.get_rerank_top_n(RERANK_TOP_N))


# Lazy singleton. Loaded once on first rerank() call
_ranker = None
_ranker_unavailable: bool = False


def _get_ranker():
    """Return the FlashRank Ranker singleton, or None if unavailable.

    Failure handling distinguishes two cases:

    * ``ImportError``, the ``flashrank`` package isn't installed. This will
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

        _ranker = Ranker(model_name="ms-marco-TinyBERT-L-2-v2", cache_dir="/tmp/flashrank_cache")
        logger.info("FlashRank reranker loaded (ms-marco-TinyBERT-L-2-v2)")
        return _ranker
    except ImportError as exc:
        logger.warning(
            "FlashRank package not installed. Reranking permanently disabled this process: %s",
            exc,
        )
        _ranker_unavailable = True
        return None
    except Exception as exc:
        logger.warning(
            "FlashRank load failed (transient. Will retry on next call): %s",
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
        How many to keep. Defaults to the super-admin runtime knob
        (``rag.rerank_top_n``), then the ``RERANK_TOP_N`` env var (5); see
        :func:`_resolve_top_n`.

    Returns
    -------
    list
        Reranked subset of *documents* (most relevant first).
        Returns the original list (up to top_n) unchanged if reranking fails.
    """
    effective_top_n = _resolve_top_n(top_n)

    if not RERANK_ENABLED or not documents:
        return documents[:effective_top_n]

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
