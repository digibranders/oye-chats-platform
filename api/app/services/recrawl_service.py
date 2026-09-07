"""Auto-recrawl service. Weekly refresh of a bot's previously-crawled URLs.

The customer-facing feature is simple: toggle it on, and every 7 days the
platform re-fetches every URL that was previously ingested for the bot,
re-embedding only pages whose content actually changed. Free / Starter
plans see the toggle locked; Standard / Professional plans have the
``auto_recrawl`` feature flag flipped on in ``plans.features``.

Under the hood the whole "only changed pages" contract is inherited for
free from :func:`app.ingestion.pipeline.batch_web_ingestion`:

1. The URL list is loaded from ``documents``. ``SELECT DISTINCT
   document_name WHERE bot_id = X AND source = 'crawl'``.  Uploaded files
   are excluded by the ``source`` discriminator, so PDFs / DOCX / TXT
   never spuriously appear in the recrawl set.
2. Pages are fetched via :func:`app.services.crawl_provider.fetch_urls`,
   which is the same primary+fallback provider chain the interactive
   crawl uses. A per-URL fetch failure surfaces as a missing entry in
   the returned ``results`` list; we tally those and keep going.
3. Fetched pages are handed to ``batch_web_ingestion`` with
   ``cost_per_page=0`` so the customer's credit ledger is untouched, a
   recrawl is funded by the subscription, not billed per page. The
   pipeline hashes each page (boilerplate-normalised, so "© 2025 → 2026"
   doesn't count as a change), skips ones that match a prior hash, and
   replaces stale chunks in-place for the ones that did change.
4. URLs the refetch could not deliver are probed directly. A page the
   origin answers 404/410 for has been removed from the site, so its
   chunks are deleted and its characters handed back to the knowledge
   quota, the same sequence the interactive crawl's orphan sweep runs.
   Anything less definitive (a timeout, a 5xx, a blocked probe) is kept
   and reported under ``failed``. Removals are capped per run, see
   :func:`_removal_cap`.

The service returns a summary the admin card renders back to the
customer verbatim. ``changed_pages`` counts URLs that produced new
chunks, ``unchanged_pages`` counts URLs the hash dedup skipped,
``removed_pages`` counts URLs whose chunks were deleted because the page
is gone, and ``failed_urls`` / ``removed_urls`` retain up to
``_MAX_ERRORS_IN_SUMMARY`` samples so a support ticket has evidence
without blowing up the JSONB column.
"""

from __future__ import annotations

import asyncio
import logging
import random
from datetime import UTC, datetime, timedelta
from functools import partial

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Bot, Document
from app.db.repository import delete_chunks_for_url
from app.db.session import get_session
from app.ingestion.pipeline import batch_web_ingestion
from app.services.crawl_provider import fetch_urls
from app.services.crawler_service import (
    acquire_crawl_lock,
    clear_cancellation,
    is_cancellation_requested,
    release_crawl_lock,
)
from app.services.knowledge_quota_service import release_kb_usage_for_sources
from app.services.url_discovery import check_urls_alive, removal_cap

logger = logging.getLogger(__name__)


# Weekly cadence is a hard product decision for the launch cut, no per-bot
# override yet. Kept as a module constant so a future ``recrawl_cadence_days``
# column can drop in without a service rewrite.
RECRAWL_CADENCE_DAYS: int = 7

# Random 0..N-hour jitter added on top of the 7-day cadence when computing the
# next scheduled recrawl. Prevents a cohort of bots toggled on in the same
# sitting from stampeding the crawl provider (and each other) on the same UTC
# hour a week later. See the pathological "10 bots enabled in a 30-minute
# window all recrawl in the same sweep tick" analysis. 24 h spreads a
# full-day cohort evenly across a day; tests monkeypatch this to 0 for
# deterministic ``compute_next_recrawl_at`` behaviour.
RECRAWL_JITTER_HOURS: float = 24.0

# Cap on how many failure samples we retain in ``last_recrawl_summary`` so a
# bot with 500 broken URLs doesn't produce a 200KB JSONB row. The admin UI
# shows the tail only as evidence for support; the total ``failed`` count is
# still the authoritative number.
_MAX_ERRORS_IN_SUMMARY: int = 10

# How many past runs the ``bot.recrawl_history`` rolling window retains.
# Twenty is roughly five months of weekly runs. Enough for the admin
# expander to show meaningful trends while keeping the JSONB row well
# under a page.
_MAX_HISTORY_ENTRIES: int = 20


def _removal_cap(total_urls: int) -> int:
    """How many confirmed-gone pages one run may remove: ``max(5, 20%)`` of the
    bot's URLs. The rule lives in ``url_discovery.removal_cap`` so the
    interactive crawl's orphan sweep applies exactly the same valve."""
    return removal_cap(total_urls)


