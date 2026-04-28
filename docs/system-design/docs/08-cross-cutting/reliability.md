# Reliability

> **Audience:** Ops · CTO · **Read time:** 5 min · **Last updated:** 2026-04-28

## TL;DR

Reliability today is "good enough at our scale, with known single-points-of-failure." The droplet is the SPOF; everything else has either a fallback (LLM, payments) or a retry/idempotency story (webhooks, payment events, ingestion).

## Failure-mode matrix

| Failure | Blast radius | Mitigation in place | Recovery |
|---|---|---|---|
| Droplet down | **Total platform outage** | None (single host) | Reboot droplet; restore from Cloudflare R2 backup if disk lost |
| Postgres process down | Total outage (no fallback) | systemd `Restart=always` | journalctl + restart; backups for last-resort |
| Redis process down | Rate-limit + queue + cache offline; chat falls back to in-memory | systemd `Restart=always` | restart |
| API process down | Outage until restart | systemd `Restart=always`, `RestartSec=5s` | systemd auto-restarts |
| Worker process down | Background tasks stall (webhooks, emails, ingestion); chat unaffected | systemd `Restart=always` | restart; tasks resume from queue |
| OpenAI down | Chat falls back to Gemini transparently | LiteLLM auto-fallback | none needed |
| Gemini down | If OpenAI also down → chat 502 | none | wait or relax to a third provider |
| Razorpay down | New paid signups blocked; existing customers unaffected | Stripe fallback (manual override `BILLING_PROVIDER=stripe`) | flip env var + restart |
| Stripe down | International signups blocked | Razorpay still works | wait |
| Brevo down | Emails queue indefinitely; Sentry alerts | retries inside `task_send_email` | wait |
| R2 (Cloudflare) down | Ingestion blocked; chat unaffected | retries; surfaces as `documents.status=failed` | wait |
| Cloudflare R2 + CDN down | Widget cannot load on customer sites | none (browser cache may save tabs already open) | wait |
| Sentry down | Errors go to journalctl only | none needed | wait |
| Langfuse down | Tracing dropped (already off in prod) | none | wait |
| Customer CRM webhook down | Tenant-level concern | 5× retry chain (30s/2m/10m/1h) | customer fixes endpoint, manual retry from UI |

## Reliability primitives in use

### Retries with backoff

- **Webhook delivery** — 5 attempts at 30s/2m/10m/1h/4h, then `dead`.
- **OpenAI/Gemini** — LiteLLM internal exponential backoff + automatic provider fallback.
- **ARQ tasks** — `max_tries` per task (3 for ingest, 3 for renew, 2 for email).
- **Subscription renewal** — daily sweep means a missed run picks up the next day.

### Idempotency

- **Provider webhooks** — `processed_webhooks (event_id, provider)` PK.
- **Document ingestion** — chunks upserted by `(bot_id, source_path, chunk_index)`.
- **Top-up grant** — verified by signature + order ID; double-verify defends against retry.
- **Credit deductions** — `SELECT FOR UPDATE` serializes per-client.

### Circuit breakers / fail-fast

- **Production startup** — fails immediately if `REDIS_URL` missing.
- **Health gate on deploy** — won't mark deploy successful unless `/health/full` is 200 within 45s.
- **Out of credits** — hard 402 at chat start rather than a partial response.

### Graceful degradation

- **LiteLLM fallback chain** — primary provider → fallback transparently.
- **WebSocket disconnect timeouts** — 60s grace for operators, 120s for visitors before re-queue/close.
- **Worker disabled** — `WORKER_ENABLED=false` falls back to in-process thread pool (dev mode only).
- **Langfuse disabled** — `LANGFUSE_FORCE_DISABLE` if causing issues.

## Backups & restore

| What | Schedule | Where | Retention |
|---|---|---|---|
| `pg_dump` (full) | Cron `0 3 * * *` | `/opt/oyechats/backups/` (local) | 7 days |
| Same dump | Same cron | R2 `backups/` | 30 days |
| Verify | Each run | `gzip -t` + min-size check | — |
| Restore drill | TODO (no automated weekly) | — | — |

Source: [`api/scripts/backup.sh`](../../../api/scripts/backup.sh).

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
| `2026-04-27-sentry-dsn-repair.md` | Sentry DSN broken / changed |
| `2026-04-27-rag-retrieval-fix.md` | RAG retrieval producing empty/bad results |
| `2026-04-27-droplet-hardening.md` | OS hardening (firewall, fail2ban) |
| `2026-04-27-os-upgrade-and-reboot.md` | Kernel upgrade procedure |

## SLOs (target, not contractual today)

| Metric | Target | Where measured |
|---|---|---|
| `/health/live` availability | 99.9% / 30 days | external probe |
| `/chat/stream` p95 first-token latency | < 5s | Sentry transactions |
| Webhook delivery success rate (final) | > 99% | `webhook_deliveries` query |
| Subscription activation success | 100% (retried) | `subscriptions WHERE status='trialing' older than 24h` should be 0 |

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
