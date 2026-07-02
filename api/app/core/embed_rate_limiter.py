"""Project-wide throughput limiter for Gemini embedding requests.

Gemini's embedding quota is enforced **per project, per minute**, counting every
content item (not every HTTP batch call). Concurrent crawls — e.g. several
accounts ingesting at once — all draw from that one bucket, so uncoordinated
bursting slams into 429s and then wastes wall-clock sleeping on the server's
retry backoff. This limiter paces outbound requests to stay just under the quota
so the 429s never happen in the first place.

Backend, mirroring the rest of the codebase (see ``core/rate_limit.py`` and
``core/cache.py``):

- **Redis** when configured — a single atomic token bucket shared across every
  process (ARQ worker *and* the API's query-embedding path), so the limit is
  truly project-wide. This is the production path.
- **In-process** fallback otherwise (dev only) — a thread-safe bucket that still
  coordinates the worker's own embed threads.

The bucket uses *reservation* semantics: an ``acquire`` that can't be satisfied
now still succeeds, going into token debt and returning how long the caller must
sleep before proceeding. Concurrent callers therefore queue fairly and the
aggregate rate converges on the configured ceiling, with no re-check spin loop.
"""

import logging
import threading
import time

from app.config import EMBED_RATE_BURST, EMBED_RPM_LIMIT
from app.core.cache import PREFIX, get_redis

logger = logging.getLogger(__name__)

_KEY = f"{PREFIX}embed:rpm"
# A single acquire never sleeps longer than this; a wait that large means the
# bucket is badly misconfigured (or the clock jumped), so we fail open rather
# than stall ingestion indefinitely.
_MAX_WAIT_SECONDS = 300.0
# Reserved-token key expiry: comfortably longer than any real refill interval so
# an idle bucket is forgotten (and restarts at full capacity) but an active one
# never expires mid-crawl.
_KEY_TTL_MS = 120_000

# Atomic reservation token bucket. Returns the seconds the caller must wait
# (0 when tokens were available). Tokens may go negative — that debt is what
# makes the caller wait — and refill by elapsed·rate, capped at capacity.
_LUA_RESERVE = """
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * rate)
local wait = 0
if tokens < cost then
  wait = (cost - tokens) / rate
end
tokens = tokens - cost
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
return tostring(wait)
"""


class _TokenBucket:
    """Thread-safe reservation token bucket (in-process fallback).

    ``acquire`` is a pure state transition given ``now`` — it never sleeps — so
    the caller controls the clock and it is deterministically testable. Returns
    the seconds to wait before the reserved capacity is actually available.
    """

    def __init__(self, rate: float, capacity: float) -> None:
        self.rate = rate
        self.capacity = capacity
        self.tokens = capacity
        self._ts: float | None = None
        self._lock = threading.Lock()

    def acquire(self, cost: float, now: float) -> float:
        with self._lock:
            if self._ts is None:
                self._ts = now
            elapsed = max(0.0, now - self._ts)
            self._ts = now
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            wait = 0.0
            if self.tokens < cost:
                wait = (cost - self.tokens) / self.rate
            self.tokens -= cost  # reserve (may go negative — that is the debt)
            return wait


_local_bucket: _TokenBucket | None = None
_local_lock = threading.Lock()


def _rate_per_second() -> float:
    return EMBED_RPM_LIMIT / 60.0


def _get_local_bucket() -> _TokenBucket:
    global _local_bucket
    if _local_bucket is None:
        with _local_lock:
            if _local_bucket is None:
                _local_bucket = _TokenBucket(_rate_per_second(), float(EMBED_RATE_BURST))
    return _local_bucket


def _reserve_wait(cost: int, rate: float) -> float:
    """Reserve ``cost`` request-units and return the seconds to wait.

    Prefers the shared Redis bucket; degrades to the in-process bucket if Redis
    is unconfigured or errors (best-effort, matching ``core/cache.py``).
    """
    client = get_redis()
    if client is not None:
        try:
            raw = client.eval(
                _LUA_RESERVE,
                1,
                _KEY,
                rate,
                EMBED_RATE_BURST,
                cost,
                time.time(),
                _KEY_TTL_MS,
            )
            return max(0.0, float(raw))
        except Exception:
            logger.debug("embed rate limiter: Redis path failed, using in-process bucket", exc_info=True)
    return _get_local_bucket().acquire(float(cost), time.monotonic())


def acquire(cost: int) -> None:
    """Block until ``cost`` embedding request-units fit under the RPM ceiling.

    ``cost`` is the number of content items in the batch — each counts as one
    request against Gemini's per-minute quota. A non-positive cost or a
    disabled limit (``EMBED_RPM_LIMIT <= 0``) is a no-op.
    """
    if cost <= 0:
        return
    rate = _rate_per_second()
    if rate <= 0:
        return
    wait = _reserve_wait(cost, rate)
    if wait > 0:
        if wait > _MAX_WAIT_SECONDS:
            logger.warning(
                "embed rate limiter: computed wait %.1fs exceeds cap %.0fs — proceeding without full throttle",
                wait,
                _MAX_WAIT_SECONDS,
            )
            wait = _MAX_WAIT_SECONDS
        time.sleep(wait)
