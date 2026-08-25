"""Lightweight Redis-backed counters for safety-net / hallucination-guard events.

AR-13: `_safety_net_metric` (rag_service.py) previously only emitted a
`logger.info` line, no counter, no consumer, no alert. A provider error-rate
spike, quota exhaustion, or 100% empty-retrieval rate on a bot's KB pages no
one; the first signal was a customer complaint.

This module does NOT stand up a new observability stack (Prometheus/Grafana)
- that's a larger infra decision for ops to make, and this codebase has no
metrics backend today beyond structured logs + Sentry. Instead it adds the
smallest useful piece: per-hour rolling counts in Redis (already the app's
existing cache dependency, no new infra), queryable via a super-admin
endpoint, plus forwarding security-relevant events to Sentry so the
platform's ALREADY-established alert channel (Sentry -> Slack) can page on
them. Closing "no consumer/counter/alert" without inventing a new one.
"""

import logging
from datetime import UTC, datetime, timedelta

from app.core.cache import get_redis

logger = logging.getLogger(__name__)

_COUNTER_TTL_SECONDS = 60 * 60 * 26  # a little over 24h so a 24h window query never undercounts due to expiry

# Metric names that warrant forwarding to Sentry (security/abuse-relevant,
# the classes AR-13/AR-18 flag as needing paging, not just counting).
_SENTRY_FORWARD_METRICS = frozenset(
    {
        "injection_attempt",
        "system_prompt_leak",
        "moderation_block",
        # AR-46: the model actually GENERATED content flagged under
        # moderation categories, a jailbreak succeeded, not just an
        # attempt. Page on it like the other security events here.
        "output_moderation_block",
        # AR-15: a misconfiguration-class LLM error (revoked key, bad request)
        # needs a human, not a retry. Page on it like the security events above.
        "llm_config_error",
        # Phase 6. The translation provider rejected or timed out. One is
        # normal (the visitor gets the original words and the chat continues);
        # a spike means the provider is down or the latency budget is wrong,
        # and both are invisible otherwise. This is the class of failure that
        # already shipped once: an outbound budget set below the provider's
        # median delivered roughly six operator replies in ten untranslated,
        # and it was found by hand-timing calls rather than by an alarm.
        "translation_provider_failed",
        # Phase 6. Translation was skipped because the platform switch is off
        # or the workspace is out of credits. Expected while a switch is
        # deliberately off; a spike on a workspace that was translating a
        # minute ago means it just ran out of credits, which is a billing
        # event somebody should see before the customer reports it.
        "translation_gated",
    }
)

#: Upper edges, in milliseconds, of the latency histogram buckets.
#:
#: A counter store cannot hold a distribution, and p95 is what actually
#: matters for translation: the mean hides exactly the tail that causes an
#: untranslated message. Cumulative bucket counters give a percentile to
#: within one bucket width using the same INCRBY the rest of this module
#: uses, with no new infrastructure and no unbounded key growth.
#:
#: The edges cluster around the 2 to 4 second region because that is where the
#: outbound budget sits and where a regression has to be caught.
LATENCY_BUCKETS_MS: tuple[int, ...] = (250, 500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 10000)


def _hour_bucket(now: datetime | None = None) -> str:
    dt = now or datetime.now(UTC)
    return dt.strftime("%Y%m%d%H")


def _counter_key(name: str, bot_id: int | None, hour_bucket: str) -> str:
    scope = f"b{bot_id}" if bot_id else "global"
    return f"oyechats:metric:{name}:{scope}:{hour_bucket}"


def increment_metric_counter(name: str, bot_id: int | None = None) -> None:
    """Increment this hour's rolling counter for ``name`` (optionally scoped
    to ``bot_id``). Best-effort, never raises; a Redis hiccup must not break
    the caller (these are called from hot request paths)."""
    increment_metric_counter_by(name, 1, bot_id=bot_id)


def increment_metric_counter_by(name: str, amount: int, bot_id: int | None = None) -> None:
    """Like :func:`increment_metric_counter` but adds an arbitrary ``amount``
    in one round trip (e.g. a token count) instead of always incrementing by 1.
    Best-effort, never raises."""
    try:
        if amount <= 0:
            return
        client = get_redis()
        if client is None:
            return
        key = _counter_key(name, bot_id, _hour_bucket())
        pipe = client.pipeline()
        pipe.incrby(key, amount)
        pipe.expire(key, _COUNTER_TTL_SECONDS)
        pipe.execute()
    except Exception as exc:  # noqa: BLE001 - metrics must never break the caller
        logger.debug("increment_metric_counter_by failed (non-blocking): %s", exc)


