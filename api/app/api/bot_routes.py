import html
import ipaddress
import logging
import socket
import uuid
from datetime import UTC, datetime
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, select, update

from app.api.auth import (
    bot_subscription_status,
    get_current_bot,
    get_current_client_or_operator,
    impersonation_writable,
    require_active_subscription_for_workspace,
    require_verified_email_for_workspace,
)
from app.config import APP_URL, FRONTEND_URL, MARKETING_URL
from app.core.cache import bot_config_key, cache_delete
from app.core.origin_check import extract_hostname, normalize_domain_input
from app.core.rate_limit import limiter
from app.core.ssrf import SSRFError, validate_public_url
from app.db.models import Bot, BotGrowthEvent
from app.db.session import get_session
from app.services.brand_tone import BRAND_TONE_PRESETS, CUSTOM_PRESET, is_valid_preset_value, preset_text

# Upper bound on per-bot domain list size. 50 covers every realistic case
# (apex + wildcard + a handful of staging/sandbox subdomains) while preventing
# an accidental or malicious unbounded write.
_MAX_ALLOWED_DOMAINS = 50


def _normalize_allowed_domains(raw: list[str] | None) -> list[str]:
    """Validate, normalize, and dedupe a list of customer-supplied domains.

    Raises ``ValueError`` with a user-friendly message if any entry is invalid
    or the list exceeds :data:`_MAX_ALLOWED_DOMAINS`. Preserves the user's
    insertion order so the admin UI shows the chips back in the same sequence.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("allowed_domains must be a list of strings")
    if len(raw) > _MAX_ALLOWED_DOMAINS:
        raise ValueError(f"allowed_domains has too many entries (max {_MAX_ALLOWED_DOMAINS})")

    seen: set[str] = set()
    result: list[str] = []
    for entry in raw:
        if not isinstance(entry, str):
            raise ValueError("each allowed_domains entry must be a string")
        normalized = normalize_domain_input(entry)
        if normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _derive_allowed_domains_from_website(website: str | None) -> list[str]:
    """Best-effort: turn a free-form website URL into [apex, *.apex].

    Returns an empty list when the input cannot be parsed into a valid
    hostname; the caller decides whether that should toggle the check off.
    """
    if not website:
        return []
    try:
        apex = normalize_domain_input(website)
    except ValueError:
        return []
    if apex in {"localhost", "127.0.0.1"}:
        return [apex]
    return [apex, f"*.{apex}"]


def _normalize_session_share_domain(raw: str | None) -> str | None:
    """Validate the cross-subdomain session-sharing domain.

    Returns a bare, canonical hostname (``example.com``) or ``None`` when the
    input is empty (which disables sharing). Unlike ``allowed_domains``, a
    wildcard is rejected here: this value becomes a cookie ``Domain`` attribute,
    which is a single parent domain and cannot be a wildcard pattern. The widget
    prepends the leading dot at cookie-write time.

    Raises ``ValueError`` with a user-friendly message on an invalid domain.
    """
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValueError("session_share_domain must be a string")
    if not raw.strip():
        return None
    normalized = normalize_domain_input(raw)
    if normalized.startswith("*."):
        raise ValueError("session_share_domain cannot be a wildcard — use the parent domain, e.g. example.com")
    return normalized


logger = logging.getLogger(__name__)

# Hostnames that are OUR OWN surfaces (dashboard preview, marketing site, demo
# pages, local dev). A widget bootstrap from one of these is not a real customer
# install, so it must never stamp ``Bot.widget_installed_at``.
_INTERNAL_WIDGET_HOSTS = {
    h for h in (extract_hostname(APP_URL), extract_hostname(MARKETING_URL), extract_hostname(FRONTEND_URL)) if h
} | {"localhost", "127.0.0.1"}


def _is_external_install_origin(request: Request) -> bool:
    """True when a widget bootstrap comes from a real external site.

    The ``Origin`` header is the source of truth (``Referer`` is a fallback for
    clients that omit it). A missing/opaque origin, or one of our own hosts,
    returns False so we only stamp an install for a genuine customer embed. The
    request's own host is excluded too, because the hosted demo/preview pages are
    served by the API itself — a widget embedded there reports the API host as
    its origin, which must not count as a customer install regardless of how the
    ``APP_URL``/``MARKETING_URL`` config resolves.
    """
    origin = request.headers.get("origin") or request.headers.get("referer")
    hostname = extract_hostname(origin)
    if not hostname or hostname in _INTERNAL_WIDGET_HOSTS:
        return False
    self_host = extract_hostname(str(request.base_url))
    return hostname != self_host


router = APIRouter(prefix="/bots", tags=["bots"])
public_router = APIRouter(tags=["bots"])
DEMO_EVENT_TYPES = {"demo_share_clicked", "demo_link_opened"}


def _normalize_services(raw) -> list[dict]:
    """Coerce a stored or incoming services value to ``[{name, url}]`` objects.

    Accepts the v1 ``list[str]`` shape (just service names) and the v1.1
    ``list[{name, url}]`` shape, plus a tolerant catch for partial dicts.
    Returns a fresh list every call so callers can mutate without aliasing
    the SQLAlchemy-attached JSONB.
    """
    if not raw:
        return []
    out: list[dict] = []
    for item in raw:
        if isinstance(item, str):
            name = item.strip()
            if name:
                out.append({"name": name, "url": None})
            continue
        if isinstance(item, dict):
            name = (item.get("name") or "").strip()
            if not name:
                continue
            url = item.get("url")
            url = url.strip() if isinstance(url, str) and url.strip() else None
            out.append({"name": name, "url": url})
    return out


def _get_workspace_bot(session, bot_id: int, client_id: int) -> Bot:
    bot = session.execute(select(Bot).where(Bot.id == bot_id, Bot.client_id == client_id)).scalars().first()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found.")
    return bot


def _require_bot_management_access(auth: dict) -> None:
    """Allow workspace owners/admins to manage bots while keeping regular agents read-only."""
    if auth["type"] == "client":
        return

    if getattr(auth["entity"], "role", "operator") not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="You do not have permission to manage bots.")


def _record_growth_event(session, bot_id: int, event_type: str) -> None:
    if event_type not in DEMO_EVENT_TYPES:
        raise ValueError(f"Unsupported growth event type: {event_type}")
    session.add(BotGrowthEvent(bot_id=bot_id, event_type=event_type))


# ── Request / Response Models ──


class CreateBotRequest(BaseModel):
    name: str = "AI Assistant"
    website: str | None = None
    system_prompt: str | None = None
    bant_enabled: bool = True
    # Optional override of the auto-derived domain list. When omitted the route
    # derives ``[apex, *.apex]`` from ``website`` and turns the check on.
    allowed_domains: list[str] | None = None
    domain_check_enabled: bool | None = None

    @field_validator("allowed_domains")
    @classmethod
    def _validate_allowed_domains(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return _normalize_allowed_domains(value)


class UpdateBotRequest(BaseModel):
    name: str | None = None
    # max_length matches _MAX_CUSTOM_PROMPT_CHARS in rag_service — enforced at API boundary
    system_prompt: str | None = Field(None, max_length=2000)
    brand_tone: str | None = Field(None, max_length=500)
    # A preset key, "custom", or None — the active chip in the AI & Personality tab.
    brand_tone_preset: str | None = None
    company_name: str | None = Field(None, max_length=100)
    company_description: str | None = Field(None, max_length=1000)
    website: str | None = None
    bot_logo: str | None = None
    launcher_name: str | None = None
    launcher_logo: str | None = None
    primary_color: str | None = None
    background_color: str | None = None
    header_color: str | None = None
    user_bubble_color: str | None = None
    bant_enabled: bool | None = None
    bant_config: dict | None = None
    qualification_framework: str | None = None
    # CRAG relevance gate threshold override. None = use env default (0.55).
    # 0.0 = always pass (effectively disable), 1.0 = always fail (refuse everything).
    # Reasonable range 0.40 (lenient) – 0.70 (strict). Out-of-range writes are
    # rejected at the API; runtime ALSO clamps in case a bad value slipped past.
    relevance_threshold: float | None = Field(None, ge=0.0, le=1.0)
    avatar_type: str | None = None
    orb_color: str | None = None
    # Lead form settings
    lead_form_enabled: bool | None = None
    lead_form_fields: list[dict] | None = None
    # Email notification settings
    notification_email: str | None = None
    notification_emails: dict | None = None
    reply_to_email: str | None = None
    email_on_qualified: bool | None = None
    email_on_handoff: bool | None = None
    email_on_offline: bool | None = None
    email_visitor_confirmation: bool | None = None
    # Metered lead-enrichment opt-INs, both default OFF. Each is the third of
    # three independent gates (plan, super-admin kill switch, this customer
    # toggle); see Bot.email_verification_enabled / Bot.company_lookup_enabled.
    email_verification_enabled: bool | None = None
    company_lookup_enabled: bool | None = None
    # Live chat settings
    live_chat_enabled: bool | None = None
    operator_timeout_seconds: int | None = None
    live_chat_queue_timeout_seconds: int | None = Field(None, ge=5, le=600)
    live_chat_max_queue_size: int | None = Field(None, ge=1, le=100)
    # Business hours
    business_hours: dict | None = None
    # Feature flags — partial merge applied on PATCH (existing flags are preserved)
    feature_flags: dict | None = None
    # Widget messages — all customizable user-facing strings
    widget_messages: dict | None = None
    # Widget configuration — timing, thresholds, advanced settings
    widget_config: dict | None = None
    # Branding customization
    branding_text: str | None = None
    branding_url: str | None = None
    # Configurable visitor-facing messages
    welcome_title: str | None = None
    welcome_subtitle: str | None = None
    waiting_message: str | None = None
    offline_message: str | None = None
    handoff_delay_seconds: int | None = None
    calendly_url: str | None = None
    meeting_booking_enabled: bool | None = None
    meeting_provider: str | None = Field(None, pattern="^(calendly|zcal|calcom)$")
    zcal_url: str | None = None
    calcom_url: str | None = None
    # Each service is ``{name: str, url: str | None}``. Strings are accepted
    # for backward compat with the v1 list[str] shape and normalized to
    # ``{"name": str, "url": None}`` in the route handler.
    services: list[dict | str] | None = None
    services_url: str | None = None  # Legacy global URL — kept for compat, no longer used by prompt.
    # Widget embed origin restriction.
    allowed_domains: list[str] | None = None
    domain_check_enabled: bool | None = None
    # Cross-subdomain session continuity. Empty string clears it (disables
    # sharing); a bare/registrable domain enables it.
    session_share_domain: str | None = None

    @field_validator("allowed_domains")
    @classmethod
    def _validate_allowed_domains(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return _normalize_allowed_domains(value)

    @field_validator("session_share_domain")
    @classmethod
    def _validate_session_share_domain(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _normalize_session_share_domain(value)

    @field_validator("brand_tone_preset")
    @classmethod
    def _validate_brand_tone_preset(cls, value: str | None) -> str | None:
        if not is_valid_preset_value(value):
            raise ValueError(f"brand_tone_preset must be a known preset key, '{CUSTOM_PRESET}', or null")
        return value

    @model_validator(mode="after")
    def _validate_meeting_urls(self):
        """Ensure meeting URLs are HTTPS and point to the expected domain."""
        allowed = {
            "calendly_url": {"calendly.com"},
            "zcal_url": {"zcal.co"},
            "calcom_url": {"cal.com"},
        }
        for field_name, valid_domains in allowed.items():
            value = getattr(self, field_name, None)
            if value is None:
                continue
            parsed = urlparse(value)
            if parsed.scheme != "https":
                raise ValueError(f"{field_name} must use HTTPS")
            host = (parsed.hostname or "").lower()
            if not any(host == d or host.endswith(f".{d}") for d in valid_domains):
                raise ValueError(f"{field_name} must point to {', '.join(valid_domains)}")
        return self


class BotResponse(BaseModel):
    id: int
    bot_key: str
    name: str
    website: str | None
    system_prompt: str | None
    brand_tone: str | None = None
    brand_tone_preset: str | None = None
    company_name: str | None = None
    company_description: str | None = None
    # Auto-fillable fields the customer has locked by hand-editing them; the
    # crawl won't overwrite these. Drives the "auto-filled vs manual" hint in
    # the AI & Personality tab.
    manual_field_overrides: list[str] = []
    bot_logo: str | None
    launcher_name: str
    launcher_logo: str | None
    primary_color: str
    background_color: str
    header_color: str
    recommended_colors: list | None
    user_bubble_color: str = "#DBE9FF"
    bant_enabled: bool
    bant_config: dict | None = None
    relevance_threshold: float | None = None
    avatar_type: str
    orb_color: str | None
    lead_form_enabled: bool = False
    lead_form_fields: list[dict] | None = None
    # Default FALSE, matching the column. Both construction sites pass explicit
    # values today, so this is only a fallback — but a fallback pointing the
    # wrong way is how a future construction that omits them would publish ON
    # for a row that is OFF, and the frontend renders the switch on `=== true`.
    email_verification_enabled: bool = False
    company_lookup_enabled: bool = False
    notification_email: str | None = None
    notification_emails: dict | None = None
    reply_to_email: str | None = None
    email_on_qualified: bool = True
    email_on_handoff: bool = True
    email_on_offline: bool = True
    email_visitor_confirmation: bool = True
    live_chat_enabled: bool = True
    # Set once the embedded widget has been seen live on a real external site;
    # None until then. Drives the "widget installed" setup-checklist step.
    widget_installed_at: datetime | None = None
    # Durable per-bot ingestion ("trained") state — a persistent fact the UI can
    # read instead of racing the ephemeral /crawl/progress toast.
    last_crawl_status: str | None = None
    crawl_completed_at: datetime | None = None
    indexed_chunk_count: int = 0
    operator_timeout_seconds: int = 120
    live_chat_queue_timeout_seconds: int = 20
    live_chat_max_queue_size: int = 10
    business_hours: dict | None = None
    feature_flags: dict = {}
    widget_messages: dict = {}
    widget_config: dict = {}
    branding_text: str = "Powered by OyeChats"
    branding_url: str = "https://www.oyechats.com"
    # Configurable visitor-facing messages
    welcome_title: str = "Hi there 👋"
    welcome_subtitle: str = "How can we help you today?"
    waiting_message: str = "Connecting you to support..."
    offline_message: str = "We'll be right back! Leave a message and we'll follow up shortly."
    handoff_delay_seconds: int = 0
    calendly_url: str | None = None
    meeting_booking_enabled: bool = False
    meeting_provider: str | None = None
    zcal_url: str | None = None
    calcom_url: str | None = None
    # Always returned as ``[{name, url}]`` objects regardless of stored shape.
    services: list[dict] | None = None
    services_url: str | None = None  # Legacy field kept for compat.
    allowed_domains: list[str] = []
    domain_check_enabled: bool = False
    session_share_domain: str | None = None
    is_active: bool
    created_at: str
    # THIS bot's own plan (with account fallback), resolved server-side by
    # `get_bot_entitlements`. Billing attaches to the Bot, so a workspace can
    # hold a Professional agent and a Free agent at once, and the admin UI's
    # per-agent feature gates need the agent's own answer. The frontend used to
    # infer it from the credit-balance payload, which omits Free agents
    # entirely (they have no per-bot ledger) — so a Free agent silently
    # inherited the workspace's highest-priced plan and rendered paid controls
    # the server then denied. Defaults to "free": fail closed.
    plan_slug: str = "free"
    # Display-only sibling of `plan_slug`, resolved in the same call so the
    # plan chip can never disagree with the feature switch beside it.
    plan_name: str = "Free"

    class Config:
        from_attributes = True


def bot_plan(bot_id: int, session) -> tuple[str, str]:
    """This bot's own ``(plan_slug, plan_name)``. Fails closed to Free.

    Mirrors the widget-config resolution in ``get_bot_config`` and the gates in
    ``plan_entitlements_service``: never let a resolution error read as a paid
    tier. The slug drives gates; the name is display-only, and the two travel
    together so a chip can never disagree with the switch beside it.
    """
    from app.services import plan_entitlements_service

    try:
        ents = plan_entitlements_service.get_bot_entitlements(bot_id, session)
        slug, name = ents.plan_slug, ents.plan_name
    except Exception:
        logger.warning("bot_plan: entitlements lookup failed for bot %s — defaulting to Free", bot_id)
        return "free", "Free"

    # Type-checked, not just truthy: a non-string here (a stub, a bad row) would
    # sail through `or "free"` and reach the response as a value the frontend's
    # slug comparison can never match — an agent locked out of everything it
    # pays for, with no error anywhere.
    safe_slug = slug.lower() if isinstance(slug, str) and slug else "free"
    safe_name = name if isinstance(name, str) and name else "Free"
    return safe_slug, safe_name


def bot_plan_slug(bot_id: int, session) -> str:
    """Just the slug from :func:`bot_plan`, for gate-only callers."""
    return bot_plan(bot_id, session)[0]


def _bot_to_response(bot: Bot, request: Request, *, plan_slug: str = "free", plan_name: str = "Free") -> BotResponse:
    """Serialize a ``Bot`` row into the public ``BotResponse``.

    Single source of truth for the shape returned by ``GET /bots``,
    ``GET /bots/{id}`` and ``POST /bots`` so those endpoints can never drift.
    Stored logo paths are absolutized against the current request host.
    """
    base = str(request.base_url).rstrip("/")
    bl = bot.bot_logo
    if bl and not bl.startswith("http"):
        bl = f"{base}/files/{bl}"
    ll = bot.launcher_logo
    if ll and not ll.startswith("http"):
        ll = f"{base}/files/{ll}"

    return BotResponse(
        plan_slug=plan_slug,
        plan_name=plan_name,
        id=bot.id,
        bot_key=bot.bot_key,
        name=bot.name,
        website=bot.website,
        system_prompt=bot.system_prompt,
        brand_tone=bot.brand_tone,
        brand_tone_preset=bot.brand_tone_preset,
        company_name=bot.company_name,
        company_description=bot.company_description,
        manual_field_overrides=bot.manual_field_overrides or [],
        bot_logo=bl,
        launcher_name=bot.launcher_name or "Have Questions?",
        launcher_logo=ll,
        primary_color=bot.primary_color or "#ba68c8",
        background_color=bot.background_color or "#ffffff",
        header_color=bot.header_color or "#3A0CA3",
        recommended_colors=bot.recommended_colors or [],
        user_bubble_color=bot.user_bubble_color or "#DBE9FF",
        bant_enabled=bot.bant_enabled,
        bant_config=bot.bant_config,
        relevance_threshold=bot.relevance_threshold,
        avatar_type=bot.avatar_type or "upload",
        orb_color=bot.orb_color,
        lead_form_enabled=bot.lead_form_enabled,
        lead_form_fields=bot.lead_form_fields,
        email_verification_enabled=bool(bot.email_verification_enabled),
        company_lookup_enabled=bool(bot.company_lookup_enabled),
        notification_email=bot.notification_email,
        notification_emails=bot.notification_emails,
        reply_to_email=bot.reply_to_email,
        email_on_qualified=bot.email_on_qualified,
        email_on_handoff=bot.email_on_handoff,
        email_on_offline=bot.email_on_offline,
        email_visitor_confirmation=bot.email_visitor_confirmation,
        live_chat_enabled=bot.live_chat_enabled,
        widget_installed_at=bot.widget_installed_at,
        last_crawl_status=bot.last_crawl_status,
        crawl_completed_at=bot.crawl_completed_at,
        indexed_chunk_count=bot.indexed_chunk_count or 0,
        operator_timeout_seconds=bot.operator_timeout_seconds,
        live_chat_queue_timeout_seconds=bot.live_chat_queue_timeout_seconds,
        live_chat_max_queue_size=bot.live_chat_max_queue_size,
        business_hours=bot.business_hours,
        feature_flags=bot.feature_flags or {},
        widget_messages=bot.widget_messages or {},
        widget_config=bot.widget_config or {},
        branding_text=bot.branding_text or "Powered by OyeChats",
        branding_url=bot.branding_url or "https://www.oyechats.com",
        welcome_title=bot.welcome_title or "Hi there 👋",
        welcome_subtitle=bot.welcome_subtitle or "How can we help you today?",
        waiting_message=bot.waiting_message or "Connecting you to support...",
        offline_message=bot.offline_message or "We'll be right back! Leave a message and we'll follow up shortly.",
        handoff_delay_seconds=bot.handoff_delay_seconds or 0,
        calendly_url=bot.calendly_url,
        meeting_booking_enabled=bot.meeting_booking_enabled,
        meeting_provider=bot.meeting_provider,
        zcal_url=bot.zcal_url,
        calcom_url=bot.calcom_url,
        services=_normalize_services(bot.services),
        services_url=bot.services_url,
        allowed_domains=list(bot.allowed_domains or []),
        domain_check_enabled=bool(bot.domain_check_enabled),
        session_share_domain=bot.session_share_domain,
        is_active=bot.is_active,
        created_at=bot.created_at.isoformat() if bot.created_at else "",
    )


def _find_bot_by_website(session, client_id: int, website: str | None) -> Bot | None:
    """Return an existing workspace bot whose website resolves to the same apex
    host as ``website`` — or ``None`` if there is no match.

    Used to make onboarding bot-creation idempotent: a retried/duplicate create
    for the same site (the Build Studio double-submit) returns the bot that was
    already created instead of tripping the free 1-bot cap with a confusing 402.
    """
    if not website:
        return None
    try:
        target = normalize_domain_input(website)
    except ValueError:
        return None
    rows = session.execute(select(Bot).where(Bot.client_id == client_id)).scalars().all()
    for b in rows:
        if not b.website:
            continue
        try:
            if normalize_domain_input(b.website) == target:
                return b
        except ValueError:
            continue
    return None


# ── Endpoints ──

# IMPORTANT: Static sub-paths MUST be defined before /{bot_id} dynamic routes
# to prevent FastAPI from trying to parse "settings" as an integer bot_id.


@router.get("/settings/public")
def get_bot_settings_public(request: Request, bot: Bot = Depends(get_current_bot)):
    """
    Public endpoint for the widget to fetch bot settings.
    Authenticated via X-Bot-Key or X-API-Key (backward compat).

    Includes the bot owner's subscription health so the widget can choose
    to suppress the launcher (or render an offline indicator) when the
    workspace is not serving. ``is_offline=True`` means visitors who do
    open the widget will only get the configured ``offline_message`` —
    the chat endpoint will not run RAG.
    """
    # One-time "widget is live" detection. The first time the widget bootstraps
    # from a real external site (not our dashboard preview / demo / localhost),
    # stamp the bot so the Dashboard setup checklist can confirm the install
    # without a user self-report. Best-effort and idempotent — the guarded
    # UPDATE only matches while the column is NULL, and we invalidate the cached
    # bot config so subsequent loads skip this path entirely. Never blocks the
    # widget response.
    if bot.widget_installed_at is None and _is_external_install_origin(request):
        try:
            with get_session() as _install_session:
                stamped = _install_session.execute(
                    update(Bot)
                    .where(Bot.id == bot.id, Bot.widget_installed_at.is_(None))
                    .values(widget_installed_at=func.now())
                ).rowcount
                _install_session.commit()
            if stamped:
                cache_delete(bot_config_key(bot.bot_key))
        except Exception:
            logger.debug("widget install stamp skipped for bot_id=%s", getattr(bot, "id", None), exc_info=True)

    # Construct backend file URL for relative logos
    logo_url = bot.bot_logo
    if logo_url and not logo_url.startswith("http"):
        logo_url = f"{str(request.base_url).rstrip('/')}/files/{logo_url}"

    launcher_logo_url = bot.launcher_logo
    if launcher_logo_url and not launcher_logo_url.startswith("http"):
        launcher_logo_url = f"{str(request.base_url).rstrip('/')}/files/{launcher_logo_url}"

    owner_status = bot_subscription_status(bot.client_id, subscription_id=getattr(bot, "subscription_id", None))
    is_offline = owner_status not in ("trialing", "active", "past_due")

    # Plan-feature gate for live chat. Even if the bot has live_chat_enabled
    # toggled on, we suppress the widget's "Live chat" affordance when the
    # owner's plan doesn't include the feature. Otherwise visitors would see
    # a button that — when clicked — routes them to a queue with no possible
    # operator. The operator side of the platform 403s the toggle endpoint,
    # so this exposed surface is the last visible artifact to clean up.
    from app.db.session import get_session as _get_session
    from app.services import plan_entitlements_service

    plan_includes_live_chat = False
    plan_slug = "free"
    _plan_branding_removable = False  # fail-closed: never hide branding on resolution error
    try:
        with _get_session() as _s:
            # Per-bot: the widget reflects THIS bot's own plan (with account
            # fallback), so a bot downgraded to Starter re-shows branding and
            # loses live chat even while a sibling bot stays on a higher tier.
            _ents = plan_entitlements_service.get_bot_entitlements(bot.id, _s)
            plan_includes_live_chat = _ents.has_feature("live_chat")
            plan_slug = (_ents.plan_slug or "free").lower()
            _plan_branding_removable = _ents.has_feature("branding_removable")
    except Exception:
        # Fail closed — if we can't resolve the plan, hide live chat AND
        # apply Free-plan widget-behavior locks. Safer than leaking a paid
        # feature when the entitlements check fails.
        plan_includes_live_chat = False
        plan_slug = "free"
        _plan_branding_removable = False
    effective_live_chat_enabled = bool(bot.live_chat_enabled) and plan_includes_live_chat

    # Free plan: the Widget Behavior section in Admin → Settings is fully
    # locked, so the stored feature_flags may be stale (e.g. left over from
    # a previous paid tier). Override with the Free-plan locked values so
    # the widget actually behaves the way the locked admin UI advertises.
    # Mirrored in `platform/app/src/pages/Settings.jsx` (FREE_PLAN_LOCKED_FLAGS).
    effective_feature_flags = dict(bot.feature_flags or {})
    if plan_slug == "free":
        effective_feature_flags.update(
            {
                "file_sharing": False,
                "post_chat_rating": False,
                "show_branding": True,
                "queue_position": False,
                "typing_preview": False,
                "email_transcript": False,
            }
        )
    elif not _plan_branding_removable:
        # Non-free plans that don't include branding removal (e.g. Starter)
        # must also force show_branding=True. The admin UI locks the toggle
        # for these plans but stored feature_flags may have show_branding=False
        # left over from a previous paid tier — enforce server-side so the
        # widget always reflects the plan entitlement.
        effective_feature_flags["show_branding"] = True

    return {
        "bot_name": bot.name,
        "bot_logo": logo_url,
        "launcher_name": bot.launcher_name or "Have Questions?",
        "launcher_logo": launcher_logo_url,
        "primary_color": bot.primary_color or "#ba68c8",
        "background_color": bot.background_color or "#ffffff",
        "header_color": bot.header_color or "#3A0CA3",
        "recommended_colors": bot.recommended_colors or [],
        "user_bubble_color": bot.user_bubble_color or "#DBE9FF",
        "bant_enabled": bot.bant_enabled,
        "avatar_type": bot.avatar_type or "upload",
        "orb_color": bot.orb_color,
        "lead_form_enabled": bot.lead_form_enabled,
        "email_verification_enabled": bool(bot.email_verification_enabled),
        "company_lookup_enabled": bool(bot.company_lookup_enabled),
        "lead_form_fields": bot.lead_form_fields,
        "live_chat_enabled": effective_live_chat_enabled,
        "business_hours": bot.business_hours,
        "feature_flags": effective_feature_flags,
        "widget_messages": bot.widget_messages or {},
        "widget_config": bot.widget_config or {},
        "branding_text": bot.branding_text or "Powered by OyeChats",
        "branding_url": bot.branding_url or "https://www.oyechats.com",
        "welcome_title": bot.welcome_title or "Hi there 👋",
        "welcome_subtitle": bot.welcome_subtitle or "How can we help you today?",
        "waiting_message": bot.waiting_message or "Connecting you to support...",
        "offline_message": bot.offline_message or "We'll be right back! Leave a message and we'll follow up shortly.",
        "handoff_delay_seconds": bot.handoff_delay_seconds or 0,
        "meeting_booking_enabled": bot.meeting_booking_enabled,
        "meeting_provider": bot.meeting_provider,
        "calendly_url": bot.calendly_url,
        "zcal_url": bot.zcal_url,
        "calcom_url": bot.calcom_url,
        # Cross-subdomain session continuity (null = disabled). When set, the
        # widget mirrors the session id into a cookie scoped to this parent
        # domain so the conversation survives navigation across subdomains.
        "session_share_domain": bot.session_share_domain,
        "bant_cta_options": _build_public_cta_options(bot),
        # ── Service status ──
        # ``is_offline=True`` flips the widget into "leave a message" mode
        # without exposing the underlying subscription status to visitors.
        "is_offline": is_offline,
        "offline_reason": f"subscription_{owner_status}" if is_offline else None,
    }


def _build_public_cta_options(bot) -> dict:
    """Build sanitized CTA options for the widget (no scoring rubric exposed).

    BR-01: previously hardcoded to BANT's own dimension names
    (need/timeline/authority/budget) regardless of the bot's actual
    ``framework`` — a MEDDIC/CHAMP/GPCTBA+C&I bot's CTA-enabled dimensions
    (e.g. ``economic_buyer``, ``champion``) were silently never sent to the
    widget at all, no matter how the admin configured ``cta_enabled``.
    Iterates the bot's real framework dimensions instead.
    """
    from app.services.lead_service import get_bant_config
    from app.services.qualification_service import framework_dimension_keys

    config = get_bant_config(bot)
    dimensions = framework_dimension_keys(config) or ["need", "timeline", "authority", "budget"]
    cta_options = {}
    for dim in dimensions:
        dim_config = config.get(dim, {})
        if dim_config.get("cta_enabled", False):
            cta_options[dim] = {
                "prompt": dim_config.get("cta_prompt", ""),
                "options": [o["label"] for o in dim_config.get("options", [])],
            }
    return cta_options


def _build_demo_page_html(bot: Bot, edit: bool = False) -> str:
    bot_name = html.escape(bot.name or "OyeChats")
    website = (bot.website or "").strip()
    website_link = ""
    if website.startswith(("http://", "https://")):
        safe_website = html.escape(website)
        website_link = (
            f'<a class="demo-link" href="{safe_website}" target="_blank" rel="noopener noreferrer">'
            f"Visit {safe_website}</a>"
        )
    editor_bootstrap = _PREVIEW_EDITOR_BOOTSTRAP if edit else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{bot_name} Demo | OyeChats</title>
  <meta name="description" content="Try the {bot_name} assistant powered by OyeChats." />
  <style>
    :root {{
      color-scheme: light;
      --ink: #102033;
      --muted: #5a6b7f;
      --panel: rgba(255, 255, 255, 0.9);
      --line: rgba(16, 32, 51, 0.08);
      --accent: #0f6dff;
      --accent-strong: #0a56ca;
      --bg-a: #eff6ff;
      --bg-b: #f8fafc;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15, 109, 255, 0.18), transparent 36%),
        radial-gradient(circle at bottom right, rgba(56, 189, 248, 0.16), transparent 34%),
        linear-gradient(135deg, var(--bg-a), var(--bg-b));
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }}
    .shell {{
      width: min(960px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: 0 24px 80px rgba(15, 23, 42, 0.14);
      overflow: hidden;
      backdrop-filter: blur(20px);
    }}
    .hero {{
      padding: 40px 40px 24px;
      display: grid;
      gap: 16px;
    }}
    .eyebrow {{
      width: fit-content;
      padding: 7px 12px;
      border-radius: 999px;
      background: rgba(15, 109, 255, 0.1);
      color: var(--accent-strong);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }}
    h1 {{
      margin: 0;
      font-size: clamp(2rem, 5vw, 4rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }}
    p {{
      margin: 0;
      max-width: 680px;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.65;
    }}
    .actions {{
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 8px;
    }}
    .demo-link {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 44px;
      padding: 0 18px;
      border-radius: 999px;
      background: var(--accent);
      color: white;
      font-weight: 600;
      text-decoration: none;
      transition: background 0.18s ease;
    }}
    .demo-link:hover {{ background: var(--accent-strong); }}
    .hint {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      padding: 0 40px 40px;
    }}
    .hint-card {{
      padding: 18px;
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid rgba(16, 32, 51, 0.06);
    }}
    .hint-card strong {{
      display: block;
      margin-bottom: 6px;
      font-size: 0.95rem;
    }}
    .hint-card span {{
      color: var(--muted);
      font-size: 0.92rem;
      line-height: 1.5;
    }}
    @media (max-width: 640px) {{
      .hero, .hint {{
        padding-left: 22px;
        padding-right: 22px;
      }}
      .hero {{ padding-top: 24px; }}
      .hint {{ padding-bottom: 22px; }}
    }}
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="eyebrow">Interactive Demo</div>
      <h1>Try {bot_name} on a live page.</h1>
      <p>This preview mirrors the production OyeChats widget for this bot. Open the chat launcher in the bottom-right corner and run a few realistic questions before you embed it on your site.</p>
      <div class="actions">
        {website_link}
      </div>
    </section>
    <section class="hint">
      <div class="hint-card">
        <strong>Ask a real question</strong>
        <span>Use the launcher to test product FAQs, support scenarios, or qualification prompts.</span>
      </div>
      <div class="hint-card">
        <strong>Share this page</strong>
        <span>Send the demo URL to teammates or prospects so they can try the bot without touching your website code.</span>
      </div>
      <div class="hint-card">
        <strong>Deploy when ready</strong>
        <span>Once the responses feel right, use the existing embed guide in the dashboard to put the same bot on your site.</span>
      </div>
    </section>
  </main>
  {editor_bootstrap}<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="{html.escape(bot.bot_key)}"></script>
</body>
</html>
"""


