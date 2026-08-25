"""Phase 6: translation metrics and alerting.

Nine translation counters already existed and were readable in the admin, but
none of them paged anybody and none of them measured latency. That combination
is how the outbound budget shipped at 2.0s against a provider whose median was
2,347ms: roughly six operator replies in ten reached visitors untranslated, and
it was found by hand-timing eight calls rather than by an alarm.

These tests hold three things:
  - latency is recorded as a distribution, so p95 (not the mean) is queryable
  - provider failure and gating reach the alert channel
  - none of it carries message text
"""

from __future__ import annotations

import pytest

from app.core import metrics


@pytest.fixture
def recorded(monkeypatch):
    """Capture counter increments instead of writing to Redis."""
    seen: list[tuple[str, int | None]] = []
    monkeypatch.setattr(metrics, "increment_metric_counter", lambda name, bot_id=None: seen.append((name, bot_id)))
    return seen


class TestLatencyHistogram:
    def test_an_observation_increments_every_bucket_at_or_above_it(self, recorded):
        metrics.record_latency_ms("translation_ms", 900, bot_id=7)
        names = [n for n, _ in recorded]
        assert "translation_ms_count" in names
        # Cumulative: 900ms is <= 1000, 1500, 2000 ... but not <= 500.
        assert "translation_ms_le_1000" in names
        assert "translation_ms_le_2000" in names
        assert "translation_ms_le_500" not in names
        assert "translation_ms_le_250" not in names

    def test_the_tail_past_the_largest_bucket_gets_its_own_counter(self, recorded):
        # A provider that hangs is the case the percentile cannot express, so
        # it must be countable on its own.
        metrics.record_latency_ms("translation_ms", 45_000, bot_id=7)
        names = [n for n, _ in recorded]
        assert "translation_ms_over" in names
        assert not any(n.startswith("translation_ms_le_") for n in names)

    def test_a_fast_call_lands_in_every_bucket(self, recorded):
        metrics.record_latency_ms("translation_ms", 10, bot_id=7)
        names = [n for n, _ in recorded]
        for edge in metrics.LATENCY_BUCKETS_MS:
            assert f"translation_ms_le_{edge}" in names

    def test_a_negative_observation_is_ignored(self, recorded):
        metrics.record_latency_ms("translation_ms", -1, bot_id=7)
        assert recorded == []

    def test_it_never_raises_when_the_counter_backend_fails(self, monkeypatch):
        def boom(name, bot_id=None):
            raise RuntimeError("redis gone")

        monkeypatch.setattr(metrics, "increment_metric_counter", boom)
        metrics.record_latency_ms("translation_ms", 500, bot_id=1)  # must not raise

    def test_bot_scope_is_carried_through(self, recorded):
        metrics.record_latency_ms("translation_ms", 100, bot_id=42)
        assert {b for _, b in recorded} == {42}


class TestPercentileReads:
    def _stub(self, monkeypatch, counts: dict[str, int]):
        monkeypatch.setattr(
            metrics,
            "get_metric_counts",
            lambda name, bot_id=None, hours=24: {"h": counts[name]} if name in counts else {},
        )

    def test_p95_returns_the_first_bucket_covering_the_target(self, monkeypatch):
        # 100 observations; 96 at or below 2000ms. p95 must be 2000, not 1500.
        self._stub(
            monkeypatch,
            {
                "translation_ms_count": 100,
                "translation_ms_le_250": 10,
                "translation_ms_le_500": 40,
                "translation_ms_le_1000": 80,
                "translation_ms_le_1500": 90,
                "translation_ms_le_2000": 96,
                "translation_ms_le_2500": 99,
                "translation_ms_le_3000": 100,
            },
        )
        assert metrics.get_latency_percentile("translation_ms", 95.0) == 2000
        # The median falls between 500 (40 at or below) and 1000 (80 at or
        # below). The function returns the UPPER edge of the containing bucket,
        # so the true value is known to lie in (500, 1000]. Returning 500 would
        # claim a median faster than 60% of the observations actually were.
        assert metrics.get_latency_percentile("translation_ms", 50.0) == 1000

    def test_no_data_reads_as_none_not_zero(self, monkeypatch):
        # Zero would render as "0 ms", the fastest possible service, which is
        # the opposite of "we have no idea".
        self._stub(monkeypatch, {})
        assert metrics.get_latency_percentile("translation_ms", 95.0) is None

    def test_a_percentile_in_the_overflow_tail_reads_as_none(self, monkeypatch):
        # 100 calls, only 50 landed in any bucket: the rest hung past 10s.
        # Reporting 10000 would understate an outage.
        self._stub(
            monkeypatch,
            {"translation_ms_count": 100, "translation_ms_le_10000": 50},
        )
        assert metrics.get_latency_percentile("translation_ms", 95.0) is None


