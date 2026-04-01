# OyeChats — Deployment Guide

## Infrastructure Overview

| Service | Domain | Hosted On | Cost |
|---------|--------|-----------|------|
| Landing Page | `oyechats.com` | Vercel | Free |
| Admin Dashboard | `admin.oyechats.com` | Vercel (monorepo) | Free |
| Backend API | `api.oyechats.com` | DigitalOcean Droplet | $12/mo |
| Widget CDN | `cdn.oyechats.com` | Cloudflare R2 | ~$0 |
| Database | (on droplet) | PostgreSQL 16 + pgvector | $0 (included) |
| **Total** | | | **~$12/mo** |

## GitHub Repos

- **`digibranders/oye-chats-platform`** (monorepo) — Backend, Widget, Admin
- **`oyechats/landing`** (separate) — Next.js landing page

## DNS Records

Set these at your domain registrar:

```
oyechats.com          CNAME   cname.vercel-dns.com
admin.oyechats.com    CNAME   cname.vercel-dns.com
api.oyechats.com      A       <droplet-ip>
cdn.oyechats.com      CNAME   <r2-public-domain>
```

---

## Step 1: DigitalOcean Droplet (Backend + DB)

### 1.1 Provision
- **Image**: Ubuntu 24.04 LTS
- **Size**: 2GB RAM / 1 vCPU ($12/mo)
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
CORS_ORIGINS=https://oyechats.com,https://admin.oyechats.com,https://www.oyechats.com
```

**Optional .env values:**
```
LLM_MODEL=openai/gpt-5-mini
R2_KEY_ID=<backblaze-key-id>
R2_APPLICATION_KEY=<backblaze-app-key>
R2_BUCKET_NAME=<bucket-name>
R2_ENDPOINT=<s3-endpoint>
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

# Install Playwright for web crawling
uv run playwright install --with-deps chromium
```

### 1.5 Create Systemd Service
```bash
cat > /etc/systemd/system/oyechats-api.service <<'EOF'
[Unit]
Description=OyeChats API
After=network.target postgresql.service

[Service]
User=root
WorkingDirectory=/opt/oyechats/platform/api
Environment=PATH=/root/.local/bin:/usr/bin:/usr/local/bin
ExecStart=/root/.local/bin/uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 2
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

```bash
systemctl daemon-reload
systemctl enable oyechats-api
systemctl start oyechats-api

# Verify it's running
systemctl status oyechats-api
curl http://localhost:8000/docs  # Should return Swagger HTML
```

### 1.6 Nginx Reverse Proxy
```bash
cat > /etc/nginx/sites-available/oyechats-api <<'NGINX'
server {
    server_name api.oyechats.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (required for /ws/chat/ and /ws/agent)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    client_max_body_size 50M;
}
NGINX
```

```bash
ln -s /etc/nginx/sites-available/oyechats-api /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# SSL (after DNS is pointed)
certbot --nginx -d api.oyechats.com
```

### 1.7 Firewall
```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

### 1.8 Database Backups
```bash
mkdir -p /opt/oyechats/backups

cat > /opt/oyechats/backup.sh <<'BASH'
#!/bin/bash
sudo -u postgres pg_dump oyechats | gzip > /opt/oyechats/backups/oyechats-$(date +%Y%m%d).sql.gz
find /opt/oyechats/backups -mtime +7 -delete
BASH

chmod +x /opt/oyechats/backup.sh
crontab -e
# Add: 0 3 * * * /opt/oyechats/backup.sh
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
```bash
cd widget
VITE_API_URL=https://api.oyechats.com npm run build
# Upload dist/oyechats-widget.js and dist/oyechats-widget.css via Cloudflare dashboard
# Or use wrangler CLI:
npx wrangler r2 object put oyechats-cdn/oyechats-widget.js --file dist/oyechats-widget.js
npx wrangler r2 object put oyechats-cdn/oyechats-widget.css --file dist/oyechats-widget.css
```

After this, GitHub Actions handles subsequent deploys automatically.

---

## Step 3: Vercel (Admin + Landing Page)

### Admin Dashboard
1. Go to **vercel.com** → Import `digibranders/oye-chats-platform` repo
2. Configure:
   - **Root Directory**: `app`
   - **Framework Preset**: Vite
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
3. Add environment variable: `VITE_API_URL` = `https://api.oyechats.com`
4. Add custom domain: `admin.oyechats.com`

### Landing Page
1. Import `oyechats/landing` repo in Vercel
2. Framework auto-detected as Next.js
3. Add custom domain: `oyechats.com`

Both auto-deploy on every push to `main`.

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
| `CORS_ORIGINS` | `https://oyechats.com,https://admin.oyechats.com,https://www.oyechats.com` |
| `R2_KEY_ID` | Backblaze B2 key ID |
| `R2_APPLICATION_KEY` | Backblaze B2 application key |
| `R2_BUCKET_NAME` | Backblaze B2 bucket name |
| `R2_ENDPOINT` | Backblaze B2 S3 endpoint |
| `SENTRY_DSN_BACKEND` | Sentry DSN for backend |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key |
| `CF_API_TOKEN` | Cloudflare API token (R2 write access, for widget deploy) |
| `CF_ACCOUNT_ID` | Cloudflare account ID (for widget deploy) |

---

## CI/CD Flow

```
Push to main
  ├── api/** changed → SSH deploy to DO → restart service
  ├── widget/** changed → Build → Upload to R2 CDN
  └── app/** changed → Vercel auto-deploys
```

---

## Useful Commands

### On the Droplet
```bash
# View API logs
journalctl -u oyechats-api -f

# Restart API
systemctl restart oyechats-api

# Manual deploy
cd /opt/oyechats/platform && git pull origin main && cd api && uv sync && uv run alembic upgrade head && systemctl restart oyechats-api

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
