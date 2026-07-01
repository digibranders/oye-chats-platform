import logging
import os
import secrets as _secrets

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
# Primary provider: "fastembed" (local ONNX, no API cost) or "openai" (API).
# FastEmbed runs BAAI/bge-base-en-v1.5 locally — 768-dim, ~420MB RAM per worker.
# OpenAI text-embedding-3-small is used as fallback when FastEmbed fails, and
# as the sole provider when EMBED_PROVIDER=openai.
EMBED_PROVIDER = os.getenv("EMBED_PROVIDER", "fastembed")
FASTEMBED_MODEL = os.getenv("FASTEMBED_MODEL", "BAAI/bge-base-en-v1.5")
EMBED_MODEL = "text-embedding-3-small"  # OpenAI fallback model
EMBED_DIMENSIONS = 768  # bge-base-en-v1.5 output dimensions
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
# Web Push (VAPID) — operator notifications when their dashboard tab is closed
# ─────────────────────────────────────────────────────────────────────────────
# Generate a keypair locally:
#     uv run python -m app.scripts.generate_vapid_keys
# Then paste the public key into VAPID_PUBLIC_KEY and the PEM into
# VAPID_PRIVATE_KEY (single-line, escape newlines as \n) or store the PEM in a
# file and point VAPID_PRIVATE_KEY_FILE at it.
VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY", "").strip()
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", "").strip()
VAPID_PRIVATE_KEY_FILE = os.getenv("VAPID_PRIVATE_KEY_FILE", "").strip()
# Required by the Web Push protocol — push providers use this to contact you
# if a subscription misbehaves. Must be a `mailto:` URL or an HTTPS site root.
VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", f"mailto:{SUPPORT_EMAIL}").strip()
# How long after the operator's last WS heartbeat we still consider them
# "actively watching the dashboard" (and therefore skip push, since the
# in-dashboard toast covers them). Tunable; 30s matches the WS ping cadence.
PUSH_WS_GRACE_SECONDS = int(os.getenv("PUSH_WS_GRACE_SECONDS", "30"))
# Visitor-message email debounce — if a visitor in a waiting/unattended session
# sends multiple messages in quick succession, only one email per window.
PUSH_VISITOR_MSG_EMAIL_DEBOUNCE_SECONDS = int(os.getenv("PUSH_VISITOR_MSG_EMAIL_DEBOUNCE_SECONDS", "60"))

PUSH_ENABLED = bool(VAPID_PUBLIC_KEY and (VAPID_PRIVATE_KEY or VAPID_PRIVATE_KEY_FILE))
if PUSH_ENABLED:
    logger.info("Web Push notifications enabled (VAPID configured)")
else:
    logger.info("Web Push notifications disabled (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing)")

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
# Billing (Razorpay)
# ─────────────────────────────────────────────────────────────────────────────
RAZORPAY_KEY_ID = os.getenv("RAZORPAY_KEY_ID")
RAZORPAY_KEY_SECRET = os.getenv("RAZORPAY_KEY_SECRET")
RAZORPAY_WEBHOOK_SECRET = os.getenv("RAZORPAY_WEBHOOK_SECRET")
RAZORPAY_ENABLED = bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)

# ── ₹1 checkout test mode (production-safe) ───────────────────────────────────
# Scope the ₹1 override to specific client IDs only, so real customers are
# never affected even when this is set in production.
#
# CHECKOUT_TEST_CLIENT_IDS — comma-separated list of client.id integers whose
#   checkouts are overridden to ₹1. Leave empty (or unset) to disable entirely.
#   Example: CHECKOUT_TEST_CLIENT_IDS=3,7
#
# RAZORPAY_TEST_PLAN_ID — Razorpay Plan ID for a ₹1/month recurring plan.
#   Required for subscription checkouts when a test client ID is matched.
#   Create once in the Razorpay dashboard: ₹1/month, e.g. "OyeChats Test ₹1".
#   Top-up orders don't need this — their amount is overridden directly.
_raw_test_ids = os.getenv("CHECKOUT_TEST_CLIENT_IDS", "")
CHECKOUT_TEST_CLIENT_IDS: frozenset[int] = frozenset(
    int(x.strip()) for x in _raw_test_ids.split(",") if x.strip().isdigit()
)
RAZORPAY_TEST_PLAN_ID: str | None = os.getenv("RAZORPAY_TEST_PLAN_ID")

# RAZORPAY_SEAT_PLAN_ID — Razorpay Plan ID for the ₹499/month extra-seat add-on.
#   Extra operator seats are billed on a SEPARATE add-on subscription against
#   this plan (quantity = number of extra seats); never as quantity on the main
#   plan, which would multiply the whole plan price. The default is the LIVE
#   plan; local/staging overrides it with the test-mode plan id via .env so
#   production never accidentally references a test plan.
RAZORPAY_SEAT_PLAN_ID: str = os.getenv("RAZORPAY_SEAT_PLAN_ID", "plan_T5rNFpt3vSkl4R")