class TestAlerting:
    def test_provider_failure_and_gating_are_alertable(self):
        assert "translation_provider_failed" in metrics._SENTRY_FORWARD_METRICS
        assert "translation_gated" in metrics._SENTRY_FORWARD_METRICS

    def test_ordinary_volume_counters_are_not_alertable(self):
        # Paging on every successful translation would make the channel useless.
        for name in ("translation_ok", "translation_requests", "translation_cache_hit"):
            assert name not in metrics._SENTRY_FORWARD_METRICS

    @staticmethod
    def _fake_sdk(sent, tags):
        """Stand in for sentry_sdk, recording what a real forward would send.

        It has to model ``new_scope`` as well as ``capture_message``: the
        forwarder sets its tags on a scope, and a stub missing that method
        raises inside the forwarder's own ``except`` clause, which would make a
        "nothing was sent" assertion pass for the wrong reason.
        """

        class _Scope:
            def set_tag(self, key, value):
                tags[key] = value

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        class _SDK:
            @staticmethod
            def new_scope():
                return _Scope()

            @staticmethod
            def capture_message(msg, level=None):
                sent.append(msg)

        return _SDK

    def _install(self, monkeypatch, sent, tags):
        monkeypatch.setitem(__import__("sys").modules, "sentry_sdk", self._fake_sdk(sent, tags))
        monkeypatch.setattr("app.config.SENTRY_ENABLED", True, raising=False)

    def test_forwarding_ignores_names_outside_the_set(self, monkeypatch):
        sent: list[str] = []
        tags: dict[str, str] = {}
        monkeypatch.setattr(metrics, "_SENTRY_FORWARD_METRICS", frozenset({"translation_gated"}))
        self._install(monkeypatch, sent, tags)
        metrics.forward_to_sentry_if_alertable("translation_ok")
        assert sent == []

    def test_the_gating_reason_reaches_the_alert(self, monkeypatch):
        """An alert that cannot say WHY is not actionable.

        ``translation_gated`` fires both when an operator deliberately turns a
        switch off and when a workspace runs out of credits. Those want
        opposite responses, and the only thing that separates them in Sentry is
        this tag. The reason was being passed and silently dropped.
        """
        sent: list[str] = []
        tags: dict[str, str] = {}
        self._install(monkeypatch, sent, tags)
        metrics.forward_to_sentry_if_alertable("translation_gated", bot_id=7, reason="insufficient_credits")
        assert sent == ["rag.safety_net.translation_gated"]
        assert tags == {"bot_id": "7", "reason": "insufficient_credits"}

    def test_a_provider_failure_is_attributable_to_a_bot(self, monkeypatch):
        sent: list[str] = []
        tags: dict[str, str] = {}
        self._install(monkeypatch, sent, tags)
        metrics.forward_to_sentry_if_alertable("translation_provider_failed", bot_id=3, kind="translation_timeout")
        assert sent == ["rag.safety_net.translation_provider_failed"]
        assert tags == {"bot_id": "3", "kind": "translation_timeout"}

    def test_absent_tags_are_omitted_rather_than_sent_as_none(self, monkeypatch):
        # "bot_id: None" in a Sentry filter is worse than no tag: it looks like
        # a real value and matches nothing useful.
        sent: list[str] = []
        tags: dict[str, str] = {}
        self._install(monkeypatch, sent, tags)
        metrics.forward_to_sentry_if_alertable("translation_gated", bot_id=None, reason="feature_off")
        assert tags == {"reason": "feature_off"}


