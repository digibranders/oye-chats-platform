import logging
import os

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────────────────────────────────────
DB_URL = os.getenv("DB_URL")
if not DB_URL:
    logger.error("DB_URL is not set! Database connections will fail.")

# ─────────────────────────────────────────────────────────────────────────────
# LLM — primary and fallback models are env-configurable (LiteLLM format)
# ─────────────────────────────────────────────────────────────────────────────
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

# Primary and fallback models — override via env vars if needed
LLM_MODEL = os.getenv("LLM_MODEL", "openai/gpt-5.4-mini")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "gemini/gemini-2.5-flash")


def _model_key_is_set(model: str) -> bool:
    """Return True if the required API key for the given LiteLLM model is configured."""
    if model.startswith(("gemini/", "google/")):
        return bool(GOOGLE_API_KEY)
    if model.startswith(("openai/", "gpt-")):
        return bool(OPENAI_API_KEY)
    # Unknown provider — assume available and let LiteLLM surface the error
    return True


PRIMARY_MODEL_KEY_SET = _model_key_is_set(LLM_MODEL)
FALLBACK_MODEL_KEY_SET = _model_key_is_set(FALLBACK_MODEL)

# LiteLLM fallback chain: primary → fallback (only if fallback key is available)
LLM_FALLBACKS: list[dict[str, list[str]]] | None = (
    [{LLM_MODEL: [FALLBACK_MODEL]}] if PRIMARY_MODEL_KEY_SET and FALLBACK_MODEL_KEY_SET else None
)

if not PRIMARY_MODEL_KEY_SET:
    logger.error(f"Primary LLM key is not set for model '{LLM_MODEL}'! Chat responses will fail.")
else:
    logger.info(f"LLM primary: {LLM_MODEL}")

if FALLBACK_MODEL_KEY_SET:
    logger.info(f"LLM fallback: {LLM_MODEL} → {FALLBACK_MODEL}")
else:
    logger.warning(f"Fallback LLM key not set for '{FALLBACK_MODEL}' — no fallback available.")

# ─────────────────────────────────────────────────────────────────────────────
# Embeddings & RAG
# ─────────────────────────────────────────────────────────────────────────────
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIMENSIONS = 1536
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "1000"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "200"))

# ─────────────────────────────────────────────────────────────────────────────
# File Storage (Backblaze B2 via S3-compatible API)
# Env vars use R2_ prefix (deploy scripts), code uses B2_ (Backblaze naming)
# ─────────────────────────────────────────────────────────────────────────────
B2_KEY_ID = os.getenv("R2_KEY_ID") or os.getenv("B2_KEY_ID")
B2_APPLICATION_KEY = os.getenv("R2_APPLICATION_KEY") or os.getenv("B2_APPLICATION_KEY")
B2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME") or os.getenv("B2_BUCKET_NAME")
B2_ENDPOINT = os.getenv("R2_ENDPOINT") or os.getenv("B2_ENDPOINT")

# ─────────────────────────────────────────────────────────────────────────────
# Observability — Langfuse (LLM tracing) + Sentry (error tracking)
# ─────────────────────────────────────────────────────────────────────────────
LANGFUSE_SECRET_KEY = os.getenv("LANGFUSE_SECRET_KEY")
LANGFUSE_PUBLIC_KEY = os.getenv("LANGFUSE_PUBLIC_KEY")
LANGFUSE_HOST = os.getenv("LANGFUSE_HOST", "https://cloud.langfuse.com")
# Set LANGFUSE_FORCE_DISABLE=true to explicitly suppress Langfuse even when keys are present.
# Useful on low-memory servers where the langfuse_otel callback causes APIConnectionError
# during LiteLLM streaming — remove this env var once server RAM is upgraded.
_LANGFUSE_FORCE_DISABLE = os.getenv("LANGFUSE_FORCE_DISABLE", "").lower() in ("1", "true", "yes")
LANGFUSE_ENABLED = bool(LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY) and not _LANGFUSE_FORCE_DISABLE

if _LANGFUSE_FORCE_DISABLE:
    logger.info("Langfuse tracing disabled (LANGFUSE_FORCE_DISABLE=true)")
elif LANGFUSE_ENABLED:
    logger.info(f"Langfuse tracing enabled | host={LANGFUSE_HOST}")
else:
    logger.info("Langfuse tracing disabled (no keys configured)")