def _validate_preview_url(raw_url: str) -> str:
    """Validate that a preview URL uses http/https, has a valid host, and does not resolve to a private IP.

    Blocks SSRF by resolving the hostname and rejecting private, loopback,
    link-local, and other reserved IP ranges before allowing server-side requests.
    """
    parsed = urlparse(raw_url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL must use http or https scheme.")
    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(status_code=400, detail="Invalid URL.")

    try:
        addr_info = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail="Could not resolve hostname.") from exc

    for _family, _type, _proto, _canonname, sockaddr in addr_info:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise HTTPException(status_code=400, detail="URLs pointing to internal addresses are not allowed.")

    return raw_url


def _check_iframe_allowed(target_url: str) -> bool:
    """HEAD-check whether *target_url* allows being loaded in an iframe.

    Returns ``True`` when the site does **not** block framing (or we
    cannot determine), ``False`` when ``X-Frame-Options: DENY`` or a
    ``frame-ancestors 'none'`` CSP directive is detected.  Network
    errors are treated as "allow" so the iframe gets a chance to load.
    """
    import httpx  # local import — only used in this preview path

    # Re-validate here (defence in depth) and — crucially — do NOT follow
    # redirects: the initial URL passed _validate_preview_url, but a 3xx could
    # bounce the server-side request to an internal address. A redirect is
    # surfaced as-is (its 3xx response carries no framing headers → "allow").
    # (audit F11)
    try:
        validate_public_url(target_url)
    except SSRFError:
        return False

    try:
        with httpx.Client(timeout=5, follow_redirects=False) as client:
            resp = client.head(target_url, headers={"User-Agent": "OyeChats-Preview/1.0"})
            # A redirect (http→https, apex→www — near-universal): we intentionally
            # don't follow it (SSRF), so we can't read the final page's framing
            # headers. Report not-embeddable so the demo serves the working hero
            # fallback instead of embedding a page that likely blocks framing
            # (code-review RV6).
            if 300 <= resp.status_code < 400:
                return False
            xfo = (resp.headers.get("x-frame-options") or "").strip().upper()
            if xfo in ("DENY", "SAMEORIGIN"):
                return False
            csp = resp.headers.get("content-security-policy") or ""
            for directive in csp.split(";"):
                d = directive.strip().lower()
                if d.startswith("frame-ancestors"):
                    # "frame-ancestors 'none'" or "frame-ancestors 'self'" block us
                    parts = d.split()
                    if len(parts) >= 2 and parts[1] in ("'none'", "'self'"):
                        return False
            return True
    except Exception:
        # Network error, timeout, DNS failure — let the iframe try
        return True


