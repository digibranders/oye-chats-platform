# CI / CD pipelines

> **Audience:** Ops · New engineers · **Read time:** 5 min · **Last updated:** 2026-04-28

## TL;DR

Three GitHub Actions workflows. **`ci.yml`** runs on every push to `development` and PRs to `main` (lint + tests + builds). **`deploy-api.yml`** runs on `main` API changes (SSH deploy + Alembic + systemd restart + health gate). **`deploy-widget.yml`** runs on `main` widget changes (Vite build → Cloudflare R2 upload in strict order → cache purge → smoke test).

## Workflow overview

```mermaid
---
config:
  flowchart:
    nodeSpacing: 45
    rankSpacing: 70
---
flowchart LR
    classDef event fill:#fff7ed,stroke:#c2410c,color:#7c2d12
    classDef job fill:#e0e7ff,stroke:#4f46e5,color:#312e81
    classDef target fill:#dcfce7,stroke:#15803d,color:#14532d,stroke-width:2px

    subgraph Events["Triggers"]
      direction TB
      PR["PR to main"]:::event
      DevPush["push to development"]:::event
      MainAPI["push to main<br/>api/** changed"]:::event
      MainWidget["push to main<br/>widget/** changed"]:::event
    end

    subgraph CI["ci.yml · gating"]
      direction TB
      ci_back["Backend<br/>ruff · pytest<br/>+ pgvector service"]:::job
      ci_widget["Widget<br/>lint · build · bundle-size"]:::job
      ci_admin["Admin<br/>lint · build"]:::job
    end

    subgraph DeployAPI["deploy-api.yml"]
      direction TB
      api_ssh["SSH to droplet"]:::job
      api_reset["git reset --hard origin/main"]:::job
      api_env["regenerate .env from 19 secrets"]:::job
      api_uv["uv sync deps"]:::job
      api_alembic["alembic upgrade head"]:::job
      api_systemd["restart worker, then api"]:::job
      api_nginx["reload nginx (if changed)"]:::job
      api_health["health gate /health/full<br/>6 × 7.5s"]:::job
      api_ssh --> api_reset --> api_env --> api_uv --> api_alembic --> api_systemd --> api_nginx --> api_health
    end

    subgraph DeployWidget["deploy-widget.yml"]
      direction TB
      w_build["npm ci · build"]:::job
      w_chunks["upload hashed chunks<br/>immutable 1y"]:::job
      w_manifest["upload manifest.json<br/>short cache"]:::job
      w_loader["upload oyechats-widget.js<br/>short cache"]:::job
      w_purge["CF cache purge<br/>loader + manifest"]:::job
      w_versioned["backup versions/{sha}.js"]:::job
      w_smoke["live SHA verify"]:::job
      w_build --> w_chunks --> w_manifest --> w_loader --> w_purge --> w_versioned --> w_smoke
    end

    Droplet[("DO droplet<br/>oyechats-api")]:::target
    R2[("Cloudflare R2<br/>cdn.oyechats.com")]:::target

    PR --> CI
    DevPush --> CI
    MainAPI --> DeployAPI --> Droplet
    MainWidget --> DeployWidget --> R2
```

## `ci.yml` (gating)

Path: [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)

Triggers: `push` to `development` · `pull_request` to `main`.

Jobs:

| Job | Steps |
|---|---|
| **Backend** | Spin up `pgvector/pgvector:pg16` service · `uv sync` · `uv run ruff check .` · `uv run pytest` (with `APP_ENV=testing`, `DB_URL=postgresql://test:test@localhost:5432/test`, `GOOGLE_API_KEY=test-key`) |
| **Widget** | `npm ci` · `npm run lint` · `npm run build` (with `VITE_API_URL=https://api.oyechats.com`) · bundle-size assertion · upload `dist/` artifact |
| **Admin** | `npm ci` · `npm run lint` · `npm run build` (with `VITE_API_URL=https://api.oyechats.com`) |

Gate: PR can't merge unless all three pass (branch protection on `main`).

## `deploy-api.yml` (production rollout)

Path: [`.github/workflows/deploy-api.yml`](../../../.github/workflows/deploy-api.yml)

Triggers: `push` to `main` (paths: `api/**`) · manual `workflow_dispatch`.

Step-by-step on the droplet (over SSH):

