# OyeChats — Deployment Guide

## Infrastructure Overview

| Service | Domain | Hosted On | Vercel Project | Cost |
|---------|--------|-----------|----------------|------|
| Landing Page | `oyechats.com` · `www.oyechats.com` | Vercel | `oyechats-website` | Free |
| Customer Admin Dashboard | `app.oyechats.com` | Vercel (monorepo, root = `app/`) | `oye-chats-platform` | Free |
| Super Admin Console | `admin.oyechats.com` | Vercel (separate repo `digibranders/oyechats-admin`) | `superadmin` | Free |
| Backend API | `api.oyechats.com` | DigitalOcean Droplet (4 GB / 2 vCPU) | — | see DO billing |
| Widget CDN | `cdn.oyechats.com` | Cloudflare R2 | — | ~$0 |
| Database | (on droplet) | PostgreSQL 16 + pgvector | — | $0 (included) |

> The droplet was upsized from the 2 GB / 1 vCPU box this file used to describe;
> confirm the current line item in the DigitalOcean billing panel rather than
> trusting a figure here, which is exactly how the old one went stale.

## GitHub Repos

- **`digibranders/oye-chats-platform`** — Backend (`api/`), Widget (`widget/`), Customer Admin (`app/`)
- **`digibranders/oyechats-admin`** — Super Admin console (Next.js)
- **`oyechats-website`** — Marketing site (Next.js)

## DNS Records

Set these at your domain registrar:

```
oyechats.com          CNAME   cname.vercel-dns.com   # marketing site
www.oyechats.com      CNAME   cname.vercel-dns.com   # marketing site
app.oyechats.com      CNAME   cname.vercel-dns.com   # customer admin dashboard
admin.oyechats.com    CNAME   cname.vercel-dns.com   # super admin console
api.oyechats.com      A       <droplet-ip>           # backend
cdn.oyechats.com      CNAME   <r2-public-domain>     # widget CDN
```

---

## Step 1: DigitalOcean Droplet (Backend + DB)

### 1.1 Provision
- **Image**: Ubuntu 24.04 LTS
- **Size**: 4 GB RAM / 2 vCPU, plus a 2 GB swapfile
- **Region**: BLR (Bangalore) or closest to users
- Add your SSH key during creation
- **User**: root only (no additional users)

### 1.2 Initial Setup
```bash
ssh root@<droplet-ip>

# Update system
apt update && apt upgrade -y

# Install Python 3.11 (Ubuntu 24.04 ships 3.12, we need 3.11)
apt install -y software-properties-common
add-apt-repository -y ppa:deadsnakes/ppa
apt update
apt install -y python3.11 python3.11-venv python3.11-dev

# Install system dependencies
apt install -y \
  postgresql-16 postgresql-16-pgvector \
  nginx certbot python3-certbot-nginx \
  git curl build-essential libpq-dev

# Install uv (Python package manager)
curl -LsSf https://astral.sh/uv/install.sh | sh
source /root/.bashrc
```

### 1.3 Setup PostgreSQL
```bash
systemctl enable postgresql
systemctl start postgresql

sudo -u postgres psql <<SQL
CREATE USER oyechats WITH PASSWORD '<STRONG_PASSWORD>';
CREATE DATABASE oyechats OWNER oyechats;
\c oyechats
CREATE EXTENSION IF NOT EXISTS vector;
SQL
```

### 1.4 Deploy Backend
```bash
mkdir -p /opt/oyechats
cd /opt/oyechats
git clone https://github.com/digibranders/oye-chats-platform.git platform
cd platform/api

# Configure environment
cp .env.example .env
nano .env
```

**Required .env values:**
```
DB_URL=postgresql://oyechats:<STRONG_PASSWORD>@localhost:5432/oyechats
OPENAI_API_KEY=<your-openai-api-key>
GOOGLE_API_KEY=<your-gemini-api-key>
APP_ENV=production
CORS_ORIGINS=https://oyechats.com,https://www.oyechats.com,https://app.oyechats.com,https://admin.oyechats.com
```

