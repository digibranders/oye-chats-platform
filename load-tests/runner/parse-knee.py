#!/usr/bin/env python3
"""Extract one knee-summary CSV row from a k6 summary-export JSON + server CSV.
Usage: parse-knee.py <conc> <k6_summary.json> <server_metrics.csv>"""
import csv
import json
import sys


def g(metrics, name, stat, default=""):
    m = metrics.get(name, {})
    v = m.get(stat)
    return round(v, 1) if isinstance(v, (int, float)) else default


def main():
    conc, k6_json, server_csv = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        with open(k6_json) as f:
            data = json.load(f)
        metrics = data.get("metrics", {})
    except (OSError, ValueError):
        metrics = {}

    p50_ttfb = g(metrics, "chat_time_to_first_byte", "p(50)") or g(metrics, "chat_time_to_first_byte", "med")
    p95_ttfb = g(metrics, "chat_time_to_first_byte", "p(95)")
    p99_ttfb = g(metrics, "chat_time_to_first_byte", "p(99)")
    p95_total = g(metrics, "chat_total_stream_ms", "p(95)")
    err = metrics.get("journey_errors", {}).get("rate") or metrics.get("http_req_failed", {}).get("rate") or 0
    reqs = metrics.get("journey_requests", {}).get("count") or metrics.get("http_reqs", {}).get("count") or ""

    max_active = max_total = 0
    try:
        with open(server_csv) as f:
            for row in csv.DictReader(f):
                max_active = max(max_active, int(row.get("pg_active") or 0))
                max_total = max(max_total, int(row.get("pg_total") or 0))
    except (OSError, ValueError):
        pass

    print(f"{conc},{p50_ttfb},{p95_ttfb},{p99_ttfb},{p95_total},{round(float(err),4)},{reqs},{max_active},{max_total}")


if __name__ == "__main__":
    main()