```mermaid
sequenceDiagram
    autonumber
    box rgb(254,243,199) CI
      participant GH as GitHub Actions
    end
    box rgb(224,242,254) Droplet shell
      participant Droplet as ssh session
    end
    box rgb(220,252,231) Data + services
      participant DB as Postgres
      participant SystemdWorker as oyechats-worker
      participant SystemdAPI as oyechats-api
      participant Nginx
    end

    GH->>Droplet: ssh appleboy/ssh-action
    Droplet->>Droplet: cd /opt/oyechats/platform
    Droplet->>Droplet: git fetch + git reset --hard origin/main
    Note right of Droplet: hard reset clears any local hotfixes;<br/>.env is gitignored so it survives
    Droplet->>Droplet: regenerate api/.env from 19 GitHub secrets
    Droplet->>Droplet: cd api && uv sync
    Droplet->>Droplet: install Playwright Chromium if missing
    Droplet->>DB: alembic upgrade head
    Droplet->>Droplet: cp systemd/*.service /etc/systemd/system/
    Droplet->>Droplet: systemctl daemon-reload
    Droplet->>SystemdWorker: systemctl restart oyechats-worker
    Note right of SystemdWorker: worker first so /health/full sees its heartbeat
    Droplet->>SystemdAPI: systemctl restart oyechats-api
    Droplet->>Nginx: nginx -t && systemctl reload nginx (if config diff)

    loop 6 attempts × 7.5s
        Droplet->>SystemdAPI: GET http://localhost:8000/health/full
        alt 200
            Note over Droplet: pass
        else not yet
            Note over Droplet: retry
        end
    end
    alt all 6 fail
        Droplet->>GH: log journalctl -u oyechats-api -u oyechats-worker
        Droplet->>GH: exit 1 (workflow fails red)
    else passed
        Droplet->>GH: success
    end
```

19 secrets fed in: `DB_URL`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `CORS_ORIGINS`, `R2_*` (Cloudflare R2; legacy `B2_*` env names also accepted as fallback — see [`config.py`](../../../api/app/config.py)), `SENTRY_DSN_BACKEND`, `LANGFUSE_*`, `BREVO_API_KEY`, `REDIS_URL`, `RELEVANCE_GATE_ENABLED`, `CHUNK_ENRICHMENT_ENABLED`, `CRAWLER_JS_ALL_PAGES`, `RERANK_ENABLED`, plus SSH (`DO_HOST`, `DO_USER`, `DO_SSH_KEY`).

Hardcoded prod values inside the deploy script: `LLM_MODEL=openai/gpt-5.4-mini`, `FALLBACK_MODEL=gemini/gemini-2.5-flash`, `GATE_MODEL=gemini/gemini-2.5-flash`, `ENRICHMENT_MODEL=gemini/gemini-2.5-flash`, `CHUNK_SIZE=1000`, `CHUNK_OVERLAP=200`, `RELEVANCE_THRESHOLD=0.55`, `RERANK_TOP_N=5`, `CAG_LITE_THRESHOLD=20`, `CRAWLER_BROWSER_RECYCLE=10`, `WORKER_ENABLED=true`, `MODERATION_ENABLED=true`.

## `deploy-widget.yml` (CDN publish)

Path: [`.github/workflows/deploy-widget.yml`](../../../.github/workflows/deploy-widget.yml)

Triggers: `push` to `main` (paths: `widget/**`) · manual.

Build environment: `VITE_API_URL=https://api.oyechats.com`, `VITE_WIDGET_BASE=https://cdn.oyechats.com`.

**Strict upload order** (this is correctness, not optimisation):

1. **Hashed chunks** (`dist/app/oyechats-*.js`, `*.css`) — `Cache-Control: public, max-age=31536000, immutable`. Safe to upload first because they're hash-named.
2. **`manifest.json`** — `Cache-Control: no-cache, must-revalidate, s-maxage=300`. Lists the chunk hashes the loader will load.
3. **`oyechats-widget.js`** (loader) — same cache headers as manifest. Loader code references manifest at runtime.
4. **Cloudflare cache purge** — only loader + manifest URLs (hashed chunks are immutable).
5. **Versioned backup** — `r2_bucket/versions/oyechats-widget-{github_sha}.js` (immutable; rollback safety).
6. **Smoke test** — fetch the live loader and the live manifest; assert SHA embedded matches the new commit and the entry chunk exists.

If any step fails, the workflow fails red — but the prior steps' uploads stay (hashed chunks won't conflict; loader/manifest will get re-uploaded next run).

## How to roll back

API:

```bash
ssh -i ~/.ssh/oyechats_deploy root@159.223.45.213
cd /opt/oyechats/platform
git log --oneline -10
git reset --hard <prev-good-sha>
cd api && uv sync && uv run alembic upgrade head     # if migrations were destructive, downgrade first
systemctl restart oyechats-worker oyechats-api
curl -fsS http://localhost:8000/health/full
```

Widget: re-run `deploy-widget.yml` from the previous good commit, **or** rename the latest `versions/oyechats-widget-{prev_sha}.js` over `oyechats-widget.js` and purge.

## Why this matters

Deploys are the moment systems break. The health gate, the worker-first restart order, and the strict widget upload order are all deliberate guard-rails. When a deploy fails, this page is what the on-call engineer reads first.
