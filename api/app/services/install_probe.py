"""Runs an install check across every domain one chatbot is associated with.

Ties together the three pieces that have no business knowing about each other:
:mod:`app.services.install_detection` (fetch a page, read the markup),
:mod:`app.services.install_registry` (store a verdict), and the account's own
configuration (which domains are worth checking at all).

**On demand only.** There is no cron here, deliberately. This makes OyeChats
fetch a customer's website, which will appear in their access logs and which
some customers would reasonably consider crawling they never asked for. Running
it only when someone presses the button on their own Deploy page means the
request is always something the account holder just asked for. A schedule is a
product decision — it needs an opt-in, and it needs someone to decide who pays
for the egress — and it is not one to make by quietly adding a cron.
"""

from __future__ import annotations

import asyncio
import logging

from app.core.cache import PREFIX, get_redis
from app.core.origin_check import extract_hostname
from app.db.models import Bot
from app.db.session import get_session
from app.services.install_detection import MAX_DOMAINS_PER_RUN, probe_domain
from app.services.install_registry import list_domain_installs, record_probe_result

logger = logging.getLogger(__name__)

# How many domains are fetched at once. Small: these are third-party sites, and
# a check of one account should not look like a burst to any of them.
_PROBE_CONCURRENCY = 4

# How long the "a check is running" flag survives if the run dies without
# clearing it. Comfortably longer than the worst case
# (MAX_DOMAINS_PER_RUN / _PROBE_CONCURRENCY x PROBE_TIMEOUT_SECONDS) so the flag
# never expires under a slow but healthy run, and short enough that a crashed
# worker cannot leave the button disabled for long.
_RUNNING_TTL_SECONDS = 300


def _running_key(bot_id: int) -> str:
    return f"{PREFIX}install-probe:{bot_id}"


def probe_is_running(bot_id: int) -> bool:
    """Whether a check for this chatbot is in flight.

    Best-effort: with no Redis the answer is "no", and the worst outcome is a
    customer able to start a second check. That is a wasted fetch, not a
    correctness problem, and it is a far better failure than a button that
    stays disabled because a flag could not be cleared.
    """
    redis = get_redis()
    if redis is None:
        return False
    try:
        return bool(redis.get(_running_key(bot_id)))
    except Exception:
        return False


def _mark_running(bot_id: int, running: bool) -> None:
    redis = get_redis()
    if redis is None:
        return
    try:
        if running:
            redis.set(_running_key(bot_id), "1", ex=_RUNNING_TTL_SECONDS)
        else:
            redis.delete(_running_key(bot_id))
    except Exception:
        logger.debug("could not update the probe flag for bot %s", bot_id, exc_info=True)


def probe_targets(bot: Bot, observed: list[str]) -> list[str]:
    """Which hostnames a check should actually fetch.

    Three sources, in descending order of "the customer told us this matters":

    1. ``allowed_domains`` — the domains they explicitly authorised. This is the
       list the card claims to have checked, so it goes first.
    2. the chatbot's own ``website`` — configured at signup and very often the
       only domain that exists, since the allow-list defaults empty.
    3. hostnames already observed — where the widget has actually called from,
       which catches a live domain nobody remembered to allow-list.

    Wildcards are dropped rather than expanded. ``*.acme.com`` is not a
    hostname, and there is no way to enumerate what it covers; the apex is
    checked instead when it is separately listed.
    """
    targets: list[str] = []

    def _add(candidate: str | None) -> None:
        if not candidate:
            return
        host = candidate.strip().lower()
        if host.startswith("*."):
            return
        # Accepts both a bare host and a full URL, so the `website` column's
        # `https://acme.com/` and the allow-list's `acme.com` converge.
        host = extract_hostname(host) or extract_hostname(f"https://{host}") or ""
        if host and host not in targets:
            targets.append(host)

    for entry in bot.allowed_domains or []:
        _add(entry)
    _add(getattr(bot, "website", None))
    for host in observed:
        _add(host)

    return targets[:MAX_DOMAINS_PER_RUN]


async def _probe_all(bot_key: str, hostnames: list[str]):
    import aiohttp

    semaphore = asyncio.Semaphore(_PROBE_CONCURRENCY)
    timeout = aiohttp.ClientTimeout(total=30)
    headers = {
        # Identify honestly. A customer reading their access log should be able
        # to tell that this fetch was their own dashboard, not an anonymous
        # scraper, and see where to ask about it.
        "User-Agent": "OyeChatsInstallCheck/1.0 (+https://www.oyechats.com/)",
        "Accept": "text/html,application/xhtml+xml",
    }

    async with aiohttp.ClientSession(headers=headers, timeout=timeout) as session:

        async def _one(hostname: str):
            async with semaphore:
                return await probe_domain(session, hostname, bot_key)

        return await asyncio.gather(*[_one(h) for h in hostnames])


async def probe_bot_installs(bot_id: int) -> dict:
    """Check every domain for one chatbot and store the verdicts.

    Returns a small summary for the caller's log. Never raises: this runs
    detached from the request that asked for it, and a failure has to leave the
    dashboard readable rather than half-updated.
    """
    _mark_running(bot_id, True)
    try:
        with get_session() as session:
            bot = session.get(Bot, bot_id)
            if bot is None:
                return {"checked": 0, "reason": "no such chatbot"}
            bot_key = bot.bot_key
            observed = [row.hostname for row in list_domain_installs(session, bot_id) if row.observed_last_at]
            targets = probe_targets(bot, observed)

        if not targets:
            return {"checked": 0, "reason": "no domains to check"}

        results = await _probe_all(bot_key, targets)

        with get_session() as session:
            for result in results:
                record_probe_result(
                    session,
                    bot_id,
                    hostname=result.hostname,
                    status=result.status,
                    bot_key=result.bot_key,
                    detail=result.detail,
                )
            session.commit()

        summary: dict = {"checked": len(results)}
        for result in results:
            summary[result.status] = summary.get(result.status, 0) + 1
        logger.info("install probe for bot %s: %s", bot_id, summary)
        return summary
    except Exception:
        logger.warning("install probe failed for bot %s", bot_id, exc_info=True)
        return {"checked": 0, "reason": "the check could not be completed"}
    finally:
        _mark_running(bot_id, False)


def run_install_probe_sync(bot_id: int) -> dict:
    """Blocking entry point for the no-worker path.

    ``WORKER_ENABLED`` defaults to false, and the house convention on that path
    is to run the work in-process rather than queue it against a queue nobody
    drains. One implementation, two callers, so the two paths cannot drift into
    different behaviour behind the same button.
    """
    return asyncio.run(probe_bot_installs(bot_id))
