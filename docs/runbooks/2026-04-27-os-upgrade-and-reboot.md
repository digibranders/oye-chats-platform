# OS upgrade + reboot — kernel 6.8.0-71 → 6.8.0-110

**Date:** 2026-04-27 · **Operator:** infra · **Severity:** P2 (planned maintenance) · **Downtime:** ~60 s API, ~75 s end-to-end

Last item from today's hardening pass. The droplet had `/var/run/reboot-required` set since the last unattended-upgrade cycle pulled in a new kernel; 6 user-space packages plus the kernel were all sitting installed-but-not-loaded.

## Pre-flight (state captured before any change)

| Check | Value |
|---|---|
| Services | api, worker, postgresql, nginx, redis-server, fail2ban — all `active` |
| `/health` | 200 · `status: healthy` · worker heartbeat 24 s |
| Worker `NRestarts` | 0 |
| Pending updates | ~12 packages (more than the original 6, since fail2ban + redis pulled in transitive deps earlier today) |
| Kernel | 6.8.0-71-generic |
| `/var/run/reboot-required` | present |

## Steps

```bash
# 1. apt update + full-upgrade in one shot (no reboot yet)
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y -qq \
  -o Dpkg::Options::='--force-confold' \
  -o Dpkg::Options::='--force-confdef'
apt-get autoremove -y -qq

# Verify zero packages still upgradable; reboot-required still set (kernel
# patch installed but not yet loaded).

# 2. Reboot
nohup systemctl reboot > /tmp/reboot.log 2>&1 &
# SSH connection drops here. Wait ~75s.

# 3. Reconnect + verify
ssh root@<ip> 'uptime; uname -r; <service checks>'
```

`apt full-upgrade` ran in <2 minutes; restarted in-place: `fail2ban`,
`multipathd`, `nginx`, `packagekit`, `polkit`, `postgresql@16-main`,
`redis-server`, `ssh`, `udisks2`. App services (`oyechats-api`,
`oyechats-worker`) remained running through the package upgrade and
were validated still `active` before the reboot was triggered.

`--force-confold` + `--force-confdef` keep our edits to
`postgresql.conf` and `redis.conf` instead of letting maintainer
scripts overwrite them.

## Post-reboot (verified)

| Check | Result |
|---|---|
| Kernel | **6.8.0-110-generic** |
| Uptime | 1 minute |
| `oyechats-api` | active · NRestarts=0 |
| `oyechats-worker` | active · NRestarts=0 |
| `postgresql` | active · NRestarts=0 |
| `nginx` | active · NRestarts=0 |
| `redis-server` | active · NRestarts=0 |
| `fail2ban` | active · NRestarts=0 |
| `/health` (loopback) | 200 · `status: healthy` · worker alive 13.9 s |
| `https://api.oyechats.com/health` | 200 · 92 ms |
| Redis `maxmemory` | `134217728` (128 MB — config persisted) |
| Redis `maxmemory-policy` | `allkeys-lru` (persisted) |
| Postgres `effective_cache_size` | `1GB` (persisted) |
| `fail2ban-client status sshd` | jail active, 0 banned (re-armed clean) |
| Memory used / available | 714 MB used / 1.2 GB available |
| `/var/run/reboot-required` | **cleared** |

Sentry post-reboot smoke test sent and accepted: event id
`92ea0ae5fb01493b92d20d7b715aa293`. DSN-fix from earlier today is
durable across reboot.

## BetterStack signal

The 3-minute check interval on both monitors means a 60-75 s outage
typically doesn't fire an incident — the next probe lands after the
service is already back. If the reboot took >3 min the alert pipeline
would have triggered. (We have a separate runbook for actual outages.)

## Why this was always going to be safe

Every config change made today persists on disk:
- `REDIS_URL=redis://localhost:6379/0` and `SENTRY_DSN_BACKEND=…/4511103987286016`
  in `/opt/oyechats/platform/api/.env` — survives reboot.
- `redis.conf` (maxmemory + LRU) — survives.
- `postgresql.conf` (effective_cache_size) — survives.
- `fail2ban` enabled at boot via `systemctl enable`.
- `redis-server` enabled at boot.
- `oyechats-api` + `oyechats-worker` enabled at boot via existing systemd units.

No volatile / in-memory-only state would be lost.

## Today's hardening: complete

This closes the entire pass started after the Upstash quota outage:

| ID | Item | Status |
|---|---|---|
| P0 | Redis: Upstash → self-hosted on droplet | ✅ |
| Cleanup A | journal vacuum (176M → 40M) | ✅ |
| Zero-downtime A | `/health` split (readiness + comprehensive) | ✅ |
| Sentry hardening | worker init + release/service tags | ✅ |
| Sentry repair | truncated DSN fixed | ✅ |
| BetterStack | 2 monitors (`/health` + `/health/live`) | ✅ |
| GitHub | secrets audit (24 present, 2 minor drift items reported) | ✅ |
| B | off-site DB backups to R2 (30-day retention) | ✅ |
| C | fail2ban for SSH | ✅ |
| E | Postgres `effective_cache_size` 4 GB → 1 GB | ✅ |
| **D** | **OS updates + reboot to kernel 6.8.0-110** | ✅ |

Production is in a markedly better state than it was 4 hours ago.
