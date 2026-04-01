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
| `LLM_MODEL` | No | `openai/gpt-5-mini` | LiteLLM model identifier. Supports any LiteLLM-compatible model string |
| `EMBEDDING_MODEL` | No | `text-embedding-3-small` | OpenAI embedding model name |

### Document Ingestion

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CHUNK_SIZE` | No | `2000` | Maximum characters per document chunk |
| `CHUNK_OVERLAP` | No | `300` | Character overlap between adjacent chunks |

### Cloud Storage (Backblaze B2)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `R2_KEY_ID` | No | — | Backblaze B2 application key ID |
| `R2_APPLICATION_KEY` | No | — | Backblaze B2 application key |
| `R2_BUCKET_NAME` | No | — | B2 bucket name for document storage |
| `R2_ENDPOINT` | No | — | B2 S3-compatible endpoint URL |

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

The minimum environment to run OyeChat locally:

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
