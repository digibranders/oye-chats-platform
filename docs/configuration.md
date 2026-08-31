# Configuration Reference

All configuration is managed through environment variables. Each application has its own `.env` file (copy from `.env.example`).

> **This page covers the variables you need to *start* the platform.** It is not exhaustive — `api/app/config.py` declares many more (RAG gates, crawl tuning, embedding throughput, WebSocket backplane, demo-page capture) and is the single source of truth for defaults. Where the two disagree, `config.py` wins.

## Backend API (`api/.env`)

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_URL` | Yes | — | PostgreSQL connection string (e.g., `postgresql://user:pass@localhost:5432/oyechats`) |
| `APP_ENV` | No | `development` | `development` or `production`. Controls CORS, debug mode, etc. |
| `CORS_ORIGINS` | Prod only | — | Comma-separated allowed origins (e.g., `https://app.oyechats.com,https://oyechats.com`) |

### LLM & Embeddings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for the **primary LLM**. Not used for embeddings |
| `GOOGLE_API_KEY` | Yes | — | Powers **embeddings**, the Gemini LLM fallback, and both gate models. Without it embedding fails outright — there is no fallback embedder |
| `LLM_MODEL` | No | `openai/gpt-5.4-mini` | LiteLLM model identifier. Supports any LiteLLM-compatible model string |
| `GEMINI_EMBED_MODEL` | No | `gemini-embedding-001` | Embedding model (Google, via `batchEmbedContents`) |
| `EMBED_DIMENSIONS` | No | `768` | Must match the `Vector(768)` column. Changing it means re-embedding the whole corpus |
| `EMBED_CONCURRENCY` | No | `8` | Concurrent embed batches (100 texts each) |
| `EMBED_RPM_LIMIT` | No | `2850` | Self-imposed request ceiling; quota is counted per text, not per call |

### RAG behaviour flags

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CAG_LITE_THRESHOLD` | No | `20` | Bots at or under this many chunks skip retrieval entirely and inject every chunk. `0` disables |
| `RELEVANCE_GATE_ENABLED` | No | `true` | CRAG relevance gate — **blocking**. This is the control behind "answers only from your knowledge base". An **empty** value is treated as unset and falls back to `true` |
| `RERANK_ENABLED` | No | `false` | FlashRank cross-encoder rerank |
| `GROUNDEDNESS_CHECK_ENABLED` | No | `true` | Post-answer groundedness audit. **Observability only** — never blocks or rewrites a delivered answer |

### Document Ingestion

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CHUNK_SIZE` | No | `1000` | Maximum characters per document chunk |
| `CHUNK_OVERLAP` | No | `200` | Character overlap between adjacent chunks |

### Cloud Storage (Cloudflare R2)

S3-compatible object storage for documents, logos, and chat file uploads. Legacy `B2_*` env-var names are still accepted as fallbacks (see `api/app/config.py`).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `R2_KEY_ID` | No | — | Cloudflare R2 access key ID |
| `R2_APPLICATION_KEY` | No | — | Cloudflare R2 secret access key |
| `R2_BUCKET_NAME` | No | — | R2 bucket name for document and file storage |
| `R2_ENDPOINT` | No | — | R2 S3-compatible endpoint URL |

### Observability

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SENTRY_DSN` | No | — | Sentry DSN for error tracking. Omit to disable. |
| `LANGFUSE_SECRET_KEY` | No | — | Langfuse secret key for LLM tracing. Omit to disable. |
| `LANGFUSE_PUBLIC_KEY` | No | — | Langfuse public key |
| `LANGFUSE_HOST` | No | `https://cloud.langfuse.com` | Langfuse server URL |

### Email (Brevo)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BREVO_API_KEY` | No | — | Brevo (Sendinblue) API key for transactional emails |

### Billing add-on plans (Razorpay)

Extra operator seats and branding removal are billed on their own Razorpay subscriptions, separate
from the tier plan, so the tier plan's amount never moves. Each rail needs its own plan id, because
a Razorpay plan's currency is fixed at creation.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RAZORPAY_SEAT_PLAN_ID` | No | — | INR plan id for the extra-operator-seat add-on. Unset disables seat add-ons on the INR rail. |
| `RAZORPAY_SEAT_PLAN_ID_USD` | No | — | USD plan id for the same add-on. Unset disables seat add-ons on the USD rail. |
| `RAZORPAY_SEAT_PLAN_PRICE_CENTS` | No | `44900` | Seat BASE price in paise (₹449/seat/month). The single source of truth for what every surface displays. |
| `EXTRA_SEAT_PRICE_USD_CENTS` | No | `500` | Seat price in US cents ($5/seat/month) for the international rail. |
| `RAZORPAY_BRANDING_PLAN_ID` | No | — | INR plan id for the branding-removal add-on (hides "Powered by OyeChats"). Unset disables the add-on on the INR rail. |
| `RAZORPAY_BRANDING_PLAN_ID_USD` | No | — | USD plan id for the same add-on. Unset disables it on the USD rail. |
| `RAZORPAY_BRANDING_PLAN_PRICE_CENTS` | No | `49900` | Branding add-on BASE price in paise (₹499/month). |
| `BRANDING_ADDON_PRICE_USD_CENTS` | No | `500` | Branding add-on price in US cents ($5/month). |

