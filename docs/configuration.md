# Configuration Reference

All configuration is managed through environment variables. Each application has its own `.env` file (copy from `.env.example`).

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
| `OPENAI_API_KEY` | Yes | — | OpenAI API key (used for embeddings and optionally for LLM) |
| `LLM_MODEL` | No | `openai/gpt-5.4-mini` | LiteLLM model identifier. Supports any LiteLLM-compatible model string |
| `EMBEDDING_MODEL` | No | `text-embedding-3-small` | OpenAI embedding model name |

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

These are hardcoded defaults in `crawler_service.py` (not currently env-configurable):

| Setting | Value |
|---------|-------|
| Max pages per crawl | 50 |
| Max depth | 3 |
| Concurrent requests | 5 |
| Page timeout | 20 seconds |

## Chat Widget (`widget/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_URL` | Yes | `https://api.oyechats.com` | Backend API base URL |
| `VITE_SENTRY_DSN` | No | — | Sentry DSN for widget error tracking |

## Admin Dashboard (`admin/.env`)

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
APP_ENV=development
```

**`widget/.env`:**
```
VITE_API_URL=http://localhost:8000
```

**`admin/.env`:**
```
VITE_API_URL=http://localhost:8000
```

Everything else is optional. Sentry, Langfuse, Brevo, and B2 features gracefully degrade when their keys are absent.

## Production Checklist

Before deploying to production, ensure:

1. `APP_ENV=production` is set on the backend
2. `CORS_ORIGINS` includes all allowed frontend domains
3. `DB_URL` points to the production PostgreSQL instance with pgvector enabled
4. `OPENAI_API_KEY` is set with a production-grade key
5. `SENTRY_DSN` is configured for error monitoring
6. `LANGFUSE_*` keys are set for LLM observability
7. `R2_*` keys are configured for document storage
8. `BREVO_API_KEY` is set for transactional emails
9. Widget is built and deployed to CDN (`cdn.oyechats.com`)
10. Admin dashboard is built and deployed
