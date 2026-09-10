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
import threading
import time
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
        # A credit was charged for an answer the visitor never got, and giving
        # it back failed. The customer stays out of pocket, the ledger stays
        # wrong, and until now the only trace was one log line. A refund is
        # already best-effort by design (it must never mask the original
        # error), so counting and paging is the only way anybody learns it
        # happened.
        "credit_refund_failed",
        # A fail-open on a judge means the answer went out with no scope check
        # at all. One is a provider blip; a run of them is the scope guarantee
        # silently switched off, which is how a 41-request outage went
        # unnoticed once already.
        "gate_failed_open",
        "moderation_failed_open",
        # The gateway refused to cancel a live mandate. The daily orphan sweep
        # catches it, but until it does the customer is still being charged.
        "addon_cancel_failed",
        # An email the platform accepted and then could not deliver: the
        # enqueue failed, the provider refused it, or the retries ran out. The
        # row is kept in ``failed_emails``; this is how anyone learns to look.
        "email_dead_lettered",
        # A paid charge that has had no invoice number for an hour. The
        # five-minute backfill has now failed twelve times on it, so this is a
        # customer holding a receipt-less purchase, not a transient blip.
        "invoice_stuck_unnumbered",
        # An enqueue that never reached Redis after the response was already
        # sent. For an email that is a verification code nobody receives.
        "enqueue_failed",
        # The qualification enqueue never reached Redis, so the turn ran the
        # BANT extraction on the in-process pool instead. The visitor notices
        # nothing, which is why it has to page: a broken queue would otherwise
        # be found only when that pool saturated under load.
        "qualification_enqueue_failed",
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

#: How long one Sentry forward of a metric silences the next one, in seconds.
#:
#: Every event is still counted; only the page is rate-limited. During a
#: provider outage ``gate_failed_open`` fires once per chat turn, and the
#: invoice PDF backfill re-emits ``invoice_stuck_unnumbered`` every five
#: minutes for as long as any row is stuck. One page says everything the
#: hundredth would, and the duplicates buried the pages that mattered.
SENTRY_FORWARD_DEFAULT_WINDOW_SECONDS = 10 * 60

#: Per-metric overrides of the default window. The invoice backfill runs on a
#: five-minute schedule and the same stuck row stays stuck for hours, so an
#: hourly reminder is the right cadence there.
SENTRY_FORWARD_WINDOW_SECONDS: dict[str, int] = {
    "invoice_stuck_unnumbered": 60 * 60,
}

# In-process fallback for the throttle when Redis is unavailable. Keyed by
# metric name, so it is bounded by the size of ``_SENTRY_FORWARD_METRICS``.
# Values are ``(expires_at_monotonic, suppressed_count)``.
_local_forward_claims: dict[str, tuple[float, int]] = {}
_local_forward_lock = threading.Lock()

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
        bucket = _hour_bucket()
        key = _counter_key(name, bot_id, bucket)
        pipe = client.pipeline()
        pipe.incrby(key, amount)
        pipe.expire(key, _COUNTER_TTL_SECONDS)
        if bot_id:
            # A per-bot event is also a platform event. The super-admin
            # safety-net read defaults to the global scope, and a counter that
            # only ever landed under ``b{bot_id}`` read there as a permanent
            # zero, which is what the QA-cache hit rate and the groundedness
            # verdicts did. Same pipeline, so it is still one round trip.
            global_key = _counter_key(name, None, bucket)
            pipe.incrby(global_key, amount)
            pipe.expire(global_key, _COUNTER_TTL_SECONDS)
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


def _sentry_forward_window_seconds(name: str) -> int:
    return SENTRY_FORWARD_WINDOW_SECONDS.get(name, SENTRY_FORWARD_DEFAULT_WINDOW_SECONDS)


def _forward_throttle_key(name: str) -> str:
    return f"oyechats:sentry_forward:{name}"


def reset_sentry_forward_throttle() -> None:
    """Forget every in-process claim. For tests; production never needs it."""
    with _local_forward_lock:
        _local_forward_claims.clear()


def _claim_local_forward(name: str, window: int) -> tuple[bool, int]:
    now = time.monotonic()
    with _local_forward_lock:
        expires_at, suppressed = _local_forward_claims.get(name, (0.0, 0))
        if now >= expires_at:
            _local_forward_claims[name] = (now + window, 0)
            return True, 0
        suppressed += 1
        _local_forward_claims[name] = (expires_at, suppressed)
        return False, suppressed


def _claim_sentry_forward(name: str) -> tuple[bool, int]:
    """Decide whether this event may page. Returns ``(allowed, suppressed)``.

    The claim is ``SET NX EX`` on a key per metric, so every process behind
    the same Redis shares one window and the TTL is set atomically with the
    claim (an ``INCR`` then ``EXPIRE`` pair could leave a key that never
    expires if the process died between them). While the claim is held the
    same key is incremented so the suppressed count is one more round trip,
    not a second key with its own lifetime.

    Redis being down is exactly when a provider outage is likely to be in
    progress, so the fallback is a process-local table rather than "forward
    everything" or "forward nothing".
    """
    window = _sentry_forward_window_seconds(name)
    try:
        client = get_redis()
        if client is not None:
            key = _forward_throttle_key(name)
            if client.set(key, 0, nx=True, ex=window):
                return True, 0
            return False, int(client.incr(key))
    except Exception as exc:  # noqa: BLE001 - the throttle must never break the caller
        logger.debug("sentry forward throttle fell back to in-process (non-blocking): %s", exc)
    return _claim_local_forward(name, window)


def forward_to_sentry_if_alertable(name: str, **tags) -> None:
    """Forward security-relevant safety-net events to Sentry as a message.
    Sentry is the platform's already-established alerting channel
    (Sentry -> Slack per docs/system-design), so events that should page
    oncall go there instead of requiring a new alerting integration.

    At most one forward per metric per window (see
    ``SENTRY_FORWARD_DEFAULT_WINDOW_SECONDS``); the rest are counted and
    logged, never sent."""
    if name not in _SENTRY_FORWARD_METRICS:
        return
    try:
        import sentry_sdk

        from app.config import SENTRY_ENABLED

        if not SENTRY_ENABLED:
            return
        allowed, suppressed = _claim_sentry_forward(name)
        if not allowed:
            logger.info(
                "sentry forward suppressed for %s: %d suppressed in the current %ds window",
                name,
                suppressed,
                _sentry_forward_window_seconds(name),
            )
            return
        # Tags are what make the alert actionable. Without them every
        # translation_gated event reads the same, so a workspace that just ran
        # out of credits is indistinguishable from a switch somebody turned off
        # on purpose, and neither can be attributed to a bot. Callers already
        # pass reason= and bot_id=; these were being accepted and dropped.
        #
        # Values are always short scalars the caller chose (a bot id, a reason
        # enum). Message text never reaches this function and must not: keep it
        # that way when adding callers.
        with sentry_sdk.new_scope() as scope:
            for key, value in tags.items():
                if value is not None:
                    scope.set_tag(key, str(value))
            sentry_sdk.capture_message(f"rag.safety_net.{name}", level="warning")
    except Exception as exc:  # noqa: BLE001
        logger.debug("forward_to_sentry_if_alertable failed (non-blocking): %s", exc)
