# Reliability

> **Audience:** Ops · CTO · **Read time:** 5 min · **Last updated:** 2026-08-31

## TL;DR

Reliability today is "good enough at our scale, with known single-points-of-failure." The droplet is the SPOF; everything else has either a fallback (LLM, payments) or a retry/idempotency story (webhooks, payment events, ingestion).

## Failure-mode matrix

| Failure | Blast radius | Mitigation in place | Recovery |
|---|---|---|---|
| Droplet down | **Total platform outage** | None (single host) | Reboot droplet; restore from Cloudflare R2 backup if disk lost |
| Postgres process down | Total outage (no fallback) | systemd `Restart=always` | journalctl + restart; backups for last-resort |
| Redis process down | Rate-limit + queue + cache offline; chat falls back to in-memory | systemd `Restart=always` | restart |
| API process down | Outage until restart. Two gunicorn workers, so a single worker crash is partial | systemd `Restart=always`, `RestartSec=5s` | systemd auto-restarts |
| WS process down (`oyechats-ws`) | **Live chat only.** REST and bot chat are unaffected; existing sockets drop and clients reconnect | systemd `Restart=always` | restart |
| Redis down **with the WS split live** | Cross-process live-chat delivery stops. Publishes are best-effort and never fail a request, so this is **silent**: an operator sees "Waiting (0)" beside a sidebar badge of 1 | none — fail-open by design | restart Redis |
| Worker process down | Background tasks stall (webhooks, emails, ingestion); chat unaffected | systemd `Restart=always` | restart; tasks resume from queue |
| OpenAI down | Chat falls back to Gemini transparently | LiteLLM auto-fallback | none needed |
| **Gemini down** | The sharp one. Chat 502s if OpenAI is also down, **and** ingestion cannot embed, **and** query-time retrieval degrades to keyword-only (which for a non-English session is no retrieval at all), **and** both RAG gates fail open | No embedding fallback, deliberately — mixing embedding models corrupts the vector space | wait; ingestion retries via ARQ |
| Razorpay down | New paid signups and renewals blocked; existing customers unaffected | **None. There is no second gateway** | wait |
| Jina Reader down | URL ingestion falls back to Spider.cloud; demo captures fail | Guarded fallback — a partially successful crawl keeps its pages rather than being discarded | wait |
| Brevo down | Emails queue indefinitely; Sentry alerts | retries inside `task_send_email` | wait |
| R2 (Cloudflare) down | Ingestion blocked; chat unaffected | retries; surfaces as `documents.status=failed` | wait |
| Cloudflare R2 + CDN down | Widget cannot load on customer sites | none (browser cache may save tabs already open) | wait |
| Sentry down | Errors go to journalctl only | none needed | wait |
| Langfuse down | Tracing dropped; fire-and-forget, never blocks a response | none | wait |
| Customer CRM webhook down | Tenant-level concern | 5 attempts with 30s/2m/10m/1h delays, then an ERROR log → Sentry | customer fixes their endpoint; re-fire via `POST /webhooks/{id}/test` or by re-triggering the source event |

## Reliability primitives in use

### Retries with backoff

- **Webhook delivery** — 5 attempts with **four** delays: 30s / 2m / 10m / 1h (`_RETRY_DELAYS`). There is no 4h step and no `dead` status column; the delivery is simply abandoned and logged at ERROR.
- **OpenAI/Gemini** — LiteLLM internal exponential backoff + automatic provider fallback.
- **ARQ tasks** — `max_tries` per task (3 for ingest, 3 for renew, 2 for email).
- **Subscription renewal** — daily sweep means a missed run picks up the next day.

### Idempotency

