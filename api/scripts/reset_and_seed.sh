#!/usr/bin/env bash
# Reset the local database and re-seed it from scratch — in one command.
#
#   cd api && ./scripts/reset_and_seed.sh          # prompts before wiping
#   cd api && ./scripts/reset_and_seed.sh -y        # skip the confirmation
#   cd api && ./scripts/reset_and_seed.sh -y --no-superadmin
#
# What it does, in order:
#   1. Resolve DB_URL from the app config (single source of truth) and REFUSE to
#      run against anything but a local database — this must never touch prod.
#   2. Drop and recreate the `public` schema (wipes ALL data + tables + the
#      alembic version stamp) and re-create the `vector`/`citext` extensions.
#      (alembic's env.py does not create the pgvector extension, and the initial
#      migration needs it, so we create it here before migrating.)
#   3. `alembic upgrade head` — rebuilds the SCHEMA ONLY. Migrations seed no
#      plan rows (see b6c86b4c8434), so data-only migrations that target a plan
#      — e.g. f1a2b3c4d5e6, which deactivates Enterprise — match zero rows here
#      and the seed below inserts the rows fresh.
#   4. Seed the plan matrix + pricing config, then an idempotent super-admin
#      account (skip the last with --no-superadmin). Every tier is LISTED; the
#      seed sets `is_active` only on rows it creates and never on rows it
#      updates, so a deliberate deactivation survives a re-run. Paid tiers are
#      listed but not self-serve until step 5 attaches ids that can charge them
#      — until then their checkout degrades to contact-sales.
#
# After it finishes the DB is empty of customer accounts, so you can sign up a
# fresh account through the dashboard and walk the onboarding flow end-to-end.

set -euo pipefail
cd "$(dirname "$0")/.."

PY=".venv/bin/python"
ASSUME_YES=0
SEED_SUPERADMIN=1

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --no-superadmin) SEED_SUPERADMIN=0 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument '$arg' (see --help)" >&2
      exit 2
      ;;
  esac
done

if [ ! -x "$PY" ]; then
  echo "error: $PY not found — run from api/ with the venv set up (uv sync)" >&2
  exit 1
fi

# ── 1. Resolve DB_URL + host from the app config (never guess) ───────────────
# Emits two lines: the full URL, then the host. Any config error aborts.
read -r DB_URL DB_HOST <<EOF
$("$PY" - <<'PYEOF'
from urllib.parse import urlparse

from app.config import DB_URL

if not DB_URL:
    raise SystemExit("DB_URL is not configured (check api/.env)")
print(DB_URL, urlparse(DB_URL).hostname or "")
PYEOF
)
EOF

# ── Safety guard: local databases only ───────────────────────────────────────
case "$DB_HOST" in
  localhost|127.0.0.1|::1|"")
    ;;
  *)
    echo "REFUSING to reset: DB host '$DB_HOST' is not local." >&2
    echo "This script only wipes localhost databases. Aborting." >&2
    exit 1
    ;;
esac

echo "==> Target database: $DB_URL"
echo "    This will PERMANENTLY DELETE every table and row in that database."

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "    Type 'reset' to continue: "
  read -r reply
  if [ "$reply" != "reset" ]; then
    echo "Aborted."
    exit 1
  fi
fi

# ── 2. Wipe schema + re-create required extensions ───────────────────────────
echo "==> Dropping and recreating the public schema"
psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;
SQL

# ── 3. Rebuild schema via migrations ─────────────────────────────────────────
echo "==> alembic upgrade head (schema)"
"$PY" -m alembic upgrade head

# ── 4. Seed the canonical plan matrix + credit pricing config ────────────────
echo "==> Seeding plans (Free/Starter/Standard/Professional/Enterprise)"
"$PY" scripts/seed_plans.py --apply
echo "==> Seeding pricing_config (credit costs, seat price, top-up packs)"
"$PY" scripts/seed_pricing_config.py --apply

# ── 5. Seed super-admin ──────────────────────────────────────────────────────
if [ "$SEED_SUPERADMIN" -eq 1 ]; then
  echo "==> Seeding super-admin account"
  "$PY" scripts/seed_superadmin.py
else
  echo "==> Skipping super-admin seed (--no-superadmin)"
fi

echo ""
echo "==> Done. Database reset and seeded."
echo "    Every paid tier is LISTED but not yet SELF-SERVE — a plan with no Razorpay"
echo "    plan id cannot complete a checkout, so it quotes contact-sales instead."
echo "    Next: attach this environment's Razorpay plan IDs (that opens self-serve"
echo "    checkout), e.g."
echo "      uv run python scripts/set_razorpay_plan_ids.py --apply \\"
echo "        --starter-monthly <id> --starter-annual <id> \\"
echo "        --standard-monthly <id> --standard-annual <id> \\"
echo "        --professional-monthly <id> --professional-annual <id>"
echo "    The ready-made command carrying this environment's real ids (both rails,"
echo "    including Enterprise) is in docs/billing/razorpay-plan-ids.md."
echo "    Then sign up a fresh account in the dashboard to test onboarding."