def _mask_bot_key(bot_key: str) -> str:
    """Show first 6 and last 4 characters of a bot key."""
    if len(bot_key) <= 12:
        return bot_key
    return f"{bot_key[:6]}{'•' * (len(bot_key) - 10)}{bot_key[-4:]}"


_PREVIEW_EDITOR_BOOTSTRAP = "<script>window.__OYECHATS_PREVIEW_MODE__=true;</script>\n"


def _build_preview_page_html(bot: Bot, target_url: str, edit: bool = False) -> str:
    """Build an iframe-based preview page that overlays the widget on a real website.

    When *edit* is True, a bootstrap flag is injected so the widget enables its
    live-preview bridge (accepts `oyechats:preview-config` postMessage events
    from the parent frame — typically the admin dashboard editor).
    """
    bot_name = html.escape(bot.name or "OyeChats")
    bot_key = html.escape(bot.bot_key)
    masked_key = html.escape(_mask_bot_key(bot.bot_key))
    safe_url = html.escape(target_url)
    editor_bootstrap = _PREVIEW_EDITOR_BOOTSTRAP if edit else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{bot_name} Preview | OyeChats</title>
  <style>
    /*
     * Scope resets to preview-shell only — never touch #oyechats-widget-root
     * or its children, as the widget ships its own self-contained styles.
     */
    .preview-shell,
    .preview-shell *,
    .preview-shell *::before,
    .preview-shell *::after {{
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }}
    html, body {{
      height: 100%;
      overflow: hidden;
      margin: 0;
      padding: 0;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    }}
    .preview-shell {{
      display: flex;
      flex-direction: column;
      height: 100vh;
    }}
    .toolbar {{
      height: 52px;
      flex-shrink: 0;
      background: #0f172a;
      color: #e2e8f0;
      display: flex;
      align-items: center;
      padding: 0 20px;
      gap: 16px;
      font-size: 14px;
      z-index: 10;
    }}
    .toolbar-bot {{
      display: flex;
      align-items: center;
      gap: 10px;
    }}
    .toolbar-bot-icon {{
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: linear-gradient(135deg, #3b82f6, #6366f1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
      color: white;
    }}
    .toolbar-name {{
      font-weight: 600;
      color: #f8fafc;
    }}
    .toolbar-key {{
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 12px;
      color: #64748b;
      background: rgba(255,255,255,0.06);
      padding: 3px 8px;
      border-radius: 6px;
    }}
    .toolbar-spacer {{ flex: 1; }}
    .toolbar-brand {{
      font-size: 12px;
      color: #64748b;
      text-decoration: none;
      transition: color 0.15s;
    }}
    .toolbar-brand:hover {{ color: #94a3b8; }}
    .toolbar-badge {{
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(34,197,94,0.12);
      color: #4ade80;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }}
    .toolbar-badge::before {{
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #4ade80;
    }}
    .preview-frame {{
      width: 100%;
      flex: 1;
      border: none;
      display: block;
    }}
    .fallback {{
      display: none;
      width: 100%;
      flex: 1;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      background: #f8fafc;
      color: #334155;
      text-align: center;
      padding: 40px;
    }}
    .fallback.visible {{
      display: flex;
    }}
    .fallback h2 {{
      font-size: 20px;
      font-weight: 700;
      color: #0f172a;
    }}
    .fallback p {{
      max-width: 480px;
      font-size: 15px;
      line-height: 1.6;
      color: #64748b;
    }}
    .fallback-icon {{
      width: 56px;
      height: 56px;
      border-radius: 16px;
      background: #eff6ff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
    }}
  </style>
</head>
<body>
  <div class="preview-shell">
    <div class="toolbar">
      <div class="toolbar-bot">
        <div class="toolbar-bot-icon">{bot_name[0].upper()}</div>
        <span class="toolbar-name">{bot_name}</span>
      </div>
      <span class="toolbar-key">{masked_key}</span>
      <span class="toolbar-badge">Preview</span>
      <div class="toolbar-spacer"></div>
      <a class="toolbar-brand" href="https://www.oyechats.com" target="_blank" rel="noopener">Powered by OyeChats</a>
    </div>
    <iframe
      id="preview-frame"
      class="preview-frame"
      src="{safe_url}"
      referrerpolicy="no-referrer"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope"
      loading="eager"
    ></iframe>
    <div id="fallback" class="fallback">
      <div class="fallback-icon">&#x1f6e1;</div>
      <h2>Website blocked embedding</h2>
      <p>This website doesn&rsquo;t allow being loaded inside a preview frame. The chat widget is still active &mdash; try it using the launcher in the bottom-right corner.</p>
    </div>
  </div>
  {editor_bootstrap}<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="{bot_key}"></script>
  <script>
    (function() {{
      var frame = document.getElementById('preview-frame');
      var fallback = document.getElementById('fallback');
      var shown = false;

      function showFallback() {{
        if (shown) return;
        shown = true;
        frame.style.display = 'none';
        fallback.classList.add('visible');
      }}

      /*
       * Detection strategy:
       * 1. Pre-flight: fetch the URL in no-cors mode.  If the server
       *    responds with an opaque response we cannot inspect headers,
       *    but a network error (DNS, TLS, etc.) rejects the promise.
       * 2. On iframe load: try to read contentWindow.length — an error
       *    page served by the browser after X-Frame-Options block
       *    typically has 0 sub-frames AND we can still read `length`
       *    (it's cross-origin accessible).  We combine this with a
       *    same-origin document check for blank/empty pages.
       * 3. Hard timeout as last-resort.
       */

      frame.addEventListener('load', function() {{
        try {{
          // Same-origin check — works when our server serves the error
          var doc = frame.contentDocument;
          if (doc) {{
            var url = doc.URL || '';
            var body = (doc.body && doc.body.innerHTML) || '';
            if (url === 'about:blank' || body.trim() === '') {{
              showFallback();
            }}
            return;
          }}
        }} catch(e) {{
          // Cross-origin: expected for external sites that DID load.
        }}
      }});

      frame.addEventListener('error', function() {{
        showFallback();
      }});

      // Hard timeout: if the iframe area is still blank after 8s,
      // show fallback.
      setTimeout(function() {{
        if (shown) return;
        try {{
          // Last-chance same-origin check
          var doc = frame.contentDocument;
          if (doc && (!doc.body || doc.body.innerHTML.trim() === '')) {{
            showFallback();
          }}
        }} catch(e) {{
          // Cross-origin: site is loaded, all good.
        }}
      }}, 8000);
    }})();
  </script>
</body>
</html>
"""


@public_router.get("/demo/{bot_key}", response_class=HTMLResponse)
@limiter.limit("20/minute")
def get_bot_demo_page(
    request: Request,
    bot_key: str,
    url: str | None = Query(default=None),
    edit: int = Query(default=0, ge=0, le=1),
):
    """Render a shareable demo page, or an iframe-based preview when *url* is supplied.

    When ``edit=1`` is passed, the page enables a postMessage bridge so the
    embedding dashboard can drive widget appearance in real time.
    """
    edit_mode = edit == 1
    with get_session() as session:
        bot = session.execute(select(Bot).where(Bot.bot_key == bot_key, Bot.is_active.is_(True))).scalars().first()
        if not bot:
            raise HTTPException(status_code=404, detail="Bot demo not found.")

        _record_growth_event(session, bot.id, "demo_link_opened")
        session.commit()

        if url:
            _validate_preview_url(url)
            if _check_iframe_allowed(url):
                return HTMLResponse(content=_build_preview_page_html(bot, url, edit=edit_mode))
            # Site blocks framing — fall through to the hero demo page
            # so the user still sees a working widget.
        return HTMLResponse(content=_build_demo_page_html(bot, edit=edit_mode))


@router.get("", response_model=list[BotResponse])
def list_bots(
    request: Request,
    acting_as: str | None = Header(None, alias="X-Acting-Role"),
    auth=Depends(get_current_client_or_operator),
):
    """List bots the caller can act on.

    Scoping matrix
    --------------
    * **Client / workspace owner (own workspace, no operator hat)** — every
      bot in the workspace.
    * **Operator (X-Operator-Key or linked-operator via X-Workspace-Id)** —
      the single bot they're bound to (one-to-one operator↔bot binding).
    * **Owner acting as their own self-operator** — the auth resolver classifies
      this as ``type="client"`` because the caller is looking at their own
      workspace, so the operator-scoping branch above wouldn't fire on its
      own. When the frontend sends ``X-Acting-Role: operator`` (the workspace
      switcher pill sets this whenever ``currentRole === 'operator'``), we
      look up the caller's self-operator row and restrict to that bot too.
      Falling back to the full workspace list on any lookup miss preserves
      owner UX for clients whose frontend didn't send the hint.

    Operators must not see or switch to other bots in the workspace; the admin
    UI's bot switcher renders this list verbatim, so filtering here keeps
    unauthorised bots off the client entirely.
    """
    client_id = auth["client_id"]
    with get_session() as session:
        stmt = select(Bot).where(Bot.client_id == client_id).order_by(Bot.id)
        if auth["type"] == "operator":
            operator_bot_id = auth.get("bot_id") or getattr(auth.get("entity"), "bot_id", None)
            if operator_bot_id is None:
                return []
            stmt = stmt.where(Bot.id == operator_bot_id)
        elif auth["type"] == "client" and (acting_as or "").lower() == "operator":
            # Self-operator path — owner added themselves as an operator in
            # their own workspace and the switcher pill is in "operator"
            # mode. Resolve the self-operator row (client_id ==
            # linked_client_id == workspace owner id) and scope to its bot.
            from app.db.models import Operator as _Op

            self_op_bot_id = session.execute(
                select(_Op.bot_id).where(
                    _Op.client_id == client_id,
                    _Op.linked_client_id == client_id,
                    _Op.is_active.is_(True),
                )
            ).scalar_one_or_none()
            if self_op_bot_id is not None:
                stmt = stmt.where(Bot.id == self_op_bot_id)
        bots = session.execute(stmt).scalars().all()
        bots_response = []
        for b in bots:
            _b_plan = bot_plan(b.id, session)
            bl = b.bot_logo
            if bl and not bl.startswith("http"):
                bl = f"{str(request.base_url).rstrip('/')}/files/{bl}"
            ll = b.launcher_logo
            if ll and not ll.startswith("http"):
                ll = f"{str(request.base_url).rstrip('/')}/files/{ll}"

            bots_response.append(
                BotResponse(
                    plan_slug=_b_plan[0],
                    plan_name=_b_plan[1],
                    id=b.id,
                    bot_key=b.bot_key,
                    name=b.name,
                    website=b.website,
                    system_prompt=b.system_prompt,
                    brand_tone=b.brand_tone,
                    brand_tone_preset=b.brand_tone_preset,
                    company_name=b.company_name,
                    company_description=b.company_description,
                    manual_field_overrides=b.manual_field_overrides or [],
                    bot_logo=bl,
                    launcher_name=b.launcher_name or "Have Questions?",
                    launcher_logo=ll,
                    primary_color=b.primary_color or "#ba68c8",
                    background_color=b.background_color or "#ffffff",
                    header_color=b.header_color or "#3A0CA3",
                    recommended_colors=b.recommended_colors or [],
                    user_bubble_color=b.user_bubble_color or "#DBE9FF",
                    bant_enabled=b.bant_enabled,
                    bant_config=b.bant_config,
                    relevance_threshold=b.relevance_threshold,
                    avatar_type=b.avatar_type or "upload",
                    orb_color=b.orb_color,
                    lead_form_enabled=b.lead_form_enabled,
                    email_verification_enabled=bool(b.email_verification_enabled),
                    company_lookup_enabled=bool(b.company_lookup_enabled),
                    lead_form_fields=b.lead_form_fields,
                    notification_email=b.notification_email,
                    notification_emails=b.notification_emails,
                    reply_to_email=b.reply_to_email,
                    email_on_qualified=b.email_on_qualified,
                    email_on_handoff=b.email_on_handoff,
                    email_on_offline=b.email_on_offline,
                    email_visitor_confirmation=b.email_visitor_confirmation,
                    live_chat_enabled=b.live_chat_enabled,
                    widget_installed_at=b.widget_installed_at,
                    last_crawl_status=b.last_crawl_status,
                    crawl_completed_at=b.crawl_completed_at,
                    indexed_chunk_count=b.indexed_chunk_count or 0,
                    operator_timeout_seconds=b.operator_timeout_seconds,
                    live_chat_queue_timeout_seconds=b.live_chat_queue_timeout_seconds,
                    live_chat_max_queue_size=b.live_chat_max_queue_size,
                    business_hours=b.business_hours,
                    feature_flags=b.feature_flags or {},
                    widget_messages=b.widget_messages or {},
                    widget_config=b.widget_config or {},
                    branding_text=b.branding_text or "Powered by OyeChats",
                    branding_url=b.branding_url or "https://www.oyechats.com",
                    welcome_title=b.welcome_title or "Hi there 👋",
                    welcome_subtitle=b.welcome_subtitle or "How can we help you today?",
                    waiting_message=b.waiting_message or "Connecting you to support...",
                    offline_message=b.offline_message
                    or "We'll be right back! Leave a message and we'll follow up shortly.",
                    handoff_delay_seconds=b.handoff_delay_seconds or 0,
                    calendly_url=b.calendly_url,
                    meeting_booking_enabled=b.meeting_booking_enabled,
                    meeting_provider=b.meeting_provider,
                    zcal_url=b.zcal_url,
                    calcom_url=b.calcom_url,
                    allowed_domains=list(b.allowed_domains or []),
                    domain_check_enabled=bool(b.domain_check_enabled),
                    is_active=b.is_active,
                    created_at=b.created_at.isoformat() if b.created_at else "",
                )
            )
        return bots_response


@router.post("", status_code=201)
def create_bot(
    request: CreateBotRequest,
    http_request: Request,
    auth=Depends(get_current_client_or_operator),
    _sub=Depends(require_active_subscription_for_workspace),
    _verified=Depends(require_verified_email_for_workspace),
):
    """Create a new bot for the authenticated workspace.

    Subscription-gated: workspaces whose owner's trial has expired (or
    whose subscription is otherwise inactive) get a 403 with
    ``error: subscription_required``. The dashboard's read-only mode
    surfaces a "Reactivate to add a new bot" banner instead of letting
    the customer queue work they can't complete.
    """
    _require_bot_management_access(auth)
    with get_session() as session:
        # ── Per-bot billing gate ──
        # Free accounts get exactly one bot; every additional bot needs an
        # active paid subscription somewhere on the account so the per-bot
        # checkout has a funded counterpart. The decision is centralised
        # in :func:`plan_entitlements_service.can_client_add_new_bot` so
        # the frontend's ``/me/entitlements`` view and this route stay in
        # lockstep.
        from app.services.plan_entitlements_service import can_client_add_new_bot

        decision = can_client_add_new_bot(auth["client_id"], session)
        if not decision.allowed:
            # Idempotent onboarding create: a Build Studio double-submit (submit
            # #1 creates the bot, submit #2 arrives after and is now over the
            # free 1-bot cap) would otherwise surface a confusing "needs a paid
            # subscription" 402 during first run. If the workspace already has a
            # bot for the same site, treat this as a retry and return that bot.
            existing = _find_bot_by_website(session, auth["client_id"], request.website)
            if existing is not None:
                _plan = bot_plan(existing.id, session)
                return _bot_to_response(existing, http_request, plan_slug=_plan[0], plan_name=_plan[1])
            raise HTTPException(
                status_code=402,
                detail={
                    "error": decision.reason,
                    "metric": "bots",
                    "active_bot_count": decision.active_bot_count,
                    "must_subscribe": decision.must_subscribe,
                    "message": ("Each additional chatbot needs its own paid subscription. Upgrade to add another bot."),
                },
            )

        # Resolve the embed domain whitelist. If the customer supplied a list
        # we trust it (already normalized by the schema validator). Otherwise we
        # derive ``[apex, *.apex]`` from the website URL they entered during the
        # create flow so the widget is locked down by default for users who
        # never touch the advanced settings.
        if request.allowed_domains is not None:
            resolved_domains = request.allowed_domains
        else:
            resolved_domains = _derive_allowed_domains_from_website(request.website)

        # Secure-by-default: when the caller doesn't specify the flag we turn
        # origin enforcement ON. This is safe even when ``resolved_domains`` is
        # empty because ``_enforce_bot_origin`` fails open on an empty allowlist
        # -- the bot only gets locked down once its owner configures domains.
        resolved_check_enabled = True if request.domain_check_enabled is None else bool(request.domain_check_enabled)

        new_bot = Bot(
            client_id=auth["client_id"],
            bot_key=f"bot-{uuid.uuid4().hex[:12]}",
            name=request.name.strip() if request.name else "AI Assistant",
            website=request.website,
            system_prompt=request.system_prompt,
            bant_enabled=request.bant_enabled,
            allowed_domains=resolved_domains,
            domain_check_enabled=resolved_check_enabled,
        )
        session.add(new_bot)
        session.commit()
        session.refresh(new_bot)

        logger.info(f"Workspace {auth['client_id']} created bot {new_bot.id} ({new_bot.name})")

        # Drop a notification into the workspace feed so every operator
        # (and the owner) sees the new bot show up in the bell. Best-effort
        # — broadcast failures are swallowed inside the service.
        try:
            from app.services.notification_service import notify_bot_created

            notify_bot_created(
                session,
                client_id=auth["client_id"],
                bot_id=new_bot.id,
                bot_name=new_bot.name,
                bot_key=new_bot.bot_key,
            )
        except Exception:
            logger.exception("Failed to record bot_created notification for bot %s", new_bot.id)

        # Return the full bot object (same shape as GET /bots/{id}) so callers
        # don't need a second round-trip to resolve the created bot — the thin
        # {bot_id, bot_key} envelope is what forced the frontend to re-fetch and
        # select by id, the mistake behind the duplicate-bot onboarding bounce.
        _plan = bot_plan(new_bot.id, session)
        return _bot_to_response(new_bot, http_request, plan_slug=_plan[0], plan_name=_plan[1])


# ── Per-bot checkout ──────────────────────────────────────────────────────


class BotCheckoutRequest(BaseModel):
    """Body for ``POST /bots/checkout`` — start a per-bot subscription.

    The bot row is NOT created here. We pass the bot's name + website +
    domain settings in the Razorpay subscription notes so the activation
    webhook (or the sync verify endpoint) can materialise the bot only
    after payment captures. Dismissed checkouts leave no orphan rows.
    """

    name: str = Field(..., min_length=1, max_length=120)
    website: str | None = None
    plan_slug: str = Field(..., min_length=1, max_length=64)
    billing_cycle: str = Field(default="monthly", pattern="^(monthly|annual)$")
    allowed_domains: list[str] | None = None
    domain_check_enabled: bool | None = None

    @field_validator("allowed_domains")
    @classmethod
    def _validate_allowed_domains(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return _normalize_allowed_domains(value)


class BotCheckoutVerifyRequest(BaseModel):
    """Body for ``POST /bots/checkout/verify`` — sync fallback for localhost.

    Webhook delivery is the source of truth in production, but Razorpay
    can't hit ``localhost`` so the success callback hits this endpoint to
    trigger the activation handler synchronously. Idempotent: re-running
    on an already-active subscription is a no-op (the handler short-
    circuits when the local row already exists).
    """

    razorpay_payment_id: str
    razorpay_subscription_id: str
    razorpay_signature: str


@router.post("/checkout")
def create_bot_checkout(
    request: BotCheckoutRequest,
    auth=Depends(get_current_client_or_operator),
    _verified: None = Depends(require_verified_email_for_workspace),
):
    """Mint a Razorpay subscription for one new bot.

    Returns the Razorpay Checkout payload (``subscription_id``,
    ``key_id``, prefill). The frontend opens Razorpay; on success it
    calls ``POST /bots/checkout/verify`` (or the production webhook
    arrives first) to materialise the new Bot row.

    Free / first-bot creation does NOT go through this endpoint — that
    keeps using ``POST /bots`` directly. Use ``can_client_add_new_bot``
    to decide which path the frontend should take.
    """
    _require_bot_management_access(auth)
    with get_session() as session:
        from app.db.models import Client, Plan
        from app.services import razorpay_service

        plan = session.execute(select(Plan).where(Plan.slug == request.plan_slug)).scalars().first()
        if plan is None:
            raise HTTPException(status_code=404, detail=f"Plan '{request.plan_slug}' not found.")
        if plan.slug == "free":
            raise HTTPException(
                status_code=400,
                detail="Free plan cannot fund an additional bot. Pick a paid plan.",
            )

        client = session.get(Client, auth["client_id"])
        if client is None:
            raise HTTPException(status_code=404, detail="Account not found.")

        # Resolve the bot's domain whitelist now (deterministic — derived
        # the same way ``POST /bots`` does) so the webhook handler doesn't
        # have to repeat the logic.
        if request.allowed_domains is not None:
            resolved_domains = request.allowed_domains
        else:
            resolved_domains = _derive_allowed_domains_from_website(request.website)
        # Secure-by-default: enforcement ON when unspecified (fails open on an
        # empty allowlist, so this never bricks a bot without configured domains).
        resolved_check_enabled = True if request.domain_check_enabled is None else bool(request.domain_check_enabled)

        try:
            payload = razorpay_service.create_per_bot_subscription(
                session,
                client,
                plan,
                bot_name=request.name.strip(),
                bot_website=request.website,
                bot_allowed_domains=resolved_domains,
                bot_domain_check_enabled=resolved_check_enabled,
                billing_cycle=request.billing_cycle,
            )
        except razorpay_service.RazorpayBillingError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        session.commit()
        logger.info(
            "Per-bot Razorpay subscription started: client=%s plan=%s cycle=%s sub=%s",
            client.id,
            plan.slug,
            request.billing_cycle,
            payload.get("subscription_id"),
        )
        return payload


@router.post("/checkout/verify")
def verify_bot_checkout(body: BotCheckoutVerifyRequest, auth=Depends(get_current_client_or_operator)):
    """Verify the Razorpay success callback and materialise the new bot.

    Webhook delivery is the source of truth in production; this endpoint
    is the sync fallback so the customer doesn't have to wait for the
    webhook to land before seeing their new bot. Idempotent: if the
    subscription's activation webhook arrived first, the local row
    already exists and the handler short-circuits.
    """
    _require_bot_management_access(auth)
    from app.services import razorpay_service

    try:
        razorpay_service.verify_subscription_payment_signature(
            razorpay_payment_id=body.razorpay_payment_id,
            razorpay_subscription_id=body.razorpay_subscription_id,
            razorpay_signature=body.razorpay_signature,
        )
    except razorpay_service.SignatureMismatch as exc:
        raise HTTPException(status_code=400, detail="Signature verification failed.") from exc

    # Fetch the subscription from Razorpay so we can hand a synthetic
    # ``subscription.activated`` payload to the existing handler. This
    # keeps the per-bot bot-creation code path single-sourced.
    rzp = razorpay_service._get_razorpay()
    try:
        subscription_entity = rzp.subscription.fetch(body.razorpay_subscription_id)
    except Exception as exc:
        logger.exception(
            "Razorpay subscription.fetch failed during bot checkout verify (sub=%s)",
            body.razorpay_subscription_id,
        )
        raise HTTPException(status_code=502, detail="Could not verify subscription with Razorpay.") from exc

    notes = subscription_entity.get("notes") or {}
    if (notes.get("purpose") or "").lower() != "per_bot_subscription":
        raise HTTPException(status_code=400, detail="This subscription is not a per-bot checkout.")

    paid_client_id = razorpay_service._client_id_from_notes(notes)
    if not paid_client_id or paid_client_id != auth["client_id"]:
        raise HTTPException(status_code=403, detail="Subscription belongs to a different account.")

    # Razorpay's real webhook envelope nests entities under
    # ``payload.subscription.entity``, but ``_extract_subscription_entity``
    # already starts from the ``payload`` dict — so the synthetic shape we
    # pass to the handler must be ``{"subscription": {"entity": ...}}``,
    # NOT wrapped again in a ``"payload"`` key.
    synthetic_payload = {"subscription": {"entity": subscription_entity}}
    with get_session() as session:
        result = razorpay_service._handle_subscription_activated(session, synthetic_payload)
        session.commit()

        # Look up the now-attached bot so the frontend can navigate to it
        # without a second list-bots round-trip.
        from app.db.models import Subscription as _Sub

        sub = (
            session.execute(select(_Sub).where(_Sub.razorpay_subscription_id == body.razorpay_subscription_id))
            .scalars()
            .first()
        )
        bot_id = sub.bot_id if sub else None

    return {"status": "activated", "detail": result, "bot_id": bot_id}


@router.post("/{bot_id}/demo-share-click")
def track_demo_share_click(bot_id: int, auth=Depends(get_current_client_or_operator)):
    """Record that an authenticated workspace user copied a bot demo link."""
    _require_bot_management_access(auth)
    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])
        _record_growth_event(session, bot.id, "demo_share_clicked")
        session.commit()
        return {"success": True, "event_type": "demo_share_clicked"}


@router.get("/{bot_id}/framework-presets")
def get_framework_presets(bot_id: int, auth=Depends(get_current_client_or_operator)):
    with get_session() as session:
        _get_workspace_bot(session, bot_id, auth["client_id"])
        from app.services.qualification_service import get_preset_frameworks

        return get_preset_frameworks()


# ── Brand tone: presets catalog, on-demand detect, and voice preview ──
# NOTE: the presets route is a LITERAL path and MUST be declared before the
# ``/{bot_id}`` route below — otherwise FastAPI matches it against the int path
# param and 422s. Route registration order (module top-to-bottom) wins.


@router.get("/brand-tone-presets")
def list_brand_tone_presets(auth=Depends(get_current_client_or_operator)):
    """Return the curated brand-tone preset catalog for the AI & Personality tab."""
    return {"presets": BRAND_TONE_PRESETS}


class BrandTonePreviewRequest(BaseModel):
    brand_tone: str = Field(..., min_length=1, max_length=500)


@router.post("/{bot_id}/brand-tone/detect")
@limiter.limit("10/minute")
def detect_brand_tone(bot_id: int, request: Request, auth=Depends(get_current_client_or_operator)):
    """Re-classify the bot's tone from its already-crawled content (no re-crawl).

    Writes the detected preset's canonical text + key and *unlocks* ``brand_tone``
    (an explicit "make it auto" request), so future crawls keep it fresh until the
    customer edits again.
    """
    from app.db.repository import get_content_sample_for_bot
    from app.services.llm_service import classify_brand_tone

    _require_bot_management_access(auth)
    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])
        sample = get_content_sample_for_bot(session, bot_id=bot.id)
        if not sample.strip():
            raise HTTPException(status_code=400, detail="Train on your website first to detect its tone.")

        # Bound the interactive wait: the user is watching a spinner, so cap the
        # LLM budget (~20s × 1 retry) instead of the default ~180s worst case
        # that could pin a Gunicorn worker thread under concurrent onboarders.
        key = classify_brand_tone(sample, timeout=20, num_retries=1)
        if key is None:
            raise HTTPException(status_code=422, detail="Couldn't detect a tone; pick one manually.")

        bot.brand_tone = preset_text(key)
        bot.brand_tone_preset = key
        # Unlock brand_tone so the value stays auto (see _reconcile_manual_overrides).
        overrides = [f for f in (bot.manual_field_overrides or []) if f != "brand_tone"]
        bot.manual_field_overrides = overrides

        session.commit()
        cache_delete(bot_config_key(bot.bot_key))
        return {"brand_tone": bot.brand_tone, "brand_tone_preset": key}


@router.post("/{bot_id}/seed-questions")
@limiter.limit("10/minute")
def get_seed_questions(
    bot_id: int,
    request: Request,
    force: bool = Query(default=False),
    auth=Depends(get_current_client_or_operator),
    _verified=Depends(require_verified_email_for_workspace),
):
    """Onboarding "seed questions" for the Build Studio Prove step.

    LLM-proposed from the bot's auto-extracted company context, then each is
    verified answerable by the same retrieval the live bot uses (see
    ``seed_questions_service``). Cached on the bot after the first computation;
    pass ``force=true`` to recompute. Returns ``{"questions": [...]}`` (0-3). An
    empty list is a normal outcome ("show only the open input"), never an error.
    Verified-email gated like the other resource endpoints.
    """
    from app.db.repository import count_documents_for_bot
    from app.services.seed_questions_service import build_seed_questions

    _require_bot_management_access(auth)
    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])
        if bot.seed_questions is not None and not force:
            return {"questions": bot.seed_questions}
        questions = build_seed_questions(session, bot)
        # Only cache an authoritative result. An empty list computed *before* any
        # content is indexed (crawl still running) must not be persisted as `[]`
        # — because the cache check is `is not None`, that empty list becomes a
        # permanent hit and the bot shows no sample questions forever. Leave
        # `seed_questions` null in that case so the next call recomputes once
        # ingestion has produced chunks.
        if questions or count_documents_for_bot(session, bot_id=bot.id, client_id=bot.client_id) > 0:
            bot.seed_questions = questions
            session.commit()
        return {"questions": questions}


@router.post("/{bot_id}/brand-tone/preview")
@limiter.limit("15/minute")
def preview_brand_tone(
    bot_id: int,
    body: BrandTonePreviewRequest,
    request: Request,
    auth=Depends(get_current_client_or_operator),
):
    """Generate a 1-2 sentence sample bot reply in the given (unsaved) tone."""
    from app.services.llm_service import generate_tone_sample

    _require_bot_management_access(auth)
    with get_session() as session:
        # Ownership check only — preview never reads or writes tone from the DB.
        _get_workspace_bot(session, bot_id, auth["client_id"])

    sample = generate_tone_sample(body.brand_tone, "Can you tell me about your services?")
    if not sample:
        raise HTTPException(status_code=503, detail="Preview unavailable, please try again.")
    return {"sample": sample}


@router.get("/{bot_id}")
def get_bot(bot_id: int, request: Request, auth=Depends(get_current_client_or_operator)):
    """Get details of a specific bot owned by the authenticated workspace."""
    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])
        _plan = bot_plan(bot.id, session)
        return _bot_to_response(bot, request, plan_slug=_plan[0], plan_name=_plan[1])


# Auto-fillable fields the website crawl may populate. Edits to these are
# tracked in ``Bot.manual_field_overrides`` so a re-crawl leaves a hand-edited
# value alone while still refreshing untouched ones.
_AUTO_FILL_FIELDS = ("company_name", "company_description", "brand_tone")


def _reconcile_manual_overrides(bot: Bot, update_data: dict) -> None:
    """Update ``bot.manual_field_overrides`` from an incoming settings patch.

    Must run BEFORE the patch values are written onto ``bot`` (it compares the
    submitted value against the currently stored one). For each auto-fillable
    field present in the patch:
      * changed to a non-empty value -> lock   (crawl won't overwrite it)
      * cleared to empty/None        -> unlock (crawl re-fills on next crawl)
      * unchanged                    -> leave the flag untouched
    Fields absent from the patch are left as-is.
    """
    overrides = set(bot.manual_field_overrides or [])
    original = set(overrides)
    for field in _AUTO_FILL_FIELDS:
        if field not in update_data:
            continue
        incoming = (update_data.get(field) or "").strip()
        stored = (getattr(bot, field) or "").strip()
        if incoming == stored:
            continue
        if incoming:
            overrides.add(field)
        else:
            overrides.discard(field)
    if overrides != original:
        bot.manual_field_overrides = sorted(overrides)


@router.patch("/{bot_id}")
@impersonation_writable
def update_bot(bot_id: int, request: UpdateBotRequest, auth=Depends(get_current_client_or_operator)):
    """Update settings for a specific bot.

    Writable under a super-admin impersonation session (design §6.1, "AI Agent
    config edits") — this is the single endpoint behind name, greeting, tone and
    appearance/branding, which is the most common "it looks wrong" support
    report. Nothing here touches billing, credits, or credentials — but
    ``UpdateBotRequest`` is broader than the §6.1 wording: it also carries the
    widget's origin allowlist (a security control) and the Account's
    notification/reply-to addresses, so those specific fields are rejected for
    an impersonated caller below rather than granted wholesale.
    """
    try:
        _require_bot_management_access(auth)
        with get_session() as session:
            bot = _get_workspace_bot(session, bot_id, auth["client_id"])

            update_data = request.dict(exclude_unset=True)
            logger.info(f"Updating bot {bot_id} | fields: {list(update_data.keys())}")

            # Impersonation field guard. The route-level marker admits the whole
            # request body, but a support session editing "it looks wrong"
            # config must not be able to widen the widget origin allowlist
            # (``allowed_domains`` / ``domain_check_enabled`` /
            # ``session_share_domain`` — persistent changes that outlive the
            # 30-minute token and re-scope where the public bot_key is
            # embeddable) or redirect the customer's lead emails.
            if getattr(auth["entity"], "_impersonator_id", None) is not None:
                blocked = sorted(
                    {
                        "allowed_domains",
                        "domain_check_enabled",
                        "session_share_domain",
                        "notification_email",
                        "reply_to_email",
                        # The two metered-enrichment toggles. A customer turns
                        # these off specifically so credits stop being spent;
                        # a support session opened to "fix" something that
                        # looks wrong must not be able to switch spending back
                        # on, leaving only a field name in a log line as the
                        # trace. The set was originally scoped to security
                        # controls and lead-email redirection — "don't spend
                        # my money" belongs in the same category.
                        "email_verification_enabled",
                        "company_lookup_enabled",
                    }
                    & update_data.keys()
                )
                if blocked:
                    logger.warning(
                        "Impersonated write to bot %s rejected: security-sensitive fields %s (impersonator client %s).",
                        bot_id,
                        blocked,
                        auth["entity"]._impersonator_id,
                    )
                    raise HTTPException(
                        status_code=403,
                        detail={
                            "error": "impersonation_read_only",
                            "message": (
                                "These settings can't be changed during a super-admin "
                                f"impersonation session: {', '.join(blocked)}."
                            ),
                        },
                    )

            # Sync logos
            if "bot_logo" in update_data:
                update_data["launcher_logo"] = update_data["bot_logo"]
            elif "launcher_logo" in update_data:
                update_data["bot_logo"] = update_data["launcher_logo"]

            # Merge feature_flags — partial updates must not wipe existing flags
            if "feature_flags" in update_data and update_data["feature_flags"] is not None:
                current_flags = dict(bot.feature_flags or {})
                current_flags.update(update_data.pop("feature_flags"))
                bot.feature_flags = current_flags

            # Merge widget_messages — partial updates must not wipe existing messages
            if "widget_messages" in update_data and update_data["widget_messages"] is not None:
                current_messages = dict(bot.widget_messages or {})
                current_messages.update(update_data.pop("widget_messages"))
                bot.widget_messages = current_messages

            # Merge widget_config — partial updates must not wipe existing config
            if "widget_config" in update_data and update_data["widget_config"] is not None:
                current_config = dict(bot.widget_config or {})
                current_config.update(update_data.pop("widget_config"))
                bot.widget_config = current_config

            # Framework selection is stored under bant_config.framework for backward compatibility
            selected_framework = update_data.pop("qualification_framework", None)
            if selected_framework is not None:
                merged_bant_config = dict(bot.bant_config or {})
                merged_bant_config["framework"] = selected_framework
                bot.bant_config = merged_bant_config

            if "bant_config" in update_data and update_data["bant_config"] is not None:
                # The qualification editor always sends the COMPLETE authoritative
                # config, so store it wholesale. A shallow merge would resurrect
                # dimensions the user removed or renamed — orphan dimension dicts
                # linger at the top level and ``_dimension_keys`` re-scores them,
                # silently corrupting every session's composite score. Replacing
                # is the only way a removal actually takes effect. Reads fall back
                # to the framework preset (``get_framework_config`` deep-merges the
                # preset under the stored config), so a config that omits a key is
                # still complete at scoring time.
                incoming_bant = dict(update_data["bant_config"])
                # Preserve the framework applied just above if the payload omits it
                # (e.g. a combined framework-switch + config save).
                if "framework" not in incoming_bant:
                    existing_framework = (bot.bant_config or {}).get("framework")
                    if existing_framework:
                        incoming_bant["framework"] = existing_framework
                bot.bant_config = incoming_bant
                update_data.pop("bant_config")

            # Normalize services to ``[{name, url}]`` regardless of whether the
            # admin app sends old strings or new objects. Filters out blank
            # rows so the prompt never sees empty service names.
            if "services" in update_data:
                update_data["services"] = _normalize_services(update_data["services"])

            # Lock/unlock crawl auto-fill based on what the customer submitted.
            # Runs before the setattr loop so it can diff against stored values.
            _reconcile_manual_overrides(bot, update_data)

            for key, value in update_data.items():
                setattr(bot, key, value)

            session.commit()
            # Invalidate cached bot config so widget picks up changes immediately
            cache_delete(bot_config_key(bot.bot_key))
            logger.info(f"Bot {bot_id} settings saved successfully by workspace {auth['client_id']}")
            return {"message": "Bot settings updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update bot {bot_id}: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to save bot settings.") from e


# ── Auto-recrawl (Standard + Professional plans) ────────────────────────────
#
# Two endpoints back the KnowledgeBase → Auto-Recrawl card:
#
# * ``GET  /bots/{bot_id}/recrawl``   — current toggle state, last-run
#                                       summary, next-run timestamp, and a
#                                       ``feature_available`` boolean the UI
#                                       uses to decide between the live card
#                                       and the upsell.
# * ``PATCH /bots/{bot_id}/recrawl``  — toggle on/off. Enforces the plan
#                                       gate; toggle-on stamps
#                                       ``next_recrawl_at = now + 7d``,
#                                       toggle-off clears the schedule
#                                       (history fields preserved).


class RecrawlStatusResponse(BaseModel):
    enabled: bool
    cadence_days: int
    feature_available: bool
    current_plan: str
    next_recrawl_at: str | None
    last_recrawl_at: str | None
    last_recrawl_status: str | None
    last_recrawl_summary: dict | None
    sources_count: int
    # Rolling window (newest first) of past auto-recrawl runs. Each entry:
    # ``{"ran_at": str, "status": str, "total": int, "unchanged": int,
    # "changed": int, "failed": int}``. Bounded server-side to 20 entries
    # so the payload stays small regardless of run count.
    recrawl_history: list[dict]


class RecrawlUpdateRequest(BaseModel):
    enabled: bool


def _load_recrawl_context(bot_id: int, client_id: int):
    """Shared read: bot row, entitlements, and crawled-source count.

    Kept as a helper so every recrawl route enforces the same tenant
    isolation (``bot.client_id == client_id``) and the same feature check
    path. Returns a ``(bot, entitlements, sources_count)`` tuple; raises
    404 if the bot isn't in the workspace.
    """
    from sqlalchemy import func as sa_func

    from app.db.models import Document
    from app.services.plan_entitlements_service import get_entitlements

    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, client_id)
        entitlements = get_entitlements(client_id, session)
        sources_count = int(
            session.execute(
                select(sa_func.count(sa_func.distinct(Document.document_name))).where(
                    Document.bot_id == bot_id,
                    Document.source == "crawl",
                )
            ).scalar_one()
            or 0
        )
        return bot, entitlements, sources_count


def _serialize_recrawl_status(bot: Bot, entitlements, sources_count: int) -> RecrawlStatusResponse:
    """Build the response payload the admin card renders."""
    from app.services.recrawl_service import RECRAWL_CADENCE_DAYS

    return RecrawlStatusResponse(
        enabled=bool(bot.recrawl_enabled),
        cadence_days=RECRAWL_CADENCE_DAYS,
        feature_available=entitlements.has_feature("auto_recrawl"),
        current_plan=entitlements.plan_slug,
        next_recrawl_at=bot.next_recrawl_at.isoformat() if bot.next_recrawl_at else None,
        last_recrawl_at=bot.last_recrawl_at.isoformat() if bot.last_recrawl_at else None,
        last_recrawl_status=bot.last_recrawl_status,
        last_recrawl_summary=bot.last_recrawl_summary,
        sources_count=sources_count,
        recrawl_history=list(bot.recrawl_history or []),
    )


@router.get("/{bot_id}/recrawl", response_model=RecrawlStatusResponse)
def get_recrawl_status(bot_id: int, auth=Depends(get_current_client_or_operator)):
    """Return the current auto-recrawl state + last-run summary for a bot."""
    bot, entitlements, sources_count = _load_recrawl_context(bot_id, auth["client_id"])
    return _serialize_recrawl_status(bot, entitlements, sources_count)


@router.patch("/{bot_id}/recrawl", response_model=RecrawlStatusResponse)
def update_recrawl(
    bot_id: int,
    request: RecrawlUpdateRequest,
    auth=Depends(get_current_client_or_operator),
):
    """Toggle auto-recrawl on or off for a bot.

    Enabling requires the ``auto_recrawl`` feature flag on the client's
    plan — Free / Starter plans get a structured 403 the admin UI catches
    and routes to the upgrade flow. Disabling always succeeds so a
    customer can turn the feature off even after a plan downgrade left
    them without the entitlement.
    """
    _require_bot_management_access(auth)

    from app.services.plan_entitlements_service import get_entitlements
    from app.services.recrawl_service import compute_next_recrawl_at

    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])
        entitlements = get_entitlements(auth["client_id"], session)

        if request.enabled and not entitlements.has_feature("auto_recrawl"):
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "feature_locked",
                    "feature": "auto_recrawl",
                    "current_plan": entitlements.plan_slug,
                    "message": ("Auto-recrawl is available on Standard and Professional plans. Upgrade to enable it."),
                    "upgrade_url": "/billing",
                },
            )

        now = datetime.now(UTC)
        if request.enabled:
            bot.recrawl_enabled = True
            # Fresh 7-day countdown from the moment the toggle flips on.
            # Toggling off then on again resets this — that's the product
            # behavior the customer sees on the card.
            bot.next_recrawl_at = compute_next_recrawl_at(now)
        else:
            bot.recrawl_enabled = False
            bot.next_recrawl_at = None
            # ``last_recrawl_*`` fields are intentionally preserved so the
            # card's history section keeps showing "Last checked: Jul 3"
            # even after the customer disables the feature.

        session.commit()
        logger.info(
            "Bot %s auto-recrawl set to %s by workspace %s",
            bot_id,
            "enabled" if request.enabled else "disabled",
            auth["client_id"],
        )

    _, entitlements, sources_count = _load_recrawl_context(bot_id, auth["client_id"])
    # Re-load the fresh bot so the response reflects the committed row.
    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])
        return _serialize_recrawl_status(bot, entitlements, sources_count)


@router.delete("/{bot_id}")
def delete_bot(bot_id: int, auth=Depends(get_current_client_or_operator)):
    """Delete a bot and all its data (documents, sessions, messages).

    When the bot has its own per-bot subscription, cancel that
    subscription first (both with Razorpay and locally). Two reasons:

    1. **Stop the bill.** Leaving the subscription active after the bot
       is gone would keep charging the customer for nothing.
    2. **Side-step the partial unique index.** ``subscriptions.bot_id``
       is ``ON DELETE SET NULL``, so deleting the bot would otherwise
       null the FK on an ``active`` subscription — which collides with
       ``ix_subscriptions_client_legacy_active`` (only one client-level
       active sub per client). Marking the sub ``canceled`` first takes
       it out of that index's predicate before the row is touched.

    The legacy / Free bot path (no ``subscription_id``) skips this and
    just deletes the bot as before.
    """
    _require_bot_management_access(auth)
    with get_session() as session:
        from app.db.models import Subscription

        bot = _get_workspace_bot(session, bot_id, auth["client_id"])
        bot_key_val = bot.bot_key
        # ``getattr`` defensively — test mocks use SimpleNamespace and
        # may not populate per-bot-billing columns.
        sub_id = getattr(bot, "subscription_id", None)

        if sub_id is not None:
            sub = session.get(Subscription, sub_id)
            # Only cancel a sub that's actually funding THIS bot. Legacy
            # / pooled bots have a copy of the client-level subscription
            # id stamped on them (Phase 2 backfill) but the sub itself
            # has ``bot_id IS NULL`` — cancelling that would kill the
            # customer's account-level subscription too.
            if sub is not None and sub.bot_id == bot.id and sub.status in ("active", "trialing", "past_due"):
                # Best-effort cancel in Razorpay so we stop the renewal.
                # Local row is marked canceled regardless — even if the
                # provider call fails, we don't want to leave a stranded
                # active subscription pointing at a bot we just deleted.
                if sub.payment_provider == "razorpay" and sub.razorpay_subscription_id:
                    try:
                        from app.services import razorpay_service

                        razorpay_service.cancel_subscription(sub, at_period_end=False)
                    except Exception:
                        logger.exception(
                            "Razorpay cancel failed for sub %s during bot %s delete — proceeding with local cancel",
                            sub.id,
                            bot.id,
                        )
                sub.status = "canceled"
                sub.canceled_at = datetime.now(UTC)
                sub.bot_id = None  # release the (client, bot) unique-index slot
                session.flush()

        session.delete(bot)
        session.commit()
        cache_delete(bot_config_key(bot_key_val))
        logger.info(f"Bot {bot_id} deleted by workspace {auth['client_id']}")
        return {"message": "Bot deleted successfully"}