**Optional .env values:**
```
LLM_MODEL=openai/gpt-5.4-mini
R2_KEY_ID=<cloudflare-r2-access-key-id>
R2_APPLICATION_KEY=<cloudflare-r2-secret-access-key>
R2_BUCKET_NAME=<bucket-name>
R2_ENDPOINT=<r2-s3-endpoint>
SENTRY_DSN_BACKEND=<sentry-dsn>
LANGFUSE_SECRET_KEY=<langfuse-secret>
LANGFUSE_PUBLIC_KEY=<langfuse-public>
LANGFUSE_HOST=https://cloud.langfuse.com
BREVO_API_KEY=<brevo-key>
```

```bash
# Install dependencies and run migrations
uv sync
uv run alembic upgrade head
```

> There is **no** browser install step. Playwright and crawl4ai were removed;
> crawling is HTTP-only against Jina Reader (primary) and Spider.cloud
> (fallback), both off-box. See `CRAWL_PROVIDER_PRIMARY` in the secrets table
> below.

### 1.5 Install the Systemd Units

> **Use the checked-in units in `api/systemd/` — do NOT hand-write them.** They
> are the source of truth and `deploy-api.yml` re-copies them on every deploy,
> so anything hand-typed here is overwritten at the next release. They also
> carry things a minimal unit drops: `User=oyechats` with `ProtectSystem=strict`
> (see "Migrating services to non-root" below), the venv binary invoked
> directly rather than through `uv run`, `WEB_CONCURRENCY`, DB pool sizing and
> `LimitNOFILE`. The API runs under **Gunicorn** with `gunicorn.conf.py`, not a
> bare `uvicorn --workers`.

```bash
cd /opt/oyechats/platform/api

# Create the service user + file grants the units need (idempotent).
bash scripts/migrate-to-nonroot.sh

# Install the units (the deploy does this too; this is the first-time path).
cp systemd/oyechats-api.service     /etc/systemd/system/
cp systemd/oyechats-worker.service  /etc/systemd/system/
cp systemd/oyechats-backup.service  /etc/systemd/system/
cp systemd/oyechats-backup.timer    /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now oyechats-api oyechats-worker
systemctl enable --now oyechats-backup.timer

# Verify
systemctl status oyechats-api oyechats-worker
curl -sf http://127.0.0.1:8000/health/full
```

**Optional: the WebSocket process split.** `api/systemd/oyechats-ws.service`
serves `/ws/*` from a dedicated **single-worker** Gunicorn on 127.0.0.1:8001,
which is what allows `oyechats-api.service` to run `WEB_CONCURRENCY=2` without
splitting live-chat sockets across workers. It is **not installed by the
deploy** — `deploy-api.yml` only restarts it *if it already exists* — so it is
an explicit, staged rollout. Order matters and is non-negotiable:

```bash
# 1. install + start the WS unit
cp systemd/oyechats-ws.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now oyechats-ws
# 2. point nginx's `location /ws/` at the oyechats_ws upstream (already in the
#    checked-in nginx/oyechats-locations.conf) and reload
# 3. set the WS_BACKPLANE_ENABLED repo variable to true and redeploy
# 4. only then raise WEB_CONCURRENCY on oyechats-api.service
```

Workers first would break live chat. The unit file's own header carries the
measurements and the reasoning; read it before touching this.

### 1.6 Nginx Reverse Proxy

> **Use the checked-in hardened templates in `api/nginx/` — do NOT hand-write
> the config.** The repo templates carry protections a minimal proxy block
> silently drops: Cloudflare real-IP validation (`CF-Connecting-IP` is
> attacker-controlled unless the connection provably comes from a Cloudflare
> edge), per-IP rate limiting, security headers, WebSocket/SSE handling, and
> connection limits. A hand-typed config is exactly how a box drifts from the
> hardened templates (audit F21).

