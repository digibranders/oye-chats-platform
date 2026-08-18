#!/usr/bin/env python3
"""Turn a soak sample CSV into a pass/fail verdict.

A soak is read as a SLOPE, not a number, and eyeballing a 1,440-row CSV at the
end of a 24h run is how a slow leak gets waved through. This fits a trend to
each resource and judges it, so the verdict is mechanical.

Deliberately ignores the first 10 minutes: sockets landing and pools filling
produce a steep, healthy ramp that would swamp any real trend.

    soak-verdict.py <server.csv> [k6_ws.json]
"""

import csv
import json
import sys

WARMUP_SECONDS = 600

# column -> (label, mb-or-count per hour that we call a leak)
# Thresholds are deliberately loose: this catches leaks, not noise. A process
# holding 250 sockets legitimately wobbles by a few MB.
CHECKS = {
    "api_rss_mb": ("API resident memory", 20.0, "MB/h"),
    "ws_rss_mb": ("WS resident memory", 20.0, "MB/h"),
    "api_fds": ("API descriptors", 25.0, "fds/h"),
    "ws_fds": ("WS descriptors", 25.0, "fds/h"),
    "pg_total": ("Postgres connections", 2.0, "conns/h"),
    "redis_clients": ("Redis clients", 5.0, "clients/h"),
}


def slope_per_hour(points):
    """Least-squares slope, per hour. Returns None when there is too little data."""
    if len(points) < 10:
        return None
    n = len(points)
    mean_t = sum(t for t, _ in points) / n
    mean_v = sum(v for _, v in points) / n
    denom = sum((t - mean_t) ** 2 for t, _ in points)
    if denom == 0:
        return None
    slope_per_sec = sum((t - mean_t) * (v - mean_v) for t, v in points) / denom
    return slope_per_sec * 3600


def main():
    path = sys.argv[1]
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            try:
                rows.append({k: (int(v) if v not in ("", None) and k != "cpu_idle" else v) for k, v in r.items()})
            except (ValueError, TypeError):
                continue
    if not rows:
        print("no usable samples")
        return 1

    t0 = rows[0]["ts"]
    hours = (rows[-1]["ts"] - t0) / 3600.0
    warm = [r for r in rows if r["ts"] - t0 >= WARMUP_SECONDS] or rows

    print(f"# Soak verdict — {len(rows)} samples over {hours:.1f}h")
    print(f"  (first {WARMUP_SECONDS // 60} min excluded as warm-up)\n")

    failed = []

    # Restarts are pass/fail, not a trend: one is already a dropped-socket event.
    #
    # This check assumes the server ran with GUNICORN_MAX_REQUESTS=0. The default
    # (10,000 requests, +/-1,000 jitter) retires a worker on a timer of its own,
    # which shows up here identically to a crash -- a real run logged ten such
    # "restarts" in 2.4h, every one of them gunicorn recycling on schedule.
    # That case is worse than a plain failure: recycling also resets the worker's
    # RSS and descriptors, so the drift checks below are measuring a counter that
    # was zeroed roughly hourly and a leak cannot surface at all. Hence the note
    # printed alongside a non-zero count -- the run is not merely failing, it is
    # not a valid soak.
    recycle_hint = False
    for col, label in (("api_restarts", "API worker restarts"), ("ws_restarts", "WS worker restarts")):
        total = max((r.get(col) or 0) for r in rows)
        status = "PASS" if total == 0 else "FAIL"
        if total:
            failed.append(f"{label}: {total}")
            recycle_hint = True
        print(f"  {status}  {label:<24} {total}")
    if recycle_hint:
        print(
            "\n  NOTE: restarts are only meaningful when the server ran with\n"
            "        GUNICORN_MAX_REQUESTS=0. Confirm with:\n"
            "          journalctl -u <api-unit> | grep 'Maximum request limit'\n"
            "        Any hit there means these are scheduled recycles, the RSS and\n"
            "        descriptor trends below were reset mid-run, and the soak must be\n"
            "        re-run with recycling disabled before it can prove anything."
        )

    print()
    for col, (label, limit, unit) in CHECKS.items():
        pts = [(r["ts"] - t0, r[col]) for r in warm if isinstance(r.get(col), int)]
        s = slope_per_hour(pts)
        if s is None:
            print(f"  ----  {label:<24} not enough data")
            continue
        first = pts[0][1]
        last = pts[-1][1]
        ok = abs(s) <= limit
        if not ok:
            failed.append(f"{label} drifting {s:+.1f} {unit}")
        print(f"  {'PASS' if ok else 'FAIL'}  {label:<24} {first} -> {last}   slope {s:+.1f} {unit} (limit ±{limit})")

    if len(sys.argv) > 2:
        try:
            with open(sys.argv[2]) as f:
                m = json.load(f).get("metrics", {})
            succ = m.get("soak_ws_connect_success", {}).get("value")
            p95 = m.get("soak_ws_rtt_ms", {}).get("p(95)")
            errs = m.get("soak_ws_errors", {}).get("count", 0)
            print()
            if succ is not None:
                ok = succ > 0.99
                if not ok:
                    failed.append(f"WS connect success {succ:.1%}")
                print(f"  {'PASS' if ok else 'FAIL'}  {'WS connect success':<24} {succ:.2%}")
            if p95 is not None:
                ok = p95 < 2000
                if not ok:
                    failed.append(f"WS RTT p95 {p95:.0f}ms")
                print(f"  {'PASS' if ok else 'FAIL'}  {'WS ping RTT p95':<24} {p95:.0f}ms")
            print(f"  ----  {'WS errors':<24} {int(errs)}")
        except (OSError, ValueError):
            pass

    print()
    if failed:
        print("VERDICT: FAIL — do not roll out")
        for f_ in failed:
            print(f"  - {f_}")
        return 1
    if hours < 12:
        print(f"VERDICT: PASS so far, but only {hours:.1f}h elapsed — slow leaks need the full run")
        return 0
    print("VERDICT: PASS — resource use is flat and nothing restarted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
