#!/usr/bin/env bash
# migrate-to-nonroot.sh, one-time droplet migration for audit finding F06:
# drop the long-running oyechats-api / oyechats-worker services from root to a
# dedicated unprivileged `oyechats` system user.
#
# What it does (idempotent. Safe to re-run):
#   1. Creates the `oyechats` system user/group (nologin, no home).
#   2. Grants the service user traverse access along /opt/oyechats/platform.
#   3. Makes api/.env group-readable by `oyechats` only (root:oyechats 0640),
#      it holds every production secret, so it must NOT become world-readable.
#   4. Chowns the two runtime-write dirs (documents/, archive/) to the service
#      user; the rest of the checkout stays root-owned so root deploys keep
#      working unchanged and the service cannot modify its own code.
#   5. Normalizes .venv permissions (root's umask 022 already makes it
#      world-readable; this is a belt-and-braces pass for wheels that ship
#      restrictive modes).
#   6. Pre-creates /var/cache/oyechats (the service's HOME / XDG_CACHE_HOME).
#   7. Preflight-probes AS THE SERVICE USER: .env readability, venv imports,
#      a real WeasyPrint PDF render, and an R2 upload+delete round trip.
#   8. Installs the User=oyechats units from this checkout, restarts the
#      services (worker first - /health/full gates on its heartbeat), and
#      verifies /health/full.
#   9. Prints the rollback procedure.
#
# Usage (as root on the droplet):
#   bash /opt/oyechats/platform/api/scripts/migrate-to-nonroot.sh
#
# `--prepare-only` runs steps 1 to 6 (user + file grants) and stops before the
# probes and unit install. The deploy workflow calls this mode right before
# installing units, so a droplet that never ran the full migration still gets
# the prerequisites created inline. Merging the F06 units can never strand
# the services on a missing user (the ordering hazard in review).
#
# Deploys are unaffected: GitHub Actions still SSHes as root and runs
# git reset / uv sync / alembic / unit install as root. Only the long-running
# services drop privileges.

set -euo pipefail

PREPARE_ONLY=0
if [[ "${1:-}" == "--prepare-only" ]]; then
  PREPARE_ONLY=1
elif [[ -n "${1:-}" ]]; then
  echo "ERROR: unknown argument '${1}' (only --prepare-only is supported)" >&2
  exit 2
fi

SERVICE_USER="oyechats"
SERVICE_GROUP="oyechats"
PLATFORM_DIR="/opt/oyechats/platform"
APP_DIR="${PLATFORM_DIR}/api"
CACHE_DIR="/var/cache/oyechats"
HEALTH_URL="http://127.0.0.1:8000/health/full"

# Units are installed from the checkout THIS script lives in, so running a
# fetched development copy installs the matching new units.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$(cd "${SCRIPT_DIR}/../systemd" && pwd)"

