# OyeChat — Deployment Guide

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

- **`oyechats/platform`** (monorepo) — Backend, Widget, Admin
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

### 1.2 Initial Setup
```bash
ssh root@<droplet-ip>

# Create deploy user
adduser oyechats
usermod -aG sudo oyechats

# Switch to deploy user
su - oyechats

# Install system dependencies
sudo apt update && sudo apt install -y \
  postgresql-16 postgresql-16-pgvector \
  python3.11 python3.11-venv \
  nginx certbot python3-certbot-nginx \
  git curl build-essential libpq-dev

# Install uv (Python package manager)
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc
```

### 1.3 Setup PostgreSQL
```bash
sudo -u postgres createuser oyechats
sudo -u postgres createdb oyechats -O oyechats
sudo -u postgres psql -c "ALTER USER oyechats PASSWORD '<STRONG_PASSWORD>';"
sudo -u postgres psql -d oyechats -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 1.4 Deploy Backend
```bash
sudo mkdir -p /opt/oyechats && sudo chown oyechats:oyechats /opt/oyechats
cd /opt/oyechats
git clone https://github.com/oyechats/platform.git
cd platform/backend

# Configure environment
cp .env.example .env
nano .env
```

**Required .env values:**
```
DB_URL=postgresql://oyechats:<STRONG_PASSWORD>@localhost:5432/oyechats
GOOGLE_API_KEY=<your-gemini-key>
APP_ENV=production
CORS_ORIGINS=https://oyechats.com,https://admin.oyechats.com
```

```bash
# Install dependencies and run migrations
uv sync
uv run alembic upgrade head

# Install Playwright for web crawling
uv run playwright install chromium --with-deps
```

### 1.5 Create Systemd Service
```bash
sudo nano /etc/systemd/system/oyechats-api.service
```

```ini
[Unit]
Description=OyeChat API
After=network.target postgresql.service

[Service]
User=oyechats
WorkingDirectory=/opt/oyechats/platform/backend
Environment=PATH=/home/oyechats/.local/bin:/usr/bin
ExecStart=/home/oyechats/.local/bin/uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 2
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable oyechats-api
sudo systemctl start oyechats-api

# Verify it's running
sudo systemctl status oyechats-api
curl http://localhost:8000/docs  # Should return Swagger HTML
```

### 1.6 Nginx Reverse Proxy
```bash
sudo nano /etc/nginx/sites-available/oyechats-api
```

```nginx
server {
    server_name api.oyechats.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    client_max_body_size 50M;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/oyechats-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL (after DNS is pointed)
sudo certbot --nginx -d api.oyechats.com
```

### 1.7 Database Backups
```bash
mkdir -p /opt/oyechats/backups
nano /opt/oyechats/backup.sh
```

```bash
#!/bin/bash
pg_dump -U oyechats oyechats | gzip > /opt/oyechats/backups/oyechats-$(date +%Y%m%d).sql.gz
find /opt/oyechats/backups -mtime +7 -delete
```

```bash
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
1. Go to **vercel.com** → Import `oyechats/platform` repo
2. Configure:
   - **Root Directory**: `admin`
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

### Platform Repo (`oyechats/platform`)
| Secret | Value |
|--------|-------|
| `DO_HOST` | Droplet IP address |
| `DO_USER` | `oyechats` |
| `DO_SSH_KEY` | Private SSH key (for droplet access) |
| `CF_API_TOKEN` | Cloudflare API token (R2 write access) |
| `CF_ACCOUNT_ID` | Cloudflare account ID |

---

## CI/CD Flow

```
Push to main
  ├── backend/** changed → SSH deploy to DO → restart service
  ├── widget/** changed → Build → Upload to R2 CDN
  └── admin/** changed → Vercel auto-deploys
```

---

## Useful Commands

### On the Droplet
```bash
# View API logs
sudo journalctl -u oyechats-api -f

# Restart API
sudo systemctl restart oyechats-api

# Manual deploy
cd /opt/oyechats/platform && git pull && cd backend && uv sync && uv run alembic upgrade head && sudo systemctl restart oyechats-api

# Check Postgres
sudo -u postgres psql -d oyechats -c "SELECT count(*) FROM bots;"

# Restore backup
gunzip -c /opt/oyechats/backups/oyechats-YYYYMMDD.sql.gz | psql -U oyechats oyechats
```

### Local Development
```bash
# Widget: test embed locally (build + preview)
cd widget && npm run build && npx vite preview --port 4173

# Set local API URL for widget dev
VITE_API_URL=http://localhost:8000 npm run build
```