- **Provider webhooks** — `processed_webhooks (event_id, provider)` PK.
- **Document ingestion** — per-URL: `delete_chunks_for_url(document_name, bot_id)` before each insert, plus a `credit_ledger.idempotency_key` (`ingest:{client}:{bot}:{job}:{url_sha}`) behind a partial unique index so a retried page cannot be charged twice.
- **Period credit grants** — `Subscription.last_granted_period_end`, so the activation grant and the first `subscription.charged` for the same period cannot both pay out.
- **Invoicing** — `Invoice.razorpay_payment_id` is UNIQUE, so the synchronous verify path and the webhook cannot double-invoice one capture.
- **Gateway cancellation** — `gateway_cancel_executed_at` makes the sweep re-runnable.
- **Top-up grant** — verified by signature + order ID; double-verify defends against retry.
- **Credit deductions** — a PostgreSQL **advisory lock** per (client, bot) serialises every grant/deduct/refund.

### Circuit breakers / fail-fast

- **Production startup** — fails immediately if `REDIS_URL` missing.
- **Health gate on deploy** — won't mark deploy successful unless `/health/full` is 200 within 45s.
- **Out of credits** — hard 402 at chat start rather than a partial response.

### Graceful degradation

- **LiteLLM fallback chain** — primary provider → fallback transparently.
- **WebSocket disconnect timeouts** — grace periods before release; a visitor disconnect returns the session to `bot`, it does not close it. Every timeout honours its compare-and-swap result, so a stale timer cannot tear down a conversation another process has already moved.
- **Failed generation** — signalled explicitly by the stream's status dict, so the answer is neither cached nor billed. Before that, every failure branch yielded an error *string*, which was billed, persisted as the answer, and served from cache for an hour to every later visitor asking the same question.
- **Worker disabled** — `WORKER_ENABLED=false` falls back to in-process thread pool (dev mode only).
- **Langfuse disabled** — `LANGFUSE_FORCE_DISABLE` if causing issues.

## Backups & restore

| What | Schedule | Where | Retention |
|---|---|---|---|
| `pg_dump` (full) | Cron `0 3 * * *` | `/opt/oyechats/backups/` (local) | 7 days |
| Same dump | Same cron | R2 `backups/` | 30 days |
| Verify | Each run | `gzip -t` + min-size check | — |
| Restore drill | TODO (no automated weekly) | — | — |

Source: [`api/scripts/backup.sh`](../../../../api/scripts/backup.sh).

Manual restore:

```bash
# pull latest backup
gunzip < oyechats-2026-04-27.sql.gz | psql $DB_URL
```

## Runbooks

Live in [`platform/docs/runbooks/`](../../../runbooks/). Current playbooks:

| File | Scenario |
|---|---|
| `2026-04-27-redis-upstash-to-local.md` | Redis migration; rollback to Upstash if needed |
| `cloudflare-origin-lockdown.md` | Cloudflare → origin authentication |
| `2026-04-27-rag-retrieval-fix.md` | RAG retrieval producing empty/bad results |
| `2026-04-27-droplet-hardening.md` | OS hardening (firewall, fail2ban) |
| `2026-04-27-os-upgrade-and-reboot.md` | Kernel upgrade procedure |

## SLOs (target, not contractual today)

| Metric | Target | Where measured |
|---|---|---|
| `/health/live` availability | 99.9% / 30 days | external probe |
| `/chat/stream` p95 first-token latency | < 5s | Sentry transactions |
| Webhook delivery success rate (final) | > 99% | `webhook_deliveries` query |
| Subscription activation success | 100% (retried) | `subscriptions WHERE status='trialing' older than 24h` **that are not on the `trial` plan** should be 0 — every signup legitimately sits in `trialing` on the trial plan for 14 days |

## Disaster recovery

| Scenario | RTO | RPO |
|---|---|---|
| Droplet OS corruption | ~2 hr (rebuild + restore latest R2 backup) | 24 hr (last nightly backup) |
| Single-table data corruption | Same as above | 24 hr |
| Cloudflare account compromise | Hours (regain access) | None — code in git, secrets re-set |
| GitHub account compromise | Hours | None |

A real DR drill has not been run; on the roadmap.

## Why this matters

Reliability is a product feature for B2B SaaS. Customers running OyeChats on their pricing pages care that the widget loads. The matrix above is the answer to "how bad is it if X breaks" and is the input to a future SLO/SLA negotiation. The most important next step is eliminating the droplet SPOF — see the [scaling plan](/09-capacity/scaling-plan).
