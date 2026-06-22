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
# File Storage (Cloudflare R2 via S3-compatible API)
# `B2_*` env names are kept as a fallback for legacy deploy environments.
# ─────────────────────────────────────────────────────────────────────────────
R2_KEY_ID = os.getenv("R2_KEY_ID") or os.getenv("B2_KEY_ID")
R2_APPLICATION_KEY = os.getenv("R2_APPLICATION_KEY") or os.getenv("B2_APPLICATION_KEY")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME") or os.getenv("B2_BUCKET_NAME")
R2_ENDPOINT = os.getenv("R2_ENDPOINT") or os.getenv("B2_ENDPOINT")
# Public-facing base URL for objects in the R2 bucket. The S3 endpoint
# (`R2_ENDPOINT`) is **private** on Cloudflare R2 and rejects anonymous
# reads with `InvalidArgument/Authorization`. Public reads have to go
# through a bound custom domain (e.g. ``https://cdn.oyechats.com``) or
# the bucket's r2.dev URL. Set this in env so the helper that builds
# share-able file URLs can emit one that actually loads in the browser.
R2_PUBLIC_BASE_URL = (os.getenv("R2_PUBLIC_BASE_URL") or "").rstrip("/")

# Backwards-compatibility aliases — keep older imports working.
B2_KEY_ID = R2_KEY_ID
B2_APPLICATION_KEY = R2_APPLICATION_KEY
B2_BUCKET_NAME = R2_BUCKET_NAME
B2_ENDPOINT = R2_ENDPOINT

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

# ─────────────────────────────────────────────────────────────────────────────
# Brand & public URLs (used by email templates and any other branded surface)
# ─────────────────────────────────────────────────────────────────────────────
# Public marketing site root, e.g. "https://oyechats.com". No trailing slash.
MARKETING_URL = os.getenv("MARKETING_URL", "https://oyechats.com").rstrip("/")
# Customer admin dashboard root, e.g. "https://app.oyechats.com". No trailing slash.
# Note: distinct from FRONTEND_URL (below) which can point to localhost in dev.
APP_URL = os.getenv("APP_URL", "https://app.oyechats.com").rstrip("/")
# Address users should reach out to for help. Different from EMAIL_FROM_ADDRESS,
# which is the no-reply sender. SUPPORT_EMAIL is what appears in "Contact us".
SUPPORT_EMAIL = os.getenv("SUPPORT_EMAIL", "developer@oyechats.com")
# Display brand name + taglines used by email headers/footers.
BRAND_NAME = os.getenv("BRAND_NAME", "OyeChats")
BRAND_TAGLINE_HEADER = os.getenv("BRAND_TAGLINE_HEADER", "AI-Powered Customer Conversations")
BRAND_TAGLINE_FOOTER = os.getenv("BRAND_TAGLINE_FOOTER", "AI Customer Support, on every site")

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
        "Set it in .env (e.g. REDIS_URL=redis://localhost:6379/0) or use APP_ENV=development for local dev."
    )

if REDIS_ENABLED:
    logger.info("Redis caching enabled")
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

# Default billing provider for new subscriptions and top-ups. Customers on a
# subscription continue to use whichever provider their record is tagged with;
# this only affects new sign-ups and the admin checkout button.
# Values: "razorpay" (default — INR + UPI + cards, the primary rail) or
# "stripe" (retained only so existing Stripe subscribers can still renew /
# cancel — new checkouts route through Razorpay).
BILLING_PROVIDER = os.getenv("BILLING_PROVIDER", "razorpay").lower()

# Display currency for the admin and landing pricing page. The provider sees
# the actual currency on each charge; this is purely a presentation default
# for new subscriptions when the plan row doesn't pin a currency.
BILLING_CURRENCY = os.getenv("BILLING_CURRENCY", "INR").upper()

# Razorpay International Payments add-on. Disabled until the Razorpay account
# has KYC + business verification completed for charging non-Indian cards.
# While False, non-Indian checkout requests are short-circuited to a
# "contact sales" response so the UI can surface a CTA instead of a failed
# gateway call. Flip to True (env: ``INTL_PAYMENTS_ENABLED=true``) once the
# add-on is live — no code change needed.
INTL_PAYMENTS_ENABLED = os.getenv("INTL_PAYMENTS_ENABLED", "false").lower() in ("1", "true", "yes")

# Display-only USD/INR rate used when rendering non-Indian quotes on the
# pricing page. The gateway never sees this — INR remains the only currency
# that flows to Razorpay for actual charges. Per-plan USD prices live on the
# Plan row long-term (super-admin editor); until that column lands, this
# fallback keeps the marketing site self-consistent. Treated as ``rupees
# per US dollar``: a plan priced at ₹1,499 displays as ~$18 at the default.
DISPLAY_USD_TO_INR = float(os.getenv("DISPLAY_USD_TO_INR", "83"))

# Frontend URL for checkout redirects (Stripe success/cancel, Razorpay return).
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5174")

if STRIPE_ENABLED:
    logger.info("Stripe billing enabled")
else:
    logger.info("Stripe billing disabled (no STRIPE_SECRET_KEY)")

if RAZORPAY_ENABLED:
    logger.info("Razorpay billing enabled")
else:
    logger.info("Razorpay billing disabled (no RAZORPAY_KEY_ID)")

logger.info(f"Default billing provider: {BILLING_PROVIDER} ({BILLING_CURRENCY})")

# ─────────────────────────────────────────────────────────────────────────────
# Free-trial lifecycle
# ─────────────────────────────────────────────────────────────────────────────
# ``TRIAL_CREDITS`` is the fallback credit grant when a trial is provisioned
# without a plan reference (auth_routes.py). ``TRIAL_DATA_RETENTION_DAYS`` is
# the grace window between trial expiry and the cron that hard-deletes bot
# documents/sessions (worker/tasks.py).
#
# Trial DURATION is sourced from ``Plan.trial_days`` (seeded by alembic), NOT
# an env var — keeping it on the plan row lets super admins change trial
# length per-tier without a redeploy.
TRIAL_CREDITS = int(os.getenv("TRIAL_CREDITS", "750"))
TRIAL_DATA_RETENTION_DAYS = int(os.getenv("TRIAL_DATA_RETENTION_DAYS", "15"))

# Dunning grace window — how long a subscription stays in ``past_due`` (full
# feature access for the customer) before the auto-expire cron flips it to
# ``expired`` and the regular gates kick in. Stripe's own dunning sequence
# is typically 3 retries over ~7 days, so the default lines up with "we've
# given the gateway time to recover the card, now stop bleeding LLM credits".
PAYMENT_FAILED_GRACE_DAYS = int(os.getenv("PAYMENT_FAILED_GRACE_DAYS", "7"))

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