log()  { echo "==> $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

print_rollback() {
  cat <<'EOF'
────────────────────────────────────────────────────────────────────────────
ROLLBACK PROCEDURE (if the non-root services misbehave)
  1. Flip the installed units back to root (leaves the rest of the
     hardening in place, it was already active while running as root):
       sed -i -e 's/^User=oyechats/User=root/' -e 's/^Group=oyechats/Group=root/' \
         /etc/systemd/system/oyechats-api.service \
         /etc/systemd/system/oyechats-worker.service
  2. systemctl daemon-reload
  3. systemctl restart oyechats-worker && systemctl restart oyechats-api
  4. curl -sf http://127.0.0.1:8000/health/full && echo OK
  Full revert (exact pre-F06 units): restore api/systemd/*.service from the
  last pre-F06 commit on main, cp to /etc/systemd/system/, daemon-reload,
  restart. The permission changes made by this script (group-read .env,
  documents/archive ownership) are harmless under root and need no undo.
────────────────────────────────────────────────────────────────────────────
EOF
}

[[ "$(id -u)" -eq 0 ]] || fail "must run as root"
[[ -d "${APP_DIR}" ]] || fail "${APP_DIR} not found. Is this the droplet?"
[[ -f "${APP_DIR}/.env" ]] || fail "${APP_DIR}/.env not found. Deploy has never written it?"
[[ -d "${APP_DIR}/.venv" ]] || fail "${APP_DIR}/.venv not found, run 'uv sync' first"

# Refuse to install units that don't actually drop privileges (e.g. script
# run from an old checkout that still has User=root units).
for unit in oyechats-api.service oyechats-worker.service; do
  [[ -f "${UNIT_SRC}/${unit}" ]] || fail "${UNIT_SRC}/${unit} missing"
  grep -q '^User=oyechats$' "${UNIT_SRC}/${unit}" \
    || fail "${UNIT_SRC}/${unit} does not set User=oyechats. Fetch the F06 units first"
done

# ── 1. Service user/group ────────────────────────────────────────────────────
log "1/8 Creating system group '${SERVICE_GROUP}' (if missing)"
getent group "${SERVICE_GROUP}" >/dev/null || groupadd --system "${SERVICE_GROUP}"

log "1/8 Creating system user '${SERVICE_USER}' (nologin, no home; if missing)"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system \
    --gid "${SERVICE_GROUP}" \
    --no-create-home \
    --home-dir /nonexistent \
    --shell /usr/sbin/nologin \
    --comment "OyeChats service account (F06)" \
    "${SERVICE_USER}"
fi
# NOTE: journal access for the super-admin logs endpoint is granted
# declaratively via SupplementaryGroups=systemd-journal in the API unit,
# no usermod needed here.

# ── 2. Path traversal ────────────────────────────────────────────────────────
# The checkout stays root-owned (root deploys keep working; the service can't
# modify its own code), the service only needs read+execute along the path.
# Root's umask 022 already leaves tracked files world-readable; these chmods
# only guarantee directory traversal.
log "2/8 Ensuring traverse (o+rx) on /opt/oyechats → ${APP_DIR}"
chmod 755 /opt/oyechats "${PLATFORM_DIR}" "${APP_DIR}"

# ── 3. Secrets file ──────────────────────────────────────────────────────────
# .env holds every production secret: readable by root + the service group
# ONLY (0640), never world-readable. The deploy workflow re-asserts this after
# each rewrite (see .github/workflows/deploy-api.yml).
log "3/8 Restricting ${APP_DIR}/.env to root:${SERVICE_GROUP} 0640"
chown root:"${SERVICE_GROUP}" "${APP_DIR}/.env"
chmod 640 "${APP_DIR}/.env"
if [[ -f "${APP_DIR}/.env.rollback" ]]; then
  # Deploy-time rollback snapshot. Only root reads it; keep it root-only.
  chown root:root "${APP_DIR}/.env.rollback"
  chmod 600 "${APP_DIR}/.env.rollback"
fi

# ── 4. Runtime write directories ─────────────────────────────────────────────
# The ONLY paths the app writes under the checkout (see the unit files'
# ReadWritePaths and app/config.py DOCUMENTS_DIR / ARCHIVE_DIR).
log "4/8 Chowning runtime-write dirs (documents/, archive/) to ${SERVICE_USER}"
for dir in documents archive; do
  install -d "${APP_DIR}/${dir}"
  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}/${dir}"
  chmod 750 "${APP_DIR}/${dir}"
  # Tenant uploads must not be world-readable.
  chmod -R o-rwx "${APP_DIR}/${dir}"
done

# ── 5. Virtualenv readability ────────────────────────────────────────────────
# uv sync runs as root with umask 022, so the venv is normally already
# group/world-readable. Belt-and-braces: normalize in case any wheel shipped
# restrictive modes. (Ownership stays root, the service must NOT be able to
# rewrite its own interpreter/packages.)
log "5/8 Normalizing .venv permissions (u+rwX,go+rX)"
chmod -R u+rwX,go+rX "${APP_DIR}/.venv"

# ── 6. Cache/home directory ──────────────────────────────────────────────────
# The units set HOME/XDG_CACHE_HOME here (fontconfig for WeasyPrint, etc.).
# systemd's CacheDirectory= would create it on service start; pre-create it so
# the preflight probes below can use it too.
log "6/8 Creating ${CACHE_DIR} (service HOME / XDG_CACHE_HOME)"
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 750 "${CACHE_DIR}"

if [[ "${PREPARE_ONLY}" -eq 1 ]]; then
  log "--prepare-only: prerequisites in place; skipping probes + unit install."
  exit 0
fi

# ── 7. Preflight probes AS THE SERVICE USER (before touching the units) ─────
run_as_service() {
  # runuser ignores the account's nologin shell when given an explicit command.
  runuser -u "${SERVICE_USER}" -- env \
    HOME="${CACHE_DIR}" XDG_CACHE_HOME="${CACHE_DIR}" "$@"
}

log "7/8 Probe: ${SERVICE_USER} can read .env"
run_as_service test -r "${APP_DIR}/.env" || fail ".env not readable by ${SERVICE_USER}"
echo "    ok"

log "7/8 Probe: ${SERVICE_USER} can import the venv (gunicorn, arq, boto3)"
run_as_service "${APP_DIR}/.venv/bin/python" -c \
  "import gunicorn, arq, boto3; print('    ok')" \
  || fail "venv import probe failed as ${SERVICE_USER}. Check .venv permissions"

log "7/8 Probe: WeasyPrint PDF render as ${SERVICE_USER} (pango + fontconfig)"
run_as_service "${APP_DIR}/.venv/bin/python" -c \
  "import weasyprint; pdf = weasyprint.HTML(string='<p>F06 probe</p>').write_pdf(); assert pdf[:4] == b'%PDF'; print('    ok (%d bytes)' % len(pdf))" \
  || fail "WeasyPrint render probe failed as ${SERVICE_USER}"

log "7/8 Probe: R2 upload+delete round trip as ${SERVICE_USER}"
R2_PROBE="$(mktemp /tmp/f06-r2-probe-XXXXXX.py)"
cat > "${R2_PROBE}" <<'PY'
"""F06 migration probe: verify the service user can reach Cloudflare R2.

Mirrors app/services/r2_service.py client construction (endpoint is a bare
hostname; sigv4; region auto). Uploads and immediately deletes one tiny object.
"""
import os
import sys
import uuid

import boto3
from botocore.config import Config

endpoint = os.environ.get("R2_ENDPOINT", "").strip()
key_id = os.environ.get("R2_KEY_ID", "").strip()
secret = os.environ.get("R2_APPLICATION_KEY", "").strip()
bucket = os.environ.get("R2_BUCKET_NAME", "").strip()

if not all([endpoint, key_id, secret, bucket]):
    print("    skipped. R2_* not configured in .env")
    sys.exit(0)

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://{endpoint}",
    aws_access_key_id=key_id,
    aws_secret_access_key=secret,
    region_name="auto",
    config=Config(signature_version="s3v4"),
)
probe_key = f"f06-probe/{uuid.uuid4()}.txt"
s3.put_object(Bucket=bucket, Key=probe_key, Body=b"F06 non-root migration probe")
s3.delete_object(Bucket=bucket, Key=probe_key)
print(f"    ok (put+delete s3://{bucket}/{probe_key})")
PY
chmod 644 "${R2_PROBE}"
# Extract ONLY the R2_* keys from .env, never `source` the whole file: it is
# written for python-dotenv/systemd (values literal to end of line), not for
# shell. VAPID_PRIVATE_KEY is an unquoted PEM with spaces that bash would
# word-split into a command. Reading the file as the service user also
# exercises the group-read grant from step 3 end to end.
runuser -u "${SERVICE_USER}" -- bash -c "
  set -euo pipefail
  while IFS= read -r line; do
    case \"\$line\" in
      R2_KEY_ID=* | R2_APPLICATION_KEY=* | R2_BUCKET_NAME=* | R2_ENDPOINT=*)
        export \"\${line?}\"
        ;;
    esac
  done < '${APP_DIR}/.env'
  export HOME='${CACHE_DIR}' XDG_CACHE_HOME='${CACHE_DIR}'
  exec '${APP_DIR}/.venv/bin/python' '${R2_PROBE}'
" || { rm -f "${R2_PROBE}"; fail "R2 probe failed as ${SERVICE_USER}"; }
rm -f "${R2_PROBE}"

# ── 8. Install units, restart, verify ────────────────────────────────────────
log "8/8 Installing User=${SERVICE_USER} units from ${UNIT_SRC}"
cp "${UNIT_SRC}/oyechats-api.service" /etc/systemd/system/
cp "${UNIT_SRC}/oyechats-worker.service" /etc/systemd/system/
systemctl daemon-reload

log "8/8 Restarting services (worker first - /health/full gates on its heartbeat)"
systemctl restart oyechats-worker
systemctl restart oyechats-api

log "8/8 Waiting for ${HEALTH_URL} (up to 60s)"
sleep 15
healthy=0
for attempt in 1 2 3 4 5 6 7 8 9; do
  if curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  echo "    attempt ${attempt} failed, retrying in 5s..."
  sleep 5
done

if [[ "${healthy}" -ne 1 ]]; then
  echo "ERROR: /health/full did not go green after migration." >&2
  systemctl status oyechats-api oyechats-worker --no-pager || true
  journalctl -u oyechats-api -n 30 --no-pager || true
  journalctl -u oyechats-worker -n 20 --no-pager || true
  print_rollback
  exit 1
fi

echo
log "Verifying the services actually dropped privileges"
for svc in oyechats-api oyechats-worker; do
  pid="$(systemctl show -p MainPID --value "${svc}")"
  runtime_user="$(ps -o user= -p "${pid}" | tr -d ' ')"
  echo "    ${svc}: MainPID=${pid} user=${runtime_user}"
  [[ "${runtime_user}" == "${SERVICE_USER}" ]] || fail "${svc} is still running as '${runtime_user}'"
done

echo
log "MIGRATION COMPLETE. Oyechats-api and oyechats-worker run as '${SERVICE_USER}', /health/full is green."
echo "    Next: exercise a document upload + ingestion, an invoice PDF render,"
echo "    and the super-admin logs page (journalctl access) before signing off."
print_rollback