async def _confirm_gone(urls: list[str]) -> list[str]:
    """Return the subset of ``urls`` whose origin answers 404 or 410, in input order.

    A URL missing from the provider's results only means the provider did not
    deliver it: a timeout, a bot-blocking firewall, a 5xx during a deploy.
    None of those is grounds to forget what the page said. ``check_urls_alive``
    probes the origin directly and calls a page dead only on a definitive
    404/410; everything else, including a probe failure, keeps the page.
    """
    if not urls:
        return []
    try:
        liveness = await check_urls_alive(urls)
    except Exception:  # noqa: BLE001  a failed probe must keep every page, never fail the run
        logger.exception("recrawl: liveness probe failed for %d urls; keeping all of them", len(urls))
        return []
    return [u for u in urls if liveness.get(u, True) is False]


def _remove_gone_pages(*, client_id: int, bot_id: int, urls: list[str]) -> tuple[list[str], int]:
    """Delete every chunk stored for ``urls`` and hand their characters back to the KB quota.

    Same sequence as the interactive crawl's orphan sweep
    (``crawl_orchestrator``): release the quota FIRST, because the character
    count lives on the rows about to go, then delete per URL. One transaction,
    so either every listed page is gone or none is and the summary never
    claims a removal that rolled back. Returns ``(removed_urls, chunks_removed)``.
    """
    if not urls:
        return [], 0
    chunks_removed = 0
    freed = 0
    try:
        with get_session() as session:
            freed = release_kb_usage_for_sources(session, client_id=client_id, bot_id=bot_id, document_names=urls)
            for url in urls:
                deleted = delete_chunks_for_url(session, url, bot_id=bot_id, client_id=client_id)
                chunks_removed += deleted
                logger.info(
                    "recrawl_bot: removed %s for bot %s (%d chunks); the page now answers 404/410",
                    url,
                    bot_id,
                    deleted,
                )
            session.commit()
    except Exception:  # noqa: BLE001  the summary must still be written
        logger.exception(
            "recrawl_bot: removing %d gone pages failed for bot %s; nothing was deleted", len(urls), bot_id
        )
        return [], 0
    logger.info(
        "recrawl_bot: bot %s: %d pages removed (%d chunks, %d KB chars reclaimed)",
        bot_id,
        len(urls),
        chunks_removed,
        freed,
    )
    return list(urls), chunks_removed


def _load_crawl_urls_for_bot(session: Session, bot_id: int) -> list[str]:
    """Return the deduped list of URLs previously crawled for the bot.

    Uploaded files (``source='upload'``) are excluded. Auto-recrawl only
    refreshes URLs, not customer-uploaded PDFs / DOCX. Empty strings and
    NULLs are filtered out so a corrupt legacy row can't crash the fetch.
    """
    rows = (
        session.execute(
            select(Document.document_name)
            .where(
                Document.bot_id == bot_id,
                Document.source == "crawl",
                Document.document_name.is_not(None),
            )
            .distinct()
        )
        .scalars()
        .all()
    )
    return [url for url in rows if url]


def compute_next_recrawl_at(now: datetime) -> datetime:
    """Return the next scheduled recrawl timestamp (UTC).

    Kept as a helper so the API route (which sets the initial
    ``next_recrawl_at`` on toggle-on) and the worker task (which sets it
    after a successful recrawl) always compute the same value.

    Adds a random 0..``RECRAWL_JITTER_HOURS`` hour offset on top of the
    weekly cadence so a cohort of bots enabled together doesn't remain
    clustered on the same UTC hour forever. Uses ``random.uniform`` from
    the module-level ``random`` so tests can monkeypatch it for
    determinism (``monkeypatch.setattr(recrawl_service, "random", …)``
    or ``random.seed(...)``).
    """
    jitter_hours = random.uniform(0.0, RECRAWL_JITTER_HOURS) if RECRAWL_JITTER_HOURS > 0 else 0.0
    return now + timedelta(days=RECRAWL_CADENCE_DAYS, hours=jitter_hours)


async def _fetch_pages(urls: list[str], client_id: int) -> tuple[list[dict], list[str]]:
    """Fetch the URL list via the primary crawl provider.

    Returns ``(pages, failed_urls)``. ``pages`` are the ``batch_web_ingestion``
    input shape ``{"url", "content"}``, ``failed_urls`` is every input URL
    that didn't come back with usable content.
    """
    try:
        result = await fetch_urls(urls, client_id=client_id, use_js=False)
    except Exception:  # noqa: BLE001  one bad provider must not abort the whole recrawl
        logger.exception("recrawl fetch failed for client=%s", client_id)
        return [], list(urls)

    fetched_pages: list[dict] = []
    for page in result.get("results", []):
        url = page.get("url")
        # Every current provider (Spider, Jina) writes the cleaned page body
        # under ``content``, the payload shape docstring on
        # ``jina_service.fetch_urls`` is the canonical contract. The
        # ``text`` / ``html`` fallbacks are here for a legacy provider that
        # never actually reached prod; without ``content`` as the primary
        # read, every recrawl silently marked every URL failed even though
        # the provider fetched them successfully.
        content = page.get("content") or page.get("text") or page.get("html") or ""
        if not url or not content.strip():
            continue
        fetched_pages.append({"url": url, "content": content})

    fetched_urls = {p["url"] for p in fetched_pages}
    failed_urls = [u for u in urls if u not in fetched_urls]
    return fetched_pages, failed_urls


