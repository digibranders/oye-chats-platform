#!/bin/bash
# OyeChats nightly DB backup — local + off-site (Cloudflare R2).
#
# Schedule: systemd timer — api/systemd/oyechats-backup.timer is the IaC
# source of truth (audit F19). Remove any legacy root-cron `backup.sh` line.
#
# Why off-site: local backups die with the droplet. R2 keeps a 30-day
# tail so a droplet loss is recoverable. Local copy stays at 7 days for
# fast restore.
#
# Cost: each dump is ~1.3 MB gzipped; 30 daily copies = ~40 MB at $0.005/GB/mo
# on B2, i.e. ~$0.0002/month. Effectively free.

set -euo pipefail

# Configuration (override with env vars if needed)
LOCAL_DIR="${BACKUP_LOCAL_DIR:-/opt/oyechats/backups}"
LOCAL_RETENTION_DAYS="${BACKUP_LOCAL_RETENTION_DAYS:-7}"
REMOTE_RETENTION_DAYS="${BACKUP_REMOTE_RETENTION_DAYS:-30}"
REMOTE_PREFIX="${BACKUP_REMOTE_PREFIX:-database-backups}"
ENV_FILE="${OYECHATS_ENV_FILE:-/opt/oyechats/platform/api/.env}"
VENV_PY="${OYECHATS_VENV_PY:-/opt/oyechats/platform/api/.venv/bin/python}"

# Pull R2_* credentials from the app .env so this script needs no
# duplicated config. set -a exports every var; +a turns it off again.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "[$(date -Iseconds)] FATAL: env file $ENV_FILE not found" >&2
  exit 1
fi

# 1. Local dump
TS="$(date +%Y%m%d-%H%M%S)"
DUMP_PATH="${LOCAL_DIR}/oyechats-${TS}.sql.gz"
mkdir -p "$LOCAL_DIR"

echo "[$(date -Iseconds)] Dumping oyechats database -> $DUMP_PATH"
sudo -u postgres pg_dump oyechats | gzip > "$DUMP_PATH"
# Verify the gzip stream is intact before we trust the file. Catches mid-pipe
# corruption (disk full, OOM kill, NFS hiccup) that pg_dump's exit code may
# miss when the failure is downstream of pg_dump itself.
if ! gzip -t "$DUMP_PATH" 2>/dev/null; then
  echo "[$(date -Iseconds)] FATAL: dump failed integrity check ($DUMP_PATH)" >&2
  exit 1
fi
DUMP_SIZE_BYTES="$(stat -c%s "$DUMP_PATH" 2>/dev/null || stat -f%z "$DUMP_PATH")"
# A real oyechats dump is ~1+ MB gzipped; anything below 1 KB is clearly broken.
if [ "$DUMP_SIZE_BYTES" -lt 1024 ]; then
  echo "[$(date -Iseconds)] FATAL: dump suspiciously small (${DUMP_SIZE_BYTES} bytes)" >&2
  exit 1
fi
DUMP_SIZE_HUMAN="$(du -h "$DUMP_PATH" | cut -f1)"
echo "[$(date -Iseconds)] Local dump complete ($DUMP_SIZE_HUMAN)"

# 1.5 Restore drill (audit F18): gzip integrity + a size floor prove the FILE
# is intact, not that it RESTORES — a dump poisoned by a mid-write schema
# change or a truncated COPY block gunzips fine and still fails at the worst
# possible moment. Restore tonight's dump into a throwaway database and sanity
# check row-bearing tables. The dump is ~1 MB, so this costs seconds.
# Disable with BACKUP_RESTORE_CHECK=0 (e.g. on a disk-pressured host).
RESTORE_DB="${BACKUP_RESTORE_CHECK_DB:-oyechats_restore_check}"
if [[ "${BACKUP_RESTORE_CHECK:-1}" == "1" ]]; then
  echo "[$(date -Iseconds)] Restore drill: loading dump into throwaway db ${RESTORE_DB}"
  sudo -u postgres psql -q -c "DROP DATABASE IF EXISTS ${RESTORE_DB}" postgres
  sudo -u postgres psql -q -c "CREATE DATABASE ${RESTORE_DB}" postgres
  if ! gunzip -c "$DUMP_PATH" | sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "$RESTORE_DB" >/dev/null; then
    echo "[$(date -Iseconds)] FATAL: restore drill FAILED — tonight's dump does not restore cleanly ($DUMP_PATH)" >&2
    exit 1
  fi
  RESTORED_TABLES="$(sudo -u postgres psql -tA -d "$RESTORE_DB" \
    -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  RESTORED_CLIENTS="$(sudo -u postgres psql -tA -d "$RESTORE_DB" -c "SELECT count(*) FROM clients")"
  sudo -u postgres psql -q -c "DROP DATABASE ${RESTORE_DB}" postgres
  # The live schema has 25+ tables and at least one client row; a restore that
  # comes up short restored a husk, not the database.
  if [ "${RESTORED_TABLES:-0}" -lt 20 ] || [ "${RESTORED_CLIENTS:-0}" -lt 1 ]; then
    echo "[$(date -Iseconds)] FATAL: restore drill produced ${RESTORED_TABLES} tables / ${RESTORED_CLIENTS} clients — dump is incomplete" >&2
    exit 1
  fi
  echo "[$(date -Iseconds)] Restore drill OK (${RESTORED_TABLES} tables, ${RESTORED_CLIENTS} clients)"