SENTRY_DSN = os.getenv("SENTRY_DSN") or os.getenv("SENTRY_DSN_BACKEND")
SENTRY_ENABLED = bool(SENTRY_DSN)
APP_ENV = os.getenv("APP_ENV", "development")

# ─────────────────────────────────────────────────────────────────────────────
# Email Notifications (Brevo / Sendinblue)
# ─────────────────────────────────────────────────────────────────────────────
BREVO_API_KEY = os.getenv("BREVO_API_KEY")
EMAIL_FROM_NAME = os.getenv("EMAIL_FROM_NAME", "OyeChats")
EMAIL_FROM_ADDRESS = os.getenv("EMAIL_FROM_ADDRESS", "notifications@oyechats.com")
EMAIL_ENABLED = bool(BREVO_API_KEY)

if EMAIL_ENABLED:
    logger.info("Email notifications enabled (Brevo)")
else:
    logger.info("Email notifications disabled (no BREVO_API_KEY)")

# ─────────────────────────────────────────────────────────────────────────────
# Redis (required in production — enables distributed rate limiting + caching)
# ─────────────────────────────────────────────────────────────────────────────
REDIS_URL = os.getenv("REDIS_URL")
REDIS_ENABLED = bool(REDIS_URL)

if APP_ENV == "production" and not REDIS_URL:
    raise RuntimeError(
        "REDIS_URL is required in production. "
        "Set it in .env (e.g. REDIS_URL=rediss://...) or use APP_ENV=development for local dev."
    )

if REDIS_ENABLED:
    logger.info("Redis caching enabled (Upstash)")
else:
    logger.info("Redis not configured — caching disabled, rate limiter uses in-memory backend (dev only)")

# ─────────────────────────────────────────────────────────────────────────────
# Billing (Stripe + Razorpay)
# ─────────────────────────────────────────────────────────────────────────────
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY")
STRIPE_PUBLISHABLE_KEY = os.getenv("STRIPE_PUBLISHABLE_KEY")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")
STRIPE_ENABLED = bool(STRIPE_SECRET_KEY)

RAZORPAY_KEY_ID = os.getenv("RAZORPAY_KEY_ID")
RAZORPAY_KEY_SECRET = os.getenv("RAZORPAY_KEY_SECRET")
RAZORPAY_WEBHOOK_SECRET = os.getenv("RAZORPAY_WEBHOOK_SECRET")
RAZORPAY_ENABLED = bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)

# Frontend URL for Stripe checkout redirects
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5174")

if STRIPE_ENABLED:
    logger.info("Stripe billing enabled")
else:
    logger.info("Stripe billing disabled (no STRIPE_SECRET_KEY)")

if RAZORPAY_ENABLED:
    logger.info("Razorpay billing enabled")
else:
    logger.info("Razorpay billing disabled (no RAZORPAY_KEY_ID)")

# ─────────────────────────────────────────────────────────────────────────────
# Directories & Crawler
# ─────────────────────────────────────────────────────────────────────────────
DOCUMENTS_DIR = "documents"
ARCHIVE_DIR = "archive"
# Crawler defaults (read by crawler_script.py subprocess via os.getenv):
# MAX_CRAWL_PAGES=50, CRAWL_CONCURRENCY=3, CRAWL_PAGE_TIMEOUT=20,
# MAX_CRAWL_DEPTH=3, CRAWL_SUBPROCESS_TIMEOUT=600
# CRAWLER_JS_ALL_PAGES=false   — set true to use Playwright for all depths (Next.js/SPAs)
# CRAWLER_BROWSER_RECYCLE=10   — recycle Chromium every N pages (memory leak prevention)
# ─────────────────────────────────────────────────────────────────────────────
# Retrieval & Reranking
# ─────────────────────────────────────────────────────────────────────────────
# RERANK_ENABLED=false  — set true to activate FlashRank cross-encoder reranking
# RERANK_TOP_N=5        — final top-n docs passed to LLM after reranking
# CAG_LITE_THRESHOLD=20 — bots with ≤ this many chunks skip retrieval; all chunks injected directly
# RELEVANCE_GATE_ENABLED=false — set true to activate CRAG-style relevance gate (LLM judge, Gemini Flash)
# GATE_MODEL=gemini/gemini-2.5-flash — model used for relevance scoring (cheapest capable)
# RELEVANCE_THRESHOLD=0.5 — chunks scoring below this cause the gate to fire and block generation