All four price variables are **BASE prices, exclusive of GST**. They are what the dashboard shows.

> **OPS INVARIANT.** The Razorpay plan behind each **INR** id must be minted at **base + GST**, i.e.
> `tax.gross_charge_minor(<price env var>, rate_bps, "intra")`. At 18% that is ₹529.82 for the seat
> plan and ₹588.82 for the branding plan. The **USD** plan is an export, carries no Indian GST, and
> is minted at the base ($5.00 for both).
>
> Razorpay plans are immutable, so the price variable and the plan id always move as a pair. To
> change a price, or the GST rate, mint a new plan at the new charge and repoint both together.
> Verify with `GET /subscriptions/admin/plan-price-check`, which compares each live Razorpay amount
> against the expected gross for both tier plans and these two add-ons.

There are no baked-in defaults for the plan ids. Set the test-mode ids in local and staging `.env`
files and the live ids in production, so no plan id is ever committed to the repo.

### Web Crawler

Crawling is HTTP-only through two hosted providers — nothing drives a local browser, so there is no page-timeout or depth setting of the kind a headless crawler would need.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CRAWL_PROVIDER_PRIMARY` | No | `jina` | Which backend page fetches try first (`jina` or `spider`); the other becomes the fallback. Super-admin overrides it at runtime via `pricing_config` `crawl.provider_primary` |
| `JINA_API_KEY` | No | — | Optional. Reader works keyless at ~20 RPM; a key raises that to ~500 RPM |
| `JINA_FALLBACK_ENABLED` | No | `true` | Allow falling back to Reader |
| `JINA_FETCH_CONCURRENCY` | No | `5` | Concurrent Reader fetches |
| `SPIDER_API_KEY` | No | — | Unset disables Spider entirely (it then cannot serve as primary *or* fallback) |
| `CRAWL_STREAM_INGEST_ENABLED` | No | `true` | Ingest pages in waves as they arrive rather than after the whole crawl |
| `CRAWL_INGEST_WAVE_PAGES` | No | `25` | Pages per ingest wave |
| `CRAWL_SUBPROCESS_TIMEOUT` | No | `1600` | Wall-clock ceiling for a single crawl job, in seconds |

> **The binding cap on a crawl is characters, not pages** — it comes from the workspace's plan knowledge quota, not from an env var.

## Chat Widget (`widget/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | Yes | `https://api.oyechats.com` | Backend API base URL |
| `VITE_SENTRY_DSN` | No | — | Sentry DSN for widget error tracking |

## Admin Dashboard (`app/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | Yes | — | Backend API base URL |
| `VITE_SENTRY_DSN` | No | — | Sentry DSN for admin error tracking |

## Minimal Local Setup

The minimum environment to run OyeChats locally:

**`api/.env`:**
```
DB_URL=postgresql://postgres:postgres@localhost:5432/oyechats
OPENAI_API_KEY=sk-your-key-here
GOOGLE_API_KEY=your-google-ai-studio-key
APP_ENV=development
```

`GOOGLE_API_KEY` is not optional even for a bare local run: without it nothing can be embedded, so every document ingests to zero chunks and every question retrieves nothing.

**`widget/.env`:**
```
VITE_API_URL=http://localhost:8000
```

**`app/.env`:**
```
VITE_API_URL=http://localhost:8000
```

Everything else is optional. Sentry, Langfuse, Brevo, R2 and the crawl providers gracefully degrade when their keys are absent.

## Production Checklist

Before deploying to production, ensure:

1. `APP_ENV=production` is set on the backend
2. `CORS_ORIGINS` includes all allowed frontend domains
3. `DB_URL` points to the production PostgreSQL instance with pgvector enabled
4. `OPENAI_API_KEY` **and** `GOOGLE_API_KEY` are set with production-grade keys
5. `SENTRY_DSN` is configured for error monitoring
6. `LANGFUSE_*` keys are set for LLM observability
7. `R2_*` keys are configured for document storage
8. `BREVO_API_KEY` is set for transactional emails
9. Widget is built and deployed to CDN (`cdn.oyechats.com`)
10. Admin dashboard is built and deployed
11. `RELEVANCE_GATE_ENABLED` resolves to `true` on the box. Check the **value**, not just the key:
    an empty-but-present `RELEVANCE_GATE_ENABLED=` line in `api/.env` is what systemd's
    `EnvironmentFile=` turns into `""`, and that silently disabled scope enforcement in
    production once already. The deploy now emits `${VAR:-true}` and the module treats empty
    as unset — verify both still hold after any change to `deploy-api.yml`