fi

# 2. Off-site upload (B2 via boto3 — uses the API venv that already ships boto3)
if [[ -z "${R2_KEY_ID:-}" || -z "${R2_APPLICATION_KEY:-}" || -z "${R2_BUCKET_NAME:-}" || -z "${R2_ENDPOINT:-}" ]]; then
  echo "[$(date -Iseconds)] WARN: R2_* credentials missing in $ENV_FILE — skipping off-site upload" >&2
else
  REMOTE_KEY="${REMOTE_PREFIX}/oyechats-${TS}.sql.gz"
  # R2_ENDPOINT in .env is sometimes stored bare (no scheme) for parity
  # with the S3-style env var convention. boto3 requires a scheme — add
  # one if it's missing so the script works with either form.
  case "$R2_ENDPOINT" in
    http://*|https://*) ;;
    *) R2_ENDPOINT="https://${R2_ENDPOINT}" ;;
  esac
  export R2_ENDPOINT
  echo "[$(date -Iseconds)] Uploading to bucket=${R2_BUCKET_NAME} key=${REMOTE_KEY}"
  # Pass dump path + remote key via env vars and use a quoted heredoc so bash
  # doesn't interpolate anything into the Python source. Keeps file paths and
  # keys safely outside the parser even if they ever contain a quote or $.
  DUMP_PATH="$DUMP_PATH" REMOTE_KEY="$REMOTE_KEY" "$VENV_PY" <<'PYEOF'
import os
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["R2_ENDPOINT"],
    aws_access_key_id=os.environ["R2_KEY_ID"],
    aws_secret_access_key=os.environ["R2_APPLICATION_KEY"],
    config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
)
dump_path = os.environ["DUMP_PATH"]
remote_key = os.environ["REMOTE_KEY"]
with open(dump_path, "rb") as f:
    s3.put_object(
        Bucket=os.environ["R2_BUCKET_NAME"],
        Key=remote_key,
        Body=f,
        ContentType="application/gzip",
    )
print(f"[remote] uploaded {os.path.getsize(dump_path)} bytes")
PYEOF
  echo "[$(date -Iseconds)] Off-site upload OK"

  # 3. Remote retention — list + delete anything older than N days under the prefix.
  echo "[$(date -Iseconds)] Pruning remote backups older than ${REMOTE_RETENTION_DAYS} days"
  REMOTE_PREFIX="$REMOTE_PREFIX" REMOTE_RETENTION_DAYS="$REMOTE_RETENTION_DAYS" "$VENV_PY" <<'PYEOF'
import os
from datetime import datetime, timedelta, timezone
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["R2_ENDPOINT"],
    aws_access_key_id=os.environ["R2_KEY_ID"],
    aws_secret_access_key=os.environ["R2_APPLICATION_KEY"],
    config=Config(signature_version="s3v4"),
)
prefix = os.environ["REMOTE_PREFIX"]
retention_days = int(os.environ["REMOTE_RETENTION_DAYS"])
cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
deleted = 0
paginator = s3.get_paginator("list_objects_v2")
for page in paginator.paginate(Bucket=os.environ["R2_BUCKET_NAME"], Prefix=f"{prefix}/"):
    for obj in page.get("Contents", []) or []:
        if obj["LastModified"] < cutoff:
            s3.delete_object(Bucket=os.environ["R2_BUCKET_NAME"], Key=obj["Key"])
            deleted += 1
print(f"[remote] pruned {deleted} objects older than {retention_days} days")
PYEOF
fi

# 4. Local retention — unchanged from the legacy script, kept for fast restore
echo "[$(date -Iseconds)] Pruning local backups older than ${LOCAL_RETENTION_DAYS} days"
find "$LOCAL_DIR" -name 'oyechats-*.sql.gz' -mtime +${LOCAL_RETENTION_DAYS} -delete

echo "[$(date -Iseconds)] Backup run complete"
