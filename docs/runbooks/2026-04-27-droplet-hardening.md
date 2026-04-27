# Droplet hardening — backups, fail2ban, postgres tuning

**Date:** 2026-04-27 · **Operator:** infra · **Severity:** P1 (no user impact, closes durable risks) · **Downtime:** zero

Three small, independent hardening steps applied in one window after the
P0 Redis migration. None require service restart of `oyechats-api` or
`oyechats-worker`; one Postgres reload (no connection drop).

## B. Off-site DB backups (Cloudflare R2)

### Problem

`/opt/oyechats/backup.sh` was a 3-line script that dumped Postgres,
gzipped it locally to `/opt/oyechats/backups/`, and pruned files older
than 7 days. Backups died with the droplet — a single droplet failure
(disk corruption, accidental rm, snapshot rollback) lost everything
since the last DO weekly snapshot.

### Fix

New `api/scripts/backup.sh` (now tracked in repo) does:

1. Source `/opt/oyechats/platform/api/.env` for credentials.
2. Dump + gzip to `/opt/oyechats/backups/oyechats-<TS>.sql.gz` (existing
   behaviour; keeps fast local restore).
3. Upload to Cloudflare R2 bucket `oyechats-cdn` under prefix
   `database-backups/` via `boto3` from the API venv (no new package).
4. Prune remote objects older than `BACKUP_REMOTE_RETENTION_DAYS`
   (default 30) under that prefix.
5. Prune local files older than `BACKUP_LOCAL_RETENTION_DAYS`
   (default 7).

Endpoint scheme is normalised in-script — `R2_ENDPOINT` in `.env` is
stored bare (no `https://`) for parity with the S3-style env
convention; boto3 needs a scheme so the script prepends one if missing.

### Cron

Updated to capture stdout/stderr:

```
0 3 * * * /opt/oyechats/backup.sh >> /var/log/oyechats-backup.log 2>&1
```

### Verification

```
[2026-04-27T08:11:09+00:00] Dumping oyechats database -> /opt/oyechats/backups/oyechats-20260427-081109.sql.gz
[2026-04-27T08:11:10+00:00] Local dump complete (1.3M)
[2026-04-27T08:11:10+00:00] Uploading to bucket=oyechats-cdn key=database-backups/oyechats-20260427-081109.sql.gz
[remote] uploaded 1288764 bytes
[2026-04-27T08:11:11+00:00] Off-site upload OK
```

R2 list confirms object present:
`database-backups/oyechats-20260427-081109.sql.gz · 1288764 bytes · 2026-04-27T08:11:11Z`.

### Cost

~1.3 MB per dump × 30 days = ~40 MB on R2 = effectively $0/month
(R2's storage is $0.015/GB/mo, egress is free).

### Restore procedure

```
# On a fresh droplet or for spot recovery
aws s3 cp --endpoint-url=https://<R2_ENDPOINT> \
  s3://oyechats-cdn/database-backups/oyechats-<TS>.sql.gz - \
  | gunzip | sudo -u postgres psql oyechats
```

## C. fail2ban for SSH

### Problem

SSH on `:22` was open to the world (UFW allows it) with key-only auth,
but no brute-force protection. Logs filled with bot probes; a clever
attacker could enumerate valid usernames or just keep the journal
churning.

### Fix

```
apt-get install -y fail2ban
systemctl enable --now fail2ban
```

Default `[sshd]` jail in Ubuntu's package config is enabled out of
the box: 5 failed attempts in 10 min → 10 min ban.

### Verification

Within seconds of starting:

```
$ fail2ban-client status sshd
Status for the jail: sshd
|- Filter
|  |- Currently failed:    4
|  |- Total failed:        5
`- Actions
   |- Currently banned:    0
```

Already detecting probe attempts.

## E. Postgres `effective_cache_size` 4GB → 1GB

### Problem

`effective_cache_size` was 4 GB on a 2 GB-RAM droplet. This setting
tells the planner how much OS-level filesystem cache to assume is
available for Postgres data — too high and the planner picks
plans that assume cache hits that won't actually happen, hurting
throughput.

Rule of thumb: ~50% of total RAM minus other resident services. On a
2 GB droplet running Postgres + Gunicorn + ARQ worker + Redis + Nginx,
1 GB is the right ceiling.

### Fix

```
# /etc/postgresql/16/main/postgresql.conf
effective_cache_size = 1GB
```

`SIGHUP` reload via `systemctl reload postgresql` (no connection drop).

### Verification

```
$ sudo -u postgres psql -tA -c 'SHOW effective_cache_size;'
1GB
```

## What's still pending

- **D. OS updates + reboot.** 6 packages waiting (incl. kernel update —
  `/var/run/reboot-required` exists). Needs a maintenance window because
  reboot drops all services for ~60 s. Schedule a low-traffic time and
  run `apt update && apt -y full-upgrade && reboot`.
- **R2 endpoint hygiene.** `R2_ENDPOINT` in `.env` is stored without
  the `https://` prefix. The backup script now handles this defensively;
  consider normalising the value (and the GH secret) so future scripts
  don't have to.
- **`RERANK_ENABLED` secret missing.** Deploy script references it but
  the secret isn't set, so the .env line evaluates to empty → reranker
  silently disabled. Set `RERANK_ENABLED=true` if reranking is wanted,
  or remove the dead reference from `deploy-api.yml`.

## Rollback (if needed)

| Item | How to revert |
|---|---|
| Backup script | `cp /opt/oyechats/backup.sh.bak.<TS> /opt/oyechats/backup.sh` (the old 3-line version) |
| Cron | `crontab -e` and restore the original line without the `>> log` redirect |
| fail2ban | `systemctl disable --now fail2ban && apt remove -y fail2ban` |
| Postgres tuning | `cp /etc/postgresql/16/main/postgresql.conf.bak.<TS> /etc/postgresql/16/main/postgresql.conf && systemctl reload postgresql` |