# Default billing provider for all subscriptions and top-ups.
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
DISPLAY_USD_TO_INR = float(os.getenv("DISPLAY_USD_TO_INR", "94.67"))

# Frontend URL for Razorpay checkout redirects.
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5174")

# ─────────────────────────────────────────────────────────────────────────────
# Google OAuth — "Sign in with Google" for the admin dashboard
# ─────────────────────────────────────────────────────────────────────────────
# Credentials issued by Google Cloud Console → APIs & Services → Credentials.
# All three values are required to enable the OAuth login flow; if any is
# missing the routes return 503 ``oauth_unavailable`` so the frontend can
# downgrade gracefully (hide the button) without breaking other auth paths.
#
# ``GOOGLE_REDIRECT_URI`` MUST be registered as an Authorized redirect URI in
# the same OAuth client in Google Cloud Console — Google rejects the
# token-exchange step otherwise. For local dev:
#     http://localhost:8000/auth/google/callback
# For production:
#     https://api.oyechats.com/auth/google/callback
GOOGLE_OAUTH_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_OAUTH_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
GOOGLE_OAUTH_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/auth/google/callback")
GOOGLE_OAUTH_ENABLED = bool(GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET)

# Where the OAuth callback redirects the browser after issuing the api_key.
# The frontend reads the api_key from the URL fragment, persists it, and
# routes the user into the dashboard. Defaults to FRONTEND_URL so a single
# env var configures both Stripe and OAuth in dev.
OAUTH_SUCCESS_REDIRECT_URL = os.getenv("OAUTH_SUCCESS_REDIRECT_URL", f"{FRONTEND_URL}/auth/callback")

# HMAC key for signing the short-lived OAuth ``state`` cookie. Falls back to
# the SECRET_KEY env var if set, otherwise to a process-local random value
# (which means OAuth attempts in flight across a process restart will fail —
# acceptable since the state cookie lives for <10 minutes).
OAUTH_STATE_SECRET = os.getenv("OAUTH_STATE_SECRET") or os.getenv("SECRET_KEY") or _secrets.token_urlsafe(48)

if GOOGLE_OAUTH_ENABLED:
    logger.info("Google OAuth enabled (redirect=%s)", GOOGLE_OAUTH_REDIRECT_URI)
else:
    logger.info("Google OAuth disabled (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable)")

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


def _env_flag(name: str, *, default: bool) -> bool:
    """Parse a boolean feature flag from the environment.

    Accepts ``1/true/yes/on`` (case-insensitive) as true and
    ``0/false/no/off`` as false. An unset/blank value resolves to ``default``.
    """
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# ── Payment remediation feature flags (docs/billing/2026-06-29-remediation-plan.md) ──
#
# WEBHOOK_RETRY_ON_ERROR (default ON): when a verified webhook's processing
# raises, return 5xx so the provider retries (safe — event-id idempotency makes
# retries no-ops) and dead-letter the raw event instead of silently ACKing 200.
# Default ON because the legacy "200 on error" behaviour drops paid events; the
# flag is an emergency rollback switch only.
WEBHOOK_RETRY_ON_ERROR = _env_flag("WEBHOOK_RETRY_ON_ERROR", default=True)

# PRORATED_UPGRADES_ENABLED (default OFF): gates the Phase 6 prorated mid-cycle
# upgrade flow. Until enabled, the existing cancel-and-recreate upgrade path
# stays in effect.
PRORATED_UPGRADES_ENABLED = _env_flag("PRORATED_UPGRADES_ENABLED", default=False)

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


# ─────────────────────────────────────────────────────────────────────────────
# Crawl provider (Playwright self-host vs Spider.cloud managed API)
# ─────────────────────────────────────────────────────────────────────────────
# "playwright" (default, existing subprocess crawler) or "spider" (managed API).
CRAWL_PROVIDER = os.getenv("CRAWL_PROVIDER", "playwright").strip().lower()
SPIDER_API_KEY = os.getenv("SPIDER_API_KEY")
SPIDER_API_URL = os.getenv("SPIDER_API_URL", "https://api.spider.cloud").rstrip("/")
# Spider request engine: "http" (fast, no JS), "chrome" (JS render), "smart" (auto).
SPIDER_REQUEST_MODE = os.getenv("SPIDER_REQUEST_MODE", "smart").strip().lower()
# Per-crawl wall-clock budget (seconds). Mirrors CRAWL_SUBPROCESS_TIMEOUT.
SPIDER_TIMEOUT = int(os.getenv("SPIDER_TIMEOUT", "1600"))
# If Spider raises, fall back to the local Playwright crawler for that crawl.
# Defaults to false: production no longer installs Chromium (Spider is the sole
# crawler), so the fallback path has no browser to run. Set true ONLY in an
# environment that still has Playwright browsers installed.
SPIDER_FALLBACK_TO_PLAYWRIGHT = os.getenv("SPIDER_FALLBACK_TO_PLAYWRIGHT", "false").strip().lower() in (
    "1",
    "true",
    "yes",
)