def get_metric_counts(name: str, bot_id: int | None = None, hours: int = 24) -> dict[str, int]:
    """Return ``{hour_bucket: count}`` for the last ``hours`` hourly buckets.

    Missing buckets (no events, or the key already expired) are omitted, not
    zero-filled. Callers that need a dense series can zero-fill themselves.
    """
    try:
        client = get_redis()
        if client is None:
            return {}
        now = datetime.now(UTC)
        buckets = []
        for h in range(hours):
            # Walk backwards from `now` by the hour, not by naive string
            # arithmetic, so month/year boundaries roll over correctly.
            bucket_dt = now - timedelta(hours=h)
            buckets.append(_hour_bucket(bucket_dt))

        keys = [_counter_key(name, bot_id, b) for b in buckets]
        values = client.mget(keys)
        return {bucket: int(v) for bucket, v in zip(buckets, values, strict=True) if v is not None}
    except Exception as exc:  # noqa: BLE001
        logger.debug("get_metric_counts failed (non-blocking): %s", exc)
        return {}


def record_latency_ms(name: str, elapsed_ms: float, bot_id: int | None = None) -> None:
    """Record one latency observation into the ``name`` histogram.

    Increments every bucket whose upper edge the observation falls at or below,
    so each bucket counter is CUMULATIVE ("how many were <= this"). That makes
    a percentile a single scan of the bucket series rather than a join, and it
    makes a missing bucket unambiguous (nothing was that fast) instead of
    ambiguous with an expired key.

    Also increments ``<name>_count`` so the total is available without summing,
    and ``<name>_over`` for observations past the largest edge, which is the
    bucket that matters when a provider hangs.

    Best-effort, like every other counter here: never raises, never blocks.
    """
    try:
        if elapsed_ms < 0:
            return
        increment_metric_counter(f"{name}_count", bot_id=bot_id)
        for edge in LATENCY_BUCKETS_MS:
            if elapsed_ms <= edge:
                increment_metric_counter(f"{name}_le_{edge}", bot_id=bot_id)
        if elapsed_ms > LATENCY_BUCKETS_MS[-1]:
            increment_metric_counter(f"{name}_over", bot_id=bot_id)
    except Exception as exc:  # noqa: BLE001 - metrics must never break the caller
        logger.debug("record_latency_ms failed (non-blocking): %s", exc)


def get_latency_percentile(
    name: str, percentile: float = 95.0, bot_id: int | None = None, hours: int = 24
) -> int | None:
    """Approximate a percentile from the cumulative buckets, in milliseconds.

    Returns the smallest bucket edge at or below which ``percentile`` of
    observations fall, so the true value lies between the previous edge and the
    one returned. Returns ``None`` when nothing was recorded in the window, and
    the sentinel ``-1`` is never used: absence of data is not a latency of zero.

    An observation past the largest edge cannot be attributed to any edge, so a
    percentile that falls in that tail returns ``None`` rather than pretending
    the largest edge covers it. Read ``<name>_over`` to see that tail.
    """
    total = sum(get_metric_counts(f"{name}_count", bot_id=bot_id, hours=hours).values())
    if total <= 0:
        return None
    target = total * (percentile / 100.0)
    for edge in LATENCY_BUCKETS_MS:
        at_or_below = sum(get_metric_counts(f"{name}_le_{edge}", bot_id=bot_id, hours=hours).values())
        if at_or_below >= target:
            return edge
    return None


def forward_to_sentry_if_alertable(name: str, **tags) -> None:
    """Forward security-relevant safety-net events to Sentry as a message.
    Sentry is the platform's already-established alerting channel
    (Sentry -> Slack per docs/system-design), so events that should page
    oncall go there instead of requiring a new alerting integration."""
    if name not in _SENTRY_FORWARD_METRICS:
        return
    try:
        import sentry_sdk

        from app.config import SENTRY_ENABLED

        if not SENTRY_ENABLED:
            return
        sentry_sdk.capture_message(f"rag.safety_net.{name}", level="warning")
    except Exception as exc:  # noqa: BLE001
        logger.debug("forward_to_sentry_if_alertable failed (non-blocking): %s", exc)
