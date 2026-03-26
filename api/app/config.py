import os
import logging
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

DB_URL = os.getenv("DB_URL")
EMBED_MODEL = "BAAI/bge-small-en-v1.5"
CHUNK_SIZE = 1200
CHUNK_OVERLAP = 200

# Directory Paths
DOCUMENTS_DIR = "documents"
ARCHIVE_DIR = "archive"

# Gemini Config
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY4")
GEMINI_MODEL = "gemini-2.5-flash"

# Validate critical config on startup
if not GOOGLE_API_KEY:
    logger.warning("GOOGLE_API_KEY4 not found in env. Trying GOOGLE_API_KEY...")
    GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
if not GOOGLE_API_KEY:
    logger.error("NO GOOGLE API KEY FOUND! Set GOOGLE_API_KEY4 or GOOGLE_API_KEY in your .env file.")

if not DB_URL:
    logger.error("DB_URL is not set! Database connections will fail.")

# Backblaze B2 Config
B2_KEY_ID = os.getenv("B2_KEY_ID")
B2_APPLICATION_KEY = os.getenv("B2_APPLICATION_KEY")
B2_BUCKET_NAME = os.getenv("B2_BUCKET_NAME")
B2_ENDPOINT = os.getenv("B2_ENDPOINT")

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
