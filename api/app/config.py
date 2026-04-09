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
# LLM — models are hardcoded, only API keys come from .env
# ─────────────────────────────────────────────────────────────────────────────
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

# Primary and fallback models (LiteLLM format: provider/model-name)
LLM_MODEL = "gemini/gemini-2.5-flash"
FALLBACK_MODEL = "openai/gpt-5.4-mini"

# LiteLLM fallback chain: primary → fallback (only if Google key is set)
LLM_FALLBACKS: list[dict[str, list[str]]] | None = [{LLM_MODEL: [FALLBACK_MODEL]}] if GOOGLE_API_KEY else None

if not OPENAI_API_KEY:
    logger.error("OPENAI_API_KEY is not set! LLM calls will fail.")
else:
    logger.info(f"LLM primary: {LLM_MODEL} (key ...{OPENAI_API_KEY[-4:]})")

if GOOGLE_API_KEY:
    logger.info(f"LLM fallback: {LLM_MODEL} → {FALLBACK_MODEL}")
else:
    logger.warning("GOOGLE_API_KEY not set — no LLM fallback available.")

# ─────────────────────────────────────────────────────────────────────────────
# Embeddings & RAG
# ─────────────────────────────────────────────────────────────────────────────
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIMENSIONS = 1536
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "2000"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "300"))

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
# Directories & Crawler
# ─────────────────────────────────────────────────────────────────────────────
DOCUMENTS_DIR = "documents"
ARCHIVE_DIR = "archive"
# Crawler defaults (read by crawler_script.py subprocess via os.getenv):
# MAX_CRAWL_PAGES=50, CRAWL_CONCURRENCY=3, CRAWL_PAGE_TIMEOUT=20,
# MAX_CRAWL_DEPTH=3, CRAWL_SUBPROCESS_TIMEOUT=600