```bash
# Install the three templates from the repo (source of truth)
mkdir -p /etc/nginx/snippets
cp /opt/oyechats/platform/api/nginx/cloudflare-real-ip.conf /etc/nginx/snippets/
cp /opt/oyechats/platform/api/nginx/oyechats-locations.conf /etc/nginx/snippets/
cp /opt/oyechats/platform/api/nginx/oyechats-api.conf /etc/nginx/sites-available/oyechats-api

ln -s /etc/nginx/sites-available/oyechats-api /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# SSL (after DNS is pointed) — then flip the HTTP→HTTPS redirect inside
# oyechats-api.conf as its header comments describe.
certbot --nginx -d api.oyechats.com
```

Cloudflare publishes its edge ranges at <https://www.cloudflare.com/ips/>;
refresh `cloudflare-real-ip.conf` when they change (see that file's header).

### 1.7 Firewall
```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

### 1.8 Database Backups

The backup pipeline is fully committed to the repo — script
(`api/scripts/backup.sh`: local dump → gzip integrity + size floor → restore
drill into a throwaway DB → off-site R2 upload → retention pruning) and
schedule (`api/systemd/oyechats-backup.timer`, nightly 03:00 UTC). Do NOT
hand-write a cron line; the deploy workflow installs and enables the timer
automatically. Manual first-time setup:

```bash
mkdir -p /opt/oyechats/backups
chmod +x /opt/oyechats/platform/api/scripts/backup.sh
cp /opt/oyechats/platform/api/systemd/oyechats-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now oyechats-backup.timer

# Verify: run one backup now and read its log
systemctl start oyechats-backup
journalctl -u oyechats-backup -n 30 --no-pager
```

---

## Step 2: Cloudflare R2 (Widget CDN)

1. Go to **Cloudflare Dashboard → R2**
2. Create bucket: `oyechats-cdn`
3. Enable **public access** on the bucket
4. Go to **Settings → Custom Domains** → add `cdn.oyechats.com`
5. Set CORS policy:
   ```json
   [{"AllowedOrigins": ["*"], "AllowedMethods": ["GET"], "AllowedHeaders": ["*"]}]
   ```

### Manual Upload (first time)
The build emits a loader plus a directory of hashed chunks — there is no
`oyechats-widget.css` at the bucket root:

```
dist/oyechats-widget.js              ← loader IIFE (mutable: must revalidate, purge on deploy)
dist/app/manifest.json               ← chunk manifest (mutable: must revalidate, purge on deploy)
dist/app/oyechats-*.{js,css}         ← hashed chunks (immutable: 1y cache, no purge)
```

```bash
cd widget
VITE_API_URL=https://api.oyechats.com npm run build
npx wrangler r2 object put oyechats-cdn/oyechats-widget.js --file dist/oyechats-widget.js --remote
npx wrangler r2 object put oyechats-cdn/app/manifest.json  --file dist/app/manifest.json  --remote
for f in dist/app/oyechats-*.js dist/app/oyechats-*.css; do
  npx wrangler r2 object put "oyechats-cdn/app/$(basename "$f")" --file "$f" --remote
done
```

> `--remote` is not optional. On wrangler 4 `r2 object put` **defaults to local
> storage**, so without it the upload silently succeeds against nothing.
> `deploy-widget.yml` uses `widget/scripts/r2-put.sh`, which forces it.

After this, `deploy-widget.yml` handles subsequent deploys automatically —
including the cache-control split and the purge of the two mutable files.

---

## Step 3: Vercel (Admin + Landing Page)

### Customer Admin Dashboard
1. Go to **vercel.com** → Import `digibranders/oye-chats-platform` repo
2. Configure:
   - **Root Directory**: `app`
   - **Framework Preset**: Vite
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
3. Add environment variable: `VITE_API_URL` = `https://api.oyechats.com`
4. Add custom domain: `app.oyechats.com`
5. **Leave the Git integration off.** `app/vercel.json` sets
   `git.deploymentEnabled.main: false`, and the deploy is triggered from
   `deploy-app.yml` by a Deploy Hook instead — *after* the backend for that
   same commit reports `/health/full` green. Vercel builds a Vite SPA in about
   two minutes while `deploy-api.yml` runs CI, migrates over SSH and waits on
   health, so the Git integration reliably put a dashboard live against a
   backend that did not yet have its endpoints. Create the hook under
   **Settings → Git** on the `main` branch and store the URL as the repository
   secret `VERCEL_DEPLOY_HOOK_URL`; that URL is a credential. Do **not** add
   the deprecated `github.enabled: false` — it breaks the hook too.

### Super Admin Console
1. Import `digibranders/oyechats-admin` repo in Vercel (separate repo, lives in sibling `superadmin/` directory locally)
2. Framework auto-detected as Next.js (root = repo root)
3. Add environment variable: `NEXT_PUBLIC_API_URL` = `https://api.oyechats.com`
4. Add custom domain: `admin.oyechats.com`

### Landing Page
1. Import `oyechats-website` repo in Vercel
2. Framework auto-detected as Next.js
3. Add custom domains: `oyechats.com` and `www.oyechats.com`

The landing page and the super-admin console auto-deploy on every push to `main`.
The customer admin dashboard does not — see the note above; it deploys from
`deploy-app.yml` once the API for that commit is healthy.

---

## Step 4: GitHub Actions Secrets

Set these in **GitHub → Settings → Secrets and variables → Actions**:

### Platform Repo (`digibranders/oye-chats-platform`)
| Secret | Value |
|--------|-------|
| `DO_HOST` | Droplet IP address |
| `DO_USER` | `root` |
| `DO_SSH_KEY` | Private SSH key (for droplet access) |
| `DB_URL` | `postgresql://oyechats:<PASSWORD>@localhost:5432/oyechats` |
| `GOOGLE_API_KEY` | Google Gemini API key (LiteLLM fallback) |
| `OPENAI_API_KEY` | OpenAI API key (primary LLM) |
| `CRAWL_PROVIDER_PRIMARY` | Which scrape backend page fetches try first: `jina` (default) or `spider`. The other becomes the fallback. There is no local crawler; Playwright was removed and both providers render off-box |
| `SPIDER_API_KEY` | Spider.cloud prepaid API key |
| `SPIDER_REQUEST_MODE` | Spider engine: `smart` (default), `http`, or `chrome` |
| `JINA_API_KEY` | Jina Reader key. Also used for demo-page screenshot capture |
| `WIDGET_SCRIPT_URL` | Widget loader the hosted demo page embeds. Defaults to the production CDN; set per environment so a staging demo does not load the live widget build |
| `DEMO_SCREENSHOT_ENABLED` | `true` (default) captures the customer's site as the demo-page backdrop |
| `DEMO_SCREENSHOT_PROVIDER` | Capture backend tried first: `jina` (default) or `spider` |
| `DEMO_SCREENSHOT_WAIT_SECONDS` | Render settle time before capture, default `30`. Raise if captures come back with blank bands where lazily loaded media belongs |
| `DEMO_SCREENSHOT_TTL_DAYS` | Days a stored capture stays fresh, default `30`. Past this the next training run recaptures |
| `CORS_ORIGINS` | `https://oyechats.com,https://www.oyechats.com,https://app.oyechats.com,https://admin.oyechats.com` |
| `R2_KEY_ID` | Cloudflare R2 access key ID (the `R2_` prefix is literal; legacy `B2_*` names are still accepted as fallbacks in `config.py`) |
| `R2_APPLICATION_KEY` | Cloudflare R2 secret access key |
| `R2_BUCKET_NAME` | Cloudflare R2 bucket name |
| `R2_ENDPOINT` | Cloudflare R2 S3-compatible endpoint |
| `SENTRY_DSN_BACKEND` | Sentry DSN for backend |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key |
| `CF_API_TOKEN` | Cloudflare API token (R2 write access, for widget deploy) |
| `CF_ACCOUNT_ID` | Cloudflare account ID (for widget deploy) |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID (Sign in with Google) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth web client secret |
| `OAUTH_STATE_SECRET` | Stable random string signing the OAuth state cookie; shared across Gunicorn workers |
| `VERCEL_DEPLOY_HOOK_URL` | Vercel Deploy Hook for the admin dashboard, fired by `deploy-app.yml` after the backend is healthy. A credential — anyone holding it can deploy the project |

Repository **variables** (not secrets) that change behaviour:

| Variable | Value |
|----------|-------|
| `RELEVANCE_GATE_ENABLED` | Scope enforcement. `deploy-api.yml` writes `${RELEVANCE_GATE_ENABLED:-true}`, so an unset variable lands as `true`. It must never be re-emitted as a bare `${VAR}`: that writes an empty-but-present key, systemd's `EnvironmentFile=` returns `""`, and `""` is not truthy — which silently disabled the gate in production once already |
| `WS_BACKPLANE_ENABLED` | Redis fan-out for live chat. Set `true` **only** once `oyechats-ws.service` is installed and nginx routes `/ws/` to it |
| `INTL_PAYMENTS_ENABLED` | Opens the USD rail; defaults false so an unset variable keeps domestic-only behaviour |

> **Google OAuth note:** `GOOGLE_REDIRECT_URI` (`https://api.oyechats.com/auth/google/callback`)
> and `OAUTH_SUCCESS_REDIRECT_URL` (`https://app.oyechats.com/auth/callback`) are
> non-secret and hardcoded in `deploy-api.yml`. The redirect URI must also be
> registered as an Authorized redirect URI on the OAuth client in Google Cloud
> Console, or token exchange fails with `redirect_uri_mismatch`. Verify with
> `curl -s https://api.oyechats.com/auth/google/status` → expect `{"enabled":true}`.

---

## CI/CD Flow

```
Push to main
  ├── api/**    → deploy-api.yml    → CI → SSH to DO → uv sync → alembic → install units
  │                                  → restart worker, api (and ws, if installed)
  │                                  → gate on /health/full, else roll back to the previous SHA
  ├── widget/** → deploy-widget.yml → build → verify outputs → upload to R2 → purge mutable files
  └── app/**    → deploy-app.yml    → WAIT for this commit's deploy-api.yml to go green
                                     → fire the Vercel Deploy Hook
```

The `app/` job waits on the API deliberately: the dashboard must never go live
against a backend that does not yet have the endpoints it calls.

---

## Useful Commands

### On the Droplet
```bash
# View API logs
journalctl -u oyechats-api -f

# Restart API
systemctl restart oyechats-api

# Manual deploy — restart the worker FIRST so its heartbeat is fresh before
# the API's /health/full is checked, and restart the WS process if installed.
cd /opt/oyechats/platform && git pull origin main && cd api \
  && uv sync && uv run alembic upgrade head \
  && systemctl restart oyechats-worker \
  && systemctl restart oyechats-api \
  && { systemctl cat oyechats-ws.service >/dev/null 2>&1 && systemctl restart oyechats-ws || echo "oyechats-ws not installed; skipped"; }

# View worker / WebSocket logs
journalctl -u oyechats-worker -f
journalctl -u oyechats-ws -f

# Check Postgres
sudo -u postgres psql -d oyechats -c "SELECT count(*) FROM bots;"

# Restore backup
gunzip -c /opt/oyechats/backups/oyechats-YYYYMMDD.sql.gz | sudo -u postgres psql oyechats
```

### Local Development
```bash
# Widget: test embed locally (build + preview)
cd widget && npm run build && npx vite preview --port 4173

# Set local API URL for widget dev
VITE_API_URL=http://localhost:8000 npm run build
```

---

## Migrating services to non-root (F06)

The `oyechats-api` / `oyechats-worker` units in `api/systemd/` run as a
dedicated unprivileged `oyechats` system user (`ProtectSystem=strict`,
`ProtectHome=true`, venv binaries executed directly instead of
`/root/.local/bin/uv run`). Deploys are unchanged — GitHub Actions still
SSHes as root and runs `git reset` / `uv sync` / `alembic` / unit install as
root; only the long-running services drop privileges.

### Prerequisites

- The F06 unit files (`User=oyechats`) and `api/scripts/migrate-to-nonroot.sh`
  are present on the droplet checkout (see fetch step below).
- **Ordering (mitigated, but still do the staged run first):** the deploy
  workflow calls `migrate-to-nonroot.sh --prepare-only` before installing
  units, so even a merge that lands before the staged migration creates the
  service user + file grants inline and cannot strand the services on a
  missing user — and the rollback path now restores the *previous* release's
  unit files alongside the code. The staged manual run below is still the
  recommended first step because it additionally preflight-probes WeasyPrint,
  venv imports, and R2 access **as the service user** before any restart.

### Exact commands

```bash
ssh -i ~/.ssh/oyechats_deploy -o IdentitiesOnly=yes root@159.223.45.213

cd /opt/oyechats/platform
# Pull just the F06 files onto the droplet (main doesn't have them yet).
# The next deploy's `git reset --hard origin/main` cleans these up.
git fetch origin development
git checkout origin/development -- \
  api/systemd/oyechats-api.service \
  api/systemd/oyechats-worker.service \
  api/scripts/migrate-to-nonroot.sh

bash api/scripts/migrate-to-nonroot.sh
```

The script is idempotent (safe to re-run). It creates the user, fixes
permissions (`.env` → `root:oyechats 0640`; `documents/` + `archive/` →
`oyechats`-owned; `.venv` readability; `/var/cache/oyechats` service home),
preflight-probes **as the service user** (`.env` read, venv imports,
WeasyPrint render, R2 upload+delete), installs the units, restarts
worker-then-API, gates on `/health/full`, and confirms both MainPIDs run as
`oyechats`.

After a green run, **merge the F06 PR to `main` promptly** — until then, the
next deploy reinstalls the old root units from `main` (harmless, but it
reverts the privilege drop until the merge lands).

### Verification checklist

- [ ] Script exits 0 and prints `MIGRATION COMPLETE`
- [ ] `systemctl show -p User --value oyechats-api` → `oyechats` (same for worker)
- [ ] `curl -sf http://127.0.0.1:8000/health/full` → 200
- [ ] `ls -l /opt/oyechats/platform/api/.env` → `-rw-r----- root oyechats`
- [ ] Upload a document in the dashboard → ingestion completes and the file
      lands in `archive/` (proves `documents/`+`archive/` write access)
- [ ] Trigger/await an invoice PDF render → `pdf_url` populated (WeasyPrint +
      R2 as the service user, in the real worker process)
- [ ] Super-admin console → Logs page loads entries (journalctl via
      `SupplementaryGroups=systemd-journal`)
- [ ] Widget chat round trip (LLM + Redis + DB under the sandboxed unit)
- [ ] Next `main` deploy goes green end-to-end (`.env` rewrite + `uv sync`
      re-assertions in `deploy-api.yml` keep the non-root services readable)

### Rollback

```bash
# Flip the installed units back to root (rest of the hardening stays active):
sed -i -e 's/^User=oyechats/User=root/' -e 's/^Group=oyechats/Group=root/' \
  /etc/systemd/system/oyechats-api.service \
  /etc/systemd/system/oyechats-worker.service
systemctl daemon-reload
systemctl restart oyechats-worker && systemctl restart oyechats-api
curl -sf http://127.0.0.1:8000/health/full && echo OK
```

The permission changes (group-read `.env`, `documents/`/`archive/` ownership)
are harmless under root and need no undo. For a byte-exact revert, restore the
pre-F06 `api/systemd/*.service` from `main`'s history and reinstall them.