class TestNoContentLeaks:
    def test_the_emitters_take_no_message_text(self):
        """Signatures are the guarantee here, not discipline at the call site.

        Neither counter nor histogram accepts anything but a metric name, a
        number and a bot id, so no caller can pass message text even by
        accident.
        """
        import inspect

        for fn in (metrics.record_latency_ms, metrics.increment_metric_counter):
            params = set(inspect.signature(fn).parameters)
            assert not params & {"text", "content", "message", "translated", "source_text"}

    def test_translation_service_logs_carry_no_content(self):
        """The log lines are the other place text could escape."""
        from pathlib import Path

        src = Path(metrics.__file__).parent.parent / "services" / "translation_service.py"
        body = src.read_text(encoding="utf-8")
        for line in body.splitlines():
            stripped = line.strip()
            if not stripped.startswith(("logger.info", "logger.warning", "logger.error")):
                continue
            assert "text" not in stripped and "content" not in stripped, (
                f"a translation log line may carry message content: {stripped}"
            )


class TestServiceEmitsWhatItPromises:
    """The unit tests above prove the metric helpers behave. These prove the
    translation path actually calls them, which is a different failure mode:
    a helper nobody invokes reports a permanently healthy service.
    """

    @staticmethod
    def _service(monkeypatch, provider):
        import app.services.translation_service as ts

        # No Redis in the unit environment: the cache must miss, not error.
        monkeypatch.setattr(ts, "cache_get", lambda key: None)
        monkeypatch.setattr(ts, "cache_set", lambda key, value, ttl: True)
        return ts, ts.TranslationService(provider=provider)

    @staticmethod
    def _capture(monkeypatch, ts):
        counters: list[str] = []
        latencies: list[tuple[str, float]] = []
        alerts: list[str] = []
        monkeypatch.setattr(ts, "increment_metric_counter", lambda n, bot_id=None: counters.append(n))
        monkeypatch.setattr(ts, "record_latency_ms", lambda n, ms, bot_id=None: latencies.append((n, ms)))
        monkeypatch.setattr(ts, "forward_to_sentry_if_alertable", lambda n, **kw: alerts.append(n))
        return counters, latencies, alerts

    @pytest.mark.asyncio
    async def test_a_successful_translation_records_its_latency(self, monkeypatch):
        import app.services.translation_service as ts_mod

        class _Ok:
            provider_name = "stub"
            model = "m"

            async def translate(self, text, source, target, timeout=None):
                return ts_mod.TranslationResult(content="ठीक", provider="stub", model="m", cached=False)

        ts, service = self._service(monkeypatch, _Ok())
        counters, latencies, alerts = self._capture(monkeypatch, ts)

        await service.translate("ok", "en", "hi", bot_id=3)

        assert "translation_ok" in counters
        assert [n for n, _ in latencies] == [ts.TRANSLATION_LATENCY_METRIC]
        assert alerts == [], "a successful translation must not page anyone"

    @pytest.mark.asyncio
    async def test_a_failed_translation_still_records_its_latency(self, monkeypatch):
        """The observation that matters most must not be the one dropped.

        Recording latency only on success makes the p95 look healthy through
        exactly the outage the percentile exists to reveal: every slow call
        times out, every timeout is excluded, and the surviving fast calls
        report an excellent p95 while most replies arrive untranslated.
        """
        import app.services.translation_service as ts_mod

        class _Dead:
            provider_name = "stub"
            model = "m"

            async def translate(self, text, source, target, timeout=None):
                raise ts_mod.TranslationUnavailable("provider down")

        ts, service = self._service(monkeypatch, _Dead())
        counters, latencies, alerts = self._capture(monkeypatch, ts)

        with pytest.raises(ts.TranslationUnavailable):
            await service.translate("ok", "en", "hi", bot_id=3)

        assert [n for n, _ in latencies] == [ts.TRANSLATION_LATENCY_METRIC], (
            "a failed call recorded no latency; the p95 will hide the outage"
        )
        assert "translation_provider_failed" in counters
        assert "translation_provider_failed" in alerts, "a provider outage did not reach the alert path"
