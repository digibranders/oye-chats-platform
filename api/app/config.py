import logging
import os

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

DB_URL = os.getenv("DB_URL")
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIMENSIONS = 1536
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "2000"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "300"))

# Directory Paths
DOCUMENTS_DIR = "documents"
ARCHIVE_DIR = "archive"

# LLM Config (OpenAI via LiteLLM)
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
LLM_MODEL = os.getenv("LLM_MODEL", "openai/gpt-5-mini")

if not OPENAI_API_KEY:
    logger.error("OPENAI_API_KEY is not set! LLM calls will fail. Set it in your .env file.")
else:
    logger.info(f"OpenAI API key loaded (ends with ...{OPENAI_API_KEY[-4:]}), Model: {LLM_MODEL}")

# Configure LiteLLM callbacks for Langfuse auto-instrumentation
import litellm  # noqa: E402

litellm.success_callback = ["langfuse"]
litellm.failure_callback = ["langfuse"]

if not DB_URL:
    logger.error("DB_URL is not set! Database connections will fail.")

# R2 Config
R2_KEY_ID = os.getenv("R2_KEY_ID")
R2_APPLICATION_KEY = os.getenv("R2_APPLICATION_KEY")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME")
R2_ENDPOINT = os.getenv("R2_ENDPOINT")

# Langfuse Observability (opt-in: no-op when keys are absent)
LANGFUSE_SECRET_KEY = os.getenv("LANGFUSE_SECRET_KEY")
LANGFUSE_PUBLIC_KEY = os.getenv("LANGFUSE_PUBLIC_KEY")
LANGFUSE_HOST = os.getenv("LANGFUSE_HOST", "https://cloud.langfuse.com")
LANGFUSE_ENABLED = bool(LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY)

if LANGFUSE_ENABLED:
    logger.info(f"Langfuse observability enabled | host={LANGFUSE_HOST}")
else:
    logger.info("Langfuse observability disabled (no keys configured)")

# Sentry Error Tracking (opt-in: no-op when DSN is absent)
# Supports both SENTRY_DSN (standard) and SENTRY_DSN_BACKEND (multi-project setups)
SENTRY_DSN = os.getenv("SENTRY_DSN") or os.getenv("SENTRY_DSN_BACKEND")
SENTRY_ENABLED = bool(SENTRY_DSN)
APP_ENV = os.getenv("APP_ENV", "development")

# Brevo Email Notifications (opt-in: no-op when key is absent)
BREVO_API_KEY = os.getenv("BREVO_API_KEY")
EMAIL_FROM_NAME = os.getenv("EMAIL_FROM_NAME", "OyeChat")
EMAIL_FROM_ADDRESS = os.getenv("EMAIL_FROM_ADDRESS", "notifications@oyechats.com")
EMAIL_ENABLED = bool(BREVO_API_KEY)

if EMAIL_ENABLED:
    logger.info("Brevo email notifications enabled")
else:
    logger.info("Email notifications disabled (no BREVO_API_KEY)")

# Crawler Config (read by crawler_script.py subprocess via os.getenv directly)
# Defaults: MAX_CRAWL_PAGES=50, CRAWL_CONCURRENCY=5, CRAWL_PAGE_TIMEOUT=20, MAX_CRAWL_DEPTH=3
# CRAWL_SUBPROCESS_TIMEOUT=600 (read by crawler_service.py)