def _classify_status(changed: int, failed: int, total: int) -> str:
    """Map the recrawl outcome to a single-word status the UI renders.

    * ``empty``   (bot has no crawled URLs to refresh
    * ``failed``) every URL failed to fetch or ingest
    * ``partial`` (at least one URL failed, but some succeeded
    * ``success``) every URL fetched cleanly (some may have been unchanged)
    """
    if total == 0:
        return "empty"
    if failed == total:
        return "failed"
    if failed > 0:
        return "partial"
    return "success"


async def recrawl_bot(bot_id: int) -> dict:
    """Refresh every previously-crawled URL for the given bot.

    Returns a summary dict which is also persisted onto
    ``Bot.last_recrawl_summary``. Never raises. Every internal failure is
    tallied into the summary so the sweep task can commit a clean row and
    reschedule the next run without unwinding.
    """
    now = datetime.now(UTC)

    with get_session() as session:
        bot = session.get(Bot, bot_id)
        if bot is None:
            logger.warning("recrawl_bot: bot %s not found", bot_id)
            return {"status": "not_found"}
        client_id = bot.client_id
        urls = _load_crawl_urls_for_bot(session, bot_id)

    if not urls:
        summary = {
            "total_urls": 0,
            "changed_pages": 0,
            "unchanged_pages": 0,
            "failed": 0,
            "failed_urls": [],
            "chunks_updated": 0,
            "removed_pages": 0,
            "removed_urls": [],
            "chunks_removed": 0,
        }
        _persist_summary(bot_id, summary, "empty", now)
        return {"status": "empty", **summary}

    # Serialize auto-recrawl against interactive crawls and other recrawls for
    # this client using the same per-client lock the interactive path uses
    # (``document_routes.py``). Without it, a concurrent auto+manual crawl
    # double-ingests the same URLs → duplicate chunks that permanently
    # degrade retrieval (there is no unique index on Document to catch it at
    # the DB layer).
    lock_token = acquire_crawl_lock(client_id, kind="recrawl")
    if lock_token is None:
        logger.info(
            "recrawl_bot: a crawl is already in progress for client %s (bot %s). Skipping this cycle",
            client_id,
            bot_id,
        )
        # Do NOT persist a summary: leaving next_recrawl_at untouched (still
        # due) means the next hourly sweep retries this bot once the lock
        # frees, instead of parking it for a full 7-day interval.
        return {"status": "skipped", "reason": "crawl_in_progress"}

    # Clear any cancel flag left by a PREVIOUSLY-timed-out interactive preemption
    # (the flag self-expires after ~27min, so a stale one could still be set).
    # Clearing here means only a cancellation requested AFTER this recrawl began
    # . I.e. a fresh interactive crawl preempting us. Is honoured below.
    clear_cancellation(client_id)

    try:
        fetched_pages, failed_fetch = await _fetch_pages(urls, client_id)

        # Yield to an interactive crawl that preempted us. The user-initiated
        # crawl set the cancel flag and is now waiting (bounded) for our lock;
        # honour it before ingesting so we don't double-write chunks. Return
        # WITHOUT persisting a summary so ``next_recrawl_at`` stays due and the
        # next hourly sweep retries this bot once the interactive crawl finishes.
        # ``_fetch_pages`` already aborts early on cancellation via the provider's
        # cancel checks, so this post-fetch check catches the preemption promptly.
        # The ``finally`` releases the lock so the waiting crawl can acquire it.
        if is_cancellation_requested(client_id):
            logger.info(
                "recrawl_bot: preempted by an interactive crawl for client %s (bot %s). Yielding",
                client_id,
                bot_id,
            )
            return {"status": "preempted", "reason": "interactive_crawl"}

        # ``batch_web_ingestion`` is synchronous / DB-bound. Hop to a thread so
        # we don't block the ARQ event loop while the embedding provider works.
        def _do_ingest() -> dict:
            return batch_web_ingestion(
                client_id,
                fetched_pages,
                bot_id=bot_id,
                cost_per_page=0,  # auto-recrawl is funded by the subscription, not per-page.
                deduct_reason="auto_recrawl",
            )

        loop = asyncio.get_running_loop()
        if fetched_pages:
            try:
                ingest_result = await loop.run_in_executor(None, _do_ingest)
            except Exception:  # noqa: BLE001
                logger.exception("recrawl_bot: ingestion failed for bot %s", bot_id)
                ingest_result = {
                    "chunks": 0,
                    "pages_changed": 0,
                    "pages_charged": 0,
                    "credits_deducted": 0,
                    "aborted": True,
                }
        else:
            ingest_result = {
                "chunks": 0,
                "pages_changed": 0,
                "pages_charged": 0,
                "credits_deducted": 0,
                "aborted": False,
            }

        # ``pages_changed`` is the honest count of pages that made it past the
        # hash-skip AND had their fresh chunks successfully committed. It's the
        # right signal here because auto-recrawl runs with ``cost_per_page=0``,
        # so ``pages_charged`` is always 0 and can't stand in for "how many
        # pages changed" like it does on the paid interactive-crawl path.
        total_chunks = int(ingest_result.get("chunks") or 0)
        changed_pages = int(ingest_result.get("pages_changed") or 0)

        # Pages the site itself says are gone. The refetch above only ever
        # touches URLs the bot already stores, so a page the customer deleted
        # was refetched, failed, tallied under ``failed`` and kept its chunks
        # for good: the bot went on quoting a retired offer, week after week.
        # A page is removed only when the origin answers 404/410 for it, only
        # when this run fetched at least one page (a run that fetched nothing
        # has proven nothing about the site), and never more than
        # ``_removal_cap`` pages per run. A preempting interactive crawl runs
        # its own orphan sweep with the complete page list, so nothing is
        # deleted under its feet.
        removed_urls: list[str] = []
        chunks_removed = 0
        if fetched_pages and failed_fetch and not is_cancellation_requested(client_id):
            gone = await _confirm_gone(failed_fetch)
            cap = _removal_cap(len(urls))
            if len(gone) > cap:
                logger.warning(
                    "recrawl_bot: %d of %d urls for bot %s answer 404/410; removing %d this run (cap), "
                    "the rest stay until the next run",
                    len(gone),
                    len(urls),
                    bot_id,
                    cap,
                )
            to_remove = gone[:cap]
            if to_remove:
                removed_urls, chunks_removed = await loop.run_in_executor(
                    None, partial(_remove_gone_pages, client_id=client_id, bot_id=bot_id, urls=to_remove)
                )
        # A removed page is a handled outcome, not a failure to report.
        removed_set = set(removed_urls)
        still_failed = [u for u in failed_fetch if u not in removed_set]

        fetched_count = len(fetched_pages)
        unchanged_pages = max(0, fetched_count - changed_pages)
        failed_count = len(still_failed)

        summary = {
            "total_urls": len(urls),
            "changed_pages": changed_pages,
            "unchanged_pages": unchanged_pages,
            "failed": failed_count,
            "failed_urls": still_failed[:_MAX_ERRORS_IN_SUMMARY],
            "chunks_updated": total_chunks,
            "removed_pages": len(removed_urls),
            "removed_urls": removed_urls[:_MAX_ERRORS_IN_SUMMARY],
            "chunks_removed": chunks_removed,
        }
        status = _classify_status(changed=changed_pages, failed=failed_count, total=len(urls))
        _persist_summary(bot_id, summary, status, now)
        return {"status": status, **summary}
    finally:
        release_crawl_lock(client_id, lock_token)


