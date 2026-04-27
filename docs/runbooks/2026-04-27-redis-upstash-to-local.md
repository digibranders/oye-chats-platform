# Redis migration: Upstash → self-hosted on droplet

**Date:** 2026-04-27 · **Operator:** infra · **Severity:** P0 (prod degraded) · **Downtime:** ~30 s API restart

## Why

The Upstash free tier (500k commands/month) was exhausted, causing:

- API `/health` returning 503 (every health check pings Redis)
- ARQ worker in a crash-restart loop (`NRestarts` reached **540** in 35 min before we stopped it)
- All chat requests degraded — cache_get/set silently returned None, gate cache cold, rate limit memory-only

Root cause: the worker's two cron jobs (heartbeat + webhook retry) firing every 30 s consumed ~600 k commands/month *by themselves* before counting any user traffic. Polling-heavy workload, wrong tool for a fixed-quota free tier.

## Decision

Self-host Redis on the same DigitalOcean droplet rather than upgrade Upstash:

- $0 ongoing cost (vs paid Upstash tiers)
- No request quota — droplet has 1.2 GB RAM headroom; Redis cap of 128 MB is conservative for years of MVP-stage growth
- Loopback latency (~0.1 ms) vs ~30 ms TLS to Upstash
- Single point of failure trade-off accepted at MVP stage; will revisit when paying customers force HA (P3.3 in plan)

## Pre-state

| Service | State before |
|---|---|
| oyechats-api | active, returning 503 on /health |
| oyechats-worker | crash-looping, NRestarts=540 |
| Upstash Redis | quota exhausted, all writes/reads rejected |
| `REDIS_URL` | `rediss://...@primary-ape-95368.upstash.io:6379` |

## Steps executed

```bash
# P0.1 — Stop the bleeding
systemctl stop oyechats-worker
cp /opt/oyechats/platform/api/.env /opt/oyechats/platform/api/.env.bak.before-redis-migration.20260427-073755

# P0.2 — Install Redis
apt-get install -y redis-server                     # default bind 127.0.0.1 ::1
redis-cli CONFIG SET maxmemory 128mb
redis-cli CONFIG SET maxmemory-policy allkeys-lru
redis-cli CONFIG REWRITE                            # persist to /etc/redis/redis.conf

# P0.3 — Switch URL
sed -i 's|^REDIS_URL=.*|REDIS_URL=redis://localhost:6379/0|' /opt/oyechats/platform/api/.env
systemctl restart oyechats-api
systemctl start oyechats-worker

# P0.4 — Update GH Actions secret (run from local repo)
gh secret set REDIS_URL --body 'redis://localhost:6379/0' --repo digibranders/oye-chats-platform
```

## Post-state

| Check | Result |
|---|---|
| `redis-cli ping` | `PONG` |
| `redis-cli CONFIG GET maxmemory` | `134217728` (128 MB) |
| `redis-cli INFO memory` | `used_memory_human: 1.44M` (4 keys, all worker bookkeeping) |
| Listening sockets | `127.0.0.1:6379` + `::1:6379` only — never publicly exposed |
| API `/health` (loopback) | HTTP 200, `status: healthy` |
| External `https://api.oyechats.com/health` | HTTP 200 in 122 ms |
| Worker | `active`, `NRestarts: 0`, heartbeat 8.8 s ago |

## Rollback procedure

If Redis fails or the migration causes regressions:

```bash
# 1. Restore the .env backup
cp /opt/oyechats/platform/api/.env.bak.before-redis-migration.20260427-073755 \
   /opt/oyechats/platform/api/.env

# 2. Restart services
systemctl restart oyechats-api oyechats-worker

# 3. Stop local Redis (optional — leaving it running is harmless)
systemctl stop redis-server

# 4. Revert GH secret to Upstash URL (run from local repo)
gh secret set REDIS_URL --body '<upstash url from backup .env>' \
   --repo digibranders/oye-chats-platform
```

The Upstash database itself was never deleted — it just hit quota. Once the calendar month rolls over, it would work again. So rollback is fully reversible until we tear down the Upstash project (separate decision).

## Operational notes

- **Backups:** local Redis data is ephemeral cache + queue state — no DB-style backup needed. If Redis loses data, the app re-fills from the source of truth (Postgres) on next request.
- **Persistence:** Redis ships with RDB snapshots enabled by default (`save 3600 1 300 100 60 10000`). Snapshots written to `/var/lib/redis/dump.rdb`. Acceptable for cache use — at most 1 hour of cache loss on hard crash.
- **Monitoring keys to watch:**
  - `redis-cli INFO memory | grep evicted_keys` — should stay near 0 at MVP scale
  - `redis-cli INFO stats | grep keyspace_hits/misses` — hit ratio is product KPI
  - `systemctl show oyechats-worker -p NRestarts` — should not climb in steady state
- **When to bump cap above 128 MB:** if `evicted_keys` starts climbing > 100/hour. Bump live with `redis-cli CONFIG SET maxmemory 256mb && redis-cli CONFIG REWRITE`. No restart needed.