def _persist_summary(bot_id: int, summary: dict, status: str, now: datetime) -> None:
    """Write the completion state back to the Bot row.

    Bumps ``last_recrawl_at`` to ``now`` and schedules the next sweep for
    ``now + 7 days``, the sweep query relies on ``next_recrawl_at``, so a
    completed run must always advance it or the row would re-match on
    every hourly tick.
    """
    with get_session() as session:
        bot = session.get(Bot, bot_id)
        if bot is None:
            return
        bot.last_recrawl_at = now
        bot.last_recrawl_status = status
        bot.last_recrawl_summary = summary
        bot.next_recrawl_at = compute_next_recrawl_at(now)

        # Append this run to the rolling history (newest first, capped at
        # ``_MAX_HISTORY_ENTRIES``). SQLAlchemy's JSONB change tracking
        # doesn't fire on in-place mutation of the existing list, so a
        # fresh list assignment is required for the update to flush.
        history_entry = {
            "ran_at": now.isoformat(),
            "status": status,
            "total": int(summary.get("total_urls") or 0),
            "unchanged": int(summary.get("unchanged_pages") or 0),
            "changed": int(summary.get("changed_pages") or 0),
            "failed": int(summary.get("failed") or 0),
            "removed": int(summary.get("removed_pages") or 0),
        }
        bot.recrawl_history = [history_entry, *(bot.recrawl_history or [])][:_MAX_HISTORY_ENTRIES]

        session.commit()
