import html
import ipaddress
import logging
import re
import socket
import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
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
from app.db.repository import stamp_manual_avatar
from app.db.session import get_session
from app.schemas.validators import (
    MAX_URL,
    BotKey,
    BoundedJsonObject,
    EmailAddress,
    GatewayRef,
    GatewaySignature,
    HexColor,
    HttpUrlStr,
    MediumText,
    Name,
    RequiredName,
    ShortText,
    bounded_json_object,
    bounded_list,
)
from app.services.brand_tone import BRAND_TONE_PRESETS, CUSTOM_PRESET, is_valid_preset_value, preset_text
from app.services.language_service import is_multilingual_enabled

# Upper bound on per-bot domain list size. 50 covers every realistic case
# (apex + wildcard + a handful of staging/sandbox subdomains) while preventing
# an accidental or malicious unbounded write.
_MAX_ALLOWED_DOMAINS = 50

# Recipients per notification bucket. Generous for a support inbox list, small
# enough that a save can never fan a single event out to a mailing campaign.
_MAX_NOTIFICATION_RECIPIENTS = 20

# 24-hour ``HH:MM``. Anchored so "09:00 OR 1=1" is not a valid start time.
_HHMM_PATTERN = r"^(?:[01]\d|2[0-3]):[0-5]\d$"

# Ceilings for the list-valued agent config. Each is well above what the
# admin UI can produce and well below what would bloat the system prompt.
_MAX_SERVICES = 50
_MAX_ANSWER_LINKS = 50
_MAX_LEAD_FORM_FIELDS = 10

# ``bant_config`` holds a full qualification rubric (four-plus dimensions,
# each with prompts and scored options), so it gets a larger budget than the
# generic object ceiling, but a budget nonetheless. Its strings are
# interpolated into the LLM system prompt on every turn.
_MAX_BANT_CONFIG_BYTES = 128 * 1024

# The customer's own website. Free-form on purpose. ``normalize_domain_input``
# accepts a bare apex ("acme.com") as readily as a full URL, and the signup
# form has always let people type either, so this bounds length and bans
# control characters without imposing a scheme the UI never asked for.
WebsiteRef = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=253 + 16, pattern=r"^[\x20-\x7E]+$"),
]

# An avatar reference is EITHER an absolute http(s) URL (R2/CDN object, or a
# favicon derived during a crawl) OR a stored object key served back through
# ``/files/{key}``. ``client_routes`` branches on ``startswith("http")`` to
# tell them apart. Both forms are accepted; anything carrying another scheme
# is not, because the value is rendered as an ``<img src>`` in the widget on
# the customer's page and in the admin dashboard.
#
# Stored keys carry a prefix ("logos/abc.png"), so the key form is a bounded
# sequence of safe segments. Relative, no traversal, no empty segments.
_LOGO_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,127}$")
_MAX_LOGO_KEY_SEGMENTS = 6


def _validate_logo_ref(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("Logo reference must not be empty.")
    if len(value) > MAX_URL:
        raise ValueError(f"Logo reference must be {MAX_URL} characters or fewer.")
    if value.lower().startswith(("http://", "https://")):
        parsed = urlparse(value)
        if not parsed.hostname:
            raise ValueError("Logo URL must contain a valid hostname.")
        return value
    segments = value.split("/")
    if 1 <= len(segments) <= _MAX_LOGO_KEY_SEGMENTS and all(_LOGO_SEGMENT_RE.match(seg) for seg in segments):
        # ``..`` cannot match the segment pattern (it must start alphanumeric),
        # and a leading/trailing slash yields an empty segment that also fails.
        return value
    raise ValueError("Logo must be an http(s) URL or a stored object key.")


LogoRef = Annotated[str, AfterValidator(_validate_logo_ref)]


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
        raise ValueError("session_share_domain cannot be a wildcard. Use the parent domain, e.g. example.com")
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
    served by the API itself, a widget embedded there reports the API host as
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


def _normalize_answer_links(raw) -> list[dict]:
    """Coerce a stored or incoming smart-links value to ``[{keyword, url}]``.

    Every entry needs both a non-empty ``keyword`` and a valid ``http(s)`` URL,
    a smart link with no destination is meaningless, so blank/invalid rows are
    dropped rather than persisted. ``javascript:`` and other non-http schemes are
    rejected here (the widget's ``SafeLink`` also refuses them, this is
    defence-in-depth). Keyword and URL are length-capped and the list is capped
    so a runaway payload can't bloat the prompt. Returns a fresh list every call.
    """
    if not raw:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        keyword = (item.get("keyword") or "").strip()
        url = item.get("url")
        url = url.strip() if isinstance(url, str) else ""
        if not keyword or not url:
            continue
        if not (url.startswith("http://") or url.startswith("https://")):
            continue
        # De-dupe on the case-folded keyword so the prompt never lists the same
        # trigger twice with conflicting destinations (first write wins).
        key = keyword.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append({"keyword": keyword[:80], "url": url[:2048]})
        if len(out) >= 50:
            break
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


# The badge's stock copy. A bot row that still holds these values has never
# been customised, so a PATCH resending them is a no-op and must not trip the
# add-on guard: the Experience page saves its whole draft, unchanged fields
# included.
DEFAULT_BRANDING_TEXT = "Powered by OyeChats"
DEFAULT_BRANDING_URL = "https://www.oyechats.com"


def _branding_fields_requiring_addon(bot: Bot, update_data: dict) -> list[str]:
    """Which fields in this PATCH need the branding-removal add-on.

    Three writes are gated, and only when they actually change something:

    * ``feature_flags.show_branding`` set to False. Turning the badge back ON
      is always allowed, including after the add-on lapses, so a customer is
      never stuck holding a setting they can no longer switch off.
    * ``branding_text`` / ``branding_url`` moved off the stock values. These
      re-label and re-target the badge, which is the same paid capability
      wearing a different hat.

    Returns the offending field names (dotted for the nested flag) for the
    error payload, or an empty list when the PATCH touches nothing gated.
    """
    offending: list[str] = []

    flags = update_data.get("feature_flags")
    if isinstance(flags, dict) and flags.get("show_branding") is False:
        offending.append("feature_flags.show_branding")

    for field, default in (
        ("branding_text", DEFAULT_BRANDING_TEXT),
        ("branding_url", DEFAULT_BRANDING_URL),
    ):
        if field not in update_data:
            continue
        incoming = update_data[field]
        if incoming is None:
            continue  # Clearing back to the default is a downgrade, always allowed.
        if str(incoming) != str(getattr(bot, field, None) or default):
            offending.append(field)

    return offending


def _bot_has_branding_addon(session, bot_id: int) -> bool:
    """True iff the subscription funding this bot holds the branding add-on.

    Denies on any resolver error, matching ``plan_entitlements_service``'s
    deny-by-default policy: a transient failure must never let an unpaid write
    through, and the customer can retry.
    """
    from app.services import plan_entitlements_service

    try:
        return plan_entitlements_service.get_bot_entitlements(bot_id, session).has_feature("branding_removable")
    except Exception:
        logger.warning("branding add-on check failed for bot=%s. Denying", bot_id, exc_info=True)
        return False


def _record_growth_event(session, bot_id: int, event_type: str) -> None:
    if event_type not in DEMO_EVENT_TYPES:
        raise ValueError(f"Unsupported growth event type: {event_type}")
    session.add(BotGrowthEvent(bot_id=bot_id, event_type=event_type))


# ── Request / Response Models ──


class NotificationEmailRouting(BaseModel):
    """Per-event notification recipients (``bot.notification_emails``).

    Previously a bare ``dict``: whatever the caller sent was written to JSONB
    and later handed to the transactional email provider as a recipient list.
    An unvalidated address there is not a cosmetic problem, it is who the
    customer's lead notifications get delivered to. Each bucket is now an
    allow-listed key holding validated, de-duplicated addresses.
    """

    model_config = ConfigDict(extra="forbid")

    # Keys are the ``event_type`` values ``email_service.get_notification_recipients``
    # is called with, and nothing else. ``extra="forbid"`` is what makes that
    # true: a bucket named for an event that is never looked up would save
    # cleanly and route no mail, which reads to the customer as lost alerts.
    default: Annotated[list[EmailAddress], bounded_list(_MAX_NOTIFICATION_RECIPIENTS)] = []
    qualified_lead: Annotated[list[EmailAddress], bounded_list(_MAX_NOTIFICATION_RECIPIENTS)] = []
    handoff_request: Annotated[list[EmailAddress], bounded_list(_MAX_NOTIFICATION_RECIPIENTS)] = []
    offline_message: Annotated[list[EmailAddress], bounded_list(_MAX_NOTIFICATION_RECIPIENTS)] = []


class DayHours(BaseModel):
    """One day's open window, ``{"start": "09:00", "end": "17:00"}``.

    A day is marked closed by setting the whole day to ``null``, which is what
    ``live_chat_availability_service._within_business_hours`` reads. No
    ``closed`` flag is accepted here on purpose: a field the evaluator does
    not consult would store fine and change nothing, which is worse than
    rejecting it.
    """

    model_config = ConfigDict(extra="forbid")

    start: str = Field(..., pattern=_HHMM_PATTERN)
    end: str = Field(..., pattern=_HHMM_PATTERN)


class BusinessHours(BaseModel):
    """Weekly schedule keyed by three-letter day, plus an optional IANA zone.

    ``extra="forbid"`` matters here specifically: the availability service
    looks days up by these exact keys, so a payload with ``"monday"`` instead
    of ``"mon"`` used to be stored intact and then silently ignored at
    runtime, the customer's agent stayed offline all Monday with a schedule
    on screen that said otherwise. Now it is a 422 at save time.
    """

    model_config = ConfigDict(extra="forbid")

    mon: DayHours | None = None
    tue: DayHours | None = None
    wed: DayHours | None = None
    thu: DayHours | None = None
    fri: DayHours | None = None
    sat: DayHours | None = None
    sun: DayHours | None = None
    timezone: str | None = Field(default=None, max_length=64)

    @field_validator("timezone")
    @classmethod
    def _known_timezone(cls, v: str | None) -> str | None:
        """Reject a zone ``zoneinfo`` cannot load.

        The evaluator catches the lookup failure and fails OPEN, the agent
        reports itself available around the clock. A typo in this field is
        therefore a silent availability change, so it is caught at write time
        instead.
        """
        if v is None:
            return None
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"'{v}' is not a known IANA timezone.") from exc
        return v


class LeadFormField(BaseModel):
    """One row of the configurable pre-chat lead form.

    Exactly the shape both clients produce and consume, the admin app writes
    ``{field, required}`` and the widget's ``LeadCaptureForm`` renders those
    four field names. Anything else was previously stored and then dropped on
    read, so it is rejected here instead.
    """

    model_config = ConfigDict(extra="forbid")

    field: Literal["name", "email", "phone", "company"]
    required: bool = False


class ServiceEntry(BaseModel):
    """``{"name": ..., "url": ...}``, a service the agent can talk about."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=200)
    url: HttpUrlStr | None = None


class AnswerLink(BaseModel):
    """A smart link: keyword trigger → destination."""

    model_config = ConfigDict(extra="forbid")

    keyword: str = Field(..., min_length=1, max_length=80)
    url: HttpUrlStr


class CreateBotRequest(BaseModel):
    name: RequiredName = "AI Assistant"
    website: WebsiteRef | None = None
    # Same ceiling ``UpdateBotRequest`` uses, and the same one
    # ``rag_service._MAX_CUSTOM_PROMPT_CHARS`` enforces at generation time. It
    # was absent here, so a prompt could be created larger than it could ever
    # be edited to.
    system_prompt: str | None = Field(None, max_length=2000)
    bant_enabled: bool = True
    # Optional override of the auto-derived domain list. When omitted the route
    # derives ``[apex, *.apex]`` from ``website`` and turns the check on.
    allowed_domains: Annotated[list[str], bounded_list(_MAX_ALLOWED_DOMAINS)] | None = None
    domain_check_enabled: bool | None = None

    @field_validator("allowed_domains")
    @classmethod
    def _validate_allowed_domains(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return _normalize_allowed_domains(value)


class UpdateBotRequest(BaseModel):
    name: RequiredName | None = None
    # max_length matches _MAX_CUSTOM_PROMPT_CHARS in rag_service. Enforced at API boundary
    system_prompt: str | None = Field(None, max_length=2000)
    brand_tone: str | None = Field(None, max_length=500)
    # A preset key, "custom", or None, the active chip in the AI & Personality tab.
    brand_tone_preset: str | None = Field(None, max_length=64)
    company_name: str | None = Field(None, max_length=100)
    company_description: str | None = Field(None, max_length=1000)
    website: WebsiteRef | None = None
    bot_logo: LogoRef | None = None
    launcher_name: Name | None = None
    launcher_logo: LogoRef | None = None
    # Written straight into the widget's inline styles on the customer's own
    # site. Constrained to hex so the value is a colour and nothing else.
    # Every default this platform ships and every value its colour picker
    # emits is already in this form.
    primary_color: HexColor | None = None
    background_color: HexColor | None = None
    header_color: HexColor | None = None
    user_bubble_color: HexColor | None = None
    bant_enabled: bool | None = None
    # A full qualification rubric. Stored wholesale (see the handler) and its
    # strings are interpolated into the LLM system prompt every turn, so it is
    # size- and depth-bounded even though its inner keys are product-defined.
    bant_config: Annotated[dict, bounded_json_object(max_bytes=_MAX_BANT_CONFIG_BYTES, max_depth=8)] | None = None
    qualification_framework: Literal["bant", "meddic"] | None = None
    # CRAG relevance gate threshold override. None = use env default (0.55).
    # 0.0 = always pass (effectively disable), 1.0 = always fail (refuse everything).
    # Reasonable range 0.40 (lenient). 0.70 (strict). Out-of-range writes are
    # rejected at the API; runtime ALSO clamps in case a bad value slipped past.
    relevance_threshold: float | None = Field(None, ge=0.0, le=1.0)
    # The three styles the admin preview and ``BotAvatar`` actually render.
    # A fourth value would store fine and fall through to the "upload" branch
    # everywhere, so it is refused rather than silently reinterpreted.
    avatar_type: Literal["upload", "orb", "mascot"] | None = None
    orb_color: HexColor | None = None
    # Lead form settings
    lead_form_enabled: bool | None = None
    lead_form_fields: Annotated[list[LeadFormField], bounded_list(_MAX_LEAD_FORM_FIELDS)] | None = None
    # Email notification settings. Both are recipient addresses for the
    # customer's own lead notifications. Validated, not merely bounded,
    # because an unparseable address here means a lead alert silently goes
    # nowhere.
    notification_email: EmailAddress | None = None
    notification_emails: NotificationEmailRouting | None = None
    reply_to_email: EmailAddress | None = None
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
    operator_timeout_seconds: int | None = Field(None, ge=5, le=3600)
    live_chat_queue_timeout_seconds: int | None = Field(None, ge=5, le=600)
    live_chat_max_queue_size: int | None = Field(None, ge=1, le=100)
    # Business hours
    business_hours: BusinessHours | None = None
    # Feature flags / widget copy / widget tuning. These three are genuinely
    # open-ended maps. Their keys are product config, not API contract, and
    # the PATCH handler shallow-merges each into what is stored. Open-ended is
    # not unbounded: each is held to the default object budget (64 KB, 6
    # levels, 200 keys) so a JSONB column cannot be used as free storage.
    feature_flags: BoundedJsonObject | None = None
    language_config: BoundedJsonObject | None = None
    widget_messages: BoundedJsonObject | None = None
    widget_config: BoundedJsonObject | None = None
    # Branding customization
    branding_text: Name | None = None
    branding_url: HttpUrlStr | None = None
    # Configurable visitor-facing messages
    welcome_title: Name | None = None
    welcome_subtitle: ShortText | None = None
    waiting_message: ShortText | None = None
    offline_message: MediumText | None = None
    handoff_delay_seconds: int | None = Field(None, ge=0, le=3600)
    calendly_url: str | None = None
    meeting_booking_enabled: bool | None = None
    meeting_provider: str | None = Field(None, pattern="^(calendly|zcal|calcom)$")
    zcal_url: str | None = None
    calcom_url: str | None = None
    # Each service is ``{name: str, url: str | None}``. Strings are accepted
    # for backward compat with the v1 list[str] shape and normalized to
    # ``{"name": str, "url": None}`` in the route handler.
    services: Annotated[list[ServiceEntry | str], bounded_list(_MAX_SERVICES)] | None = None
    services_url: str | None = Field(None, max_length=MAX_URL)  # Legacy global URL, no longer used by prompt.
    # Smart links. Each entry is ``{keyword, url}``. ``_normalize_answer_links``
    # in the handler still de-dupes and drops blanks; the model now rejects a
    # malformed entry outright rather than letting the normalizer discard it,
    # so a typo'd URL is a visible 422 instead of a link that never appears.
    answer_links: Annotated[list[AnswerLink], bounded_list(_MAX_ANSWER_LINKS)] | None = None
    # Widget embed origin restriction.
    allowed_domains: Annotated[list[str], bounded_list(_MAX_ALLOWED_DOMAINS)] | None = None
    domain_check_enabled: bool | None = None
    # Cross-subdomain session continuity. Empty string clears it (disables
    # sharing); a bare/registrable domain enables it.
    session_share_domain: str | None = Field(None, max_length=253)

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
    # Who set the avatar: null (nobody has), "manual" (the customer) or
    # "derived" (taken from the site's favicon during a crawl). Lets the avatar
    # picker caption a derived image rather than pass it off as an upload.
    bot_logo_source: str | None = None
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
    # values today, so this is only a fallback, but a fallback pointing the
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
    # Durable per-bot ingestion ("trained") state, a persistent fact the UI can
    # read instead of racing the ephemeral /crawl/progress toast.
    last_crawl_status: str | None = None
    crawl_completed_at: datetime | None = None
    indexed_chunk_count: int = 0
    operator_timeout_seconds: int = 120
    live_chat_queue_timeout_seconds: int = 20
    live_chat_max_queue_size: int = 10
    business_hours: dict | None = None
    feature_flags: dict = {}
    language_config: dict = {}
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
    # Smart links, always returned as ``[{keyword, url}]`` objects.
    answer_links: list[dict] | None = None
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
    # entirely (they have no per-bot ledger), so a Free agent silently
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
        logger.warning("bot_plan: entitlements lookup failed for bot %s. Defaulting to Free", bot_id)
        return "free", "Free"

    # Type-checked, not just truthy: a non-string here (a stub, a bad row) would
    # sail through `or "free"` and reach the response as a value the frontend's
    # slug comparison can never match, an agent locked out of everything it
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
        bot_logo_source=bot.bot_logo_source,
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
        language_config=bot.language_config or {},
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
        answer_links=_normalize_answer_links(bot.answer_links),
        allowed_domains=list(bot.allowed_domains or []),
        domain_check_enabled=bool(bot.domain_check_enabled),
        session_share_domain=bot.session_share_domain,
        is_active=bot.is_active,
        created_at=bot.created_at.isoformat() if bot.created_at else "",
    )


def _find_bot_by_website(session, client_id: int, website: str | None) -> Bot | None:
    """Return an existing workspace bot whose website resolves to the same apex
    host as ``website``, or ``None`` if there is no match.

    Used to make onboarding bot-creation idempotent: a retried/duplicate create
    for the same site (the Build Studio double-submit) returns the bot that was
    already created, instead of either tripping the free 1-bot cap with a
    confusing 402 or (on any path the cap allows) silently writing a second
    row for the same website.

    Matching is on the normalized apex host, not the stored string, so the
    ``https://`` the frontend prepends and a bare host entered by hand resolve
    to the same site. That is also why no database constraint can stand in for
    this check.
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


def _effective_language_config(bot) -> dict:
    """The bot's language config as the WIDGET should see it right now.

    Identical to the stored value except when the platform-wide
    ``feature.multilingual_chat_enabled`` switch is off, in which case
    ``enabled`` (and, with it, ``operator_translation_enabled``) is reported as
    false. The stored configuration is never mutated: flipping the switch back
    on restores exactly what the customer configured.
    """
    cfg = dict(bot.language_config or {})
    if not cfg.get("enabled", False):
        return cfg
    if is_multilingual_enabled(bot):
        return cfg
    cfg["enabled"] = False
    cfg["operator_translation_enabled"] = False
    return cfg


@router.get("/settings/public")
def get_bot_settings_public(request: Request, bot: Bot = Depends(get_current_bot)):
    """
    Public endpoint for the widget to fetch bot settings.
    Authenticated via X-Bot-Key or X-API-Key (backward compat).

    Includes the bot owner's subscription health so the widget can choose
    to suppress the launcher (or render an offline indicator) when the
    workspace is not serving. ``is_offline=True`` means visitors who do
    open the widget will only get the configured ``offline_message``,
    the chat endpoint will not run RAG.
    """
    # One-time "widget is live" detection. The first time the widget bootstraps
    # from a real external site (not our dashboard preview / demo / localhost),
    # stamp the bot so the Dashboard setup checklist can confirm the install
    # without a user self-report. Best-effort and idempotent, the guarded
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
    # a button that (when clicked) routes them to a queue with no possible
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
        # Fail closed. If we can't resolve the plan, hide live chat AND
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
        # No authorized branding add-on → force show_branding=True. Branding
        # removal is sold only as a standalone add-on, so a stored
        # show_branding=False is always stale here: left over from before the
        # add-on model, or from a mandate that has since been cancelled.
        # ``update_bot`` now rejects the write outright, but this stays as the
        # boundary that governs what the widget actually renders.
        effective_feature_flags["show_branding"] = True

    # Mirror the show_branding lock: a subscription without the branding add-on
    # must also not be able to re-label or re-target the badge by PATCHing the
    # fields directly. The admin UI hides these inputs without the add-on, but
    # the API is the real boundary.
    effective_branding_text = bot.branding_text or "Powered by OyeChats"
    effective_branding_url = bot.branding_url or "https://www.oyechats.com"
    if not _plan_branding_removable:
        effective_branding_text = "Powered by OyeChats"
        effective_branding_url = "https://www.oyechats.com"

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
        # Plan half of the human-support gate: does this bot's plan include the
        # live_chat feature at all (live chat AND its offline/leave-message
        # fallback are entitled together)? The widget needs this SEPARATELY from
        # ``live_chat_enabled`` (the effective real-time value) to tell two cases
        # apart that both report ``live_chat_enabled=false``:
        #   - Free plan          → support_enabled=False → no human channel:
        #                          suppress the leave-message menu, the fallback
        #                          auto-handoff, and the prominent live-chat pulse.
        #   - paid, toggle off   → support_enabled=True  → offline-only: the
        #                          leave-message affordances stay.
        "support_enabled": plan_includes_live_chat,
        "business_hours": bot.business_hours,
        "feature_flags": effective_feature_flags,
        # Reported as DISABLED when the platform switch is off, not merely
        # ignored server-side. The widget decides from this whether to resolve a
        # locale and whether to offer the language selector at all, so leaving
        # `enabled: true` here would show visitors a selector whose choice the
        # pipeline then discards.
        "language_config": _effective_language_config(bot),
        "widget_messages": bot.widget_messages or {},
        "widget_config": bot.widget_config or {},
        "branding_text": effective_branding_text,
        "branding_url": effective_branding_url,
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
        # Smart-link destinations (URLs only) so the widget can recognise which
        # answer links are admin-configured smart links and apply the
        # "don't re-link a smart link the visitor already clicked" behaviour.
        # Keywords are intentionally omitted, the widget matches on URL alone.
        "smart_link_urls": [link["url"] for link in _normalize_answer_links(bot.answer_links)],
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
    ``framework``, a MEDDIC/CHAMP/GPCTBA+C&I bot's CTA-enabled dimensions
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
    import httpx  # local import. Only used in this preview path

    # Re-validate here (defence in depth) and. Crucially. Do NOT follow
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
            # A redirect (http→https, apex→www. Near-universal): we intentionally
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
        # Network error, timeout, DNS failure. Let the iframe try
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
    from the parent frame. Typically the admin dashboard editor).
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
     * Scope resets to preview-shell only, never touch #oyechats-widget-root
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
       * 2. On iframe load: try to read contentWindow.length, an error
       *    page served by the browser after X-Frame-Options block
       *    typically has 0 sub-frames AND we can still read `length`
       *    (it's cross-origin accessible).  We combine this with a
       *    same-origin document check for blank/empty pages.
       * 3. Hard timeout as last-resort.
       */

      frame.addEventListener('load', function() {{
        try {{
          // Same-origin check. Works when our server serves the error
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
    # Unauthenticated route. ``bot_key`` is the public embed key
    # (``bot-<hex>``) used verbatim in a DB lookup; ``url`` is fed to
    # ``_validate_preview_url``, which performs DNS resolution, so both are
    # bounded before either does any work.
    bot_key: BotKey,
    url: str | None = Query(default=None, max_length=MAX_URL),
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
            # Site blocks framing. Fall through to the hero demo page
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
    * **Client / workspace owner (own workspace, no operator hat)**. Every
      bot in the workspace.
    * **Operator (X-Operator-Key or linked-operator via X-Workspace-Id)**,
      the single bot they're bound to (one-to-one operator↔bot binding).
    * **Owner acting as their own self-operator**, the auth resolver classifies
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
            # Self-operator path. Owner added themselves as an operator in
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
                    language_config=b.language_config or {},
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


def _plan_bots_limit_allows(client_id: int, session, active_bot_count: int) -> bool:
    """Does this client's plan fund another AI agent without a new subscription?

    Consumer of ``limits.bots``, the plan's **included agent quota**, which is
    what every plan row has always declared and nothing has ever read.

    Read ``PlanEntitlements.limit_for`` before changing this: ``bots`` is the
    quota a single subscription includes, NOT an account-wide ceiling. Under the
    per-bot billing model an account legitimately holds more agents than this
    number by funding each extra one with its own subscription
    (``POST /bots/checkout``). So this predicate can only ever *widen* the
    default rule, never tighten it. See the call site in :func:`create_bot`.

    * Free / Starter / Standard / Professional declare ``bots: 1``, the
      caller has already been denied at ≥1 active agent, so this returns False
      and the existing per-bot-subscription 402 stands. Behaviour is unchanged.
    * Enterprise declares ``bots: -1`` (UNLIMITED). This returns True and the
      agency gets unlimited agents pooled under its single subscription, which
      is the tier's entire headline differentiator.

    ``within_limit`` handles the ``UNLIMITED`` sentinel, so the -1 comparison is
    never hand-rolled here.

    Fails CLOSED: any entitlements-resolution error returns False, which falls
    back to the pre-existing 402 upgrade path rather than granting a free agent.
    That matches the deny-by-default policy in ``plan_entitlements_service``.
    """
    from app.services.plan_entitlements_service import get_entitlements

    try:
        entitlements = get_entitlements(client_id, session, include_usage=False)
    except Exception:
        logger.warning(
            "bots_limit_gate: entitlements lookup failed for client=%s. Falling back to the paid-bot gate",
            client_id,
            exc_info=True,
        )
        return False
    if "bots" not in entitlements.limits:
        # A bespoke contract plan that loses its unlimited-agents term degrades
        # to ``limit_for``'s conservative 0, so this predicate stops widening
        # and the account is quietly pushed through per-bot checkout with no
        # other trace. Log it so support can tell "plan data lost a term" apart
        # from "customer is on the wrong plan" without reading the JSONB by hand.
        logger.info(
            "bots_limit_gate: plan '%s' declares no 'bots' quota for client=%s. "
            "treating it as 0 (no widening); check the plan's limits JSON",
            entitlements.plan_slug,
            client_id,
        )
    return entitlements.within_limit("bots", active_bot_count)


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
        # ── Idempotent onboarding create (runs BEFORE the billing gate) ──
        # A Build Studio double-submit sends the same payload twice: submit #1
        # creates the agent, submit #2 arrives behind it. If the workspace
        # already has an agent for the same site, that is a retry, not a second
        # agent. Return the one that exists.
        #
        # This deliberately does NOT live inside the 402 branch below. Only the
        # *denied* path used to reach it, so the two paths the gate ALLOWS,
        # an account with zero agents (its very first submit, the case this
        # exists for) and a plan whose quota widens the gate (``bots: -1``).
        # Created a duplicate row on the retry with nothing to catch it: the
        # ``Bot`` model has no unique constraint on ``(client_id, website)``,
        # and could not usefully have one, because ``website`` is stored raw
        # and ``https://x.com`` / ``x.com`` are the same site to
        # ``normalize_domain_input`` and different strings to Postgres.
        #
        # Consequence worth stating: one agent per website per account is now
        # the rule on every path, not just the capped one. Agents created
        # without a website are unaffected (the lookup answers ``None``), which
        # is the escape hatch for deliberately running two agents on one site.
        # Two genuinely simultaneous requests can still both miss this read.
        # That race is unchanged and needs row-level locking, not a reordering.
        existing = _find_bot_by_website(session, auth["client_id"], request.website)
        if existing is not None:
            existing_plan = bot_plan(existing.id, session)
            return _bot_to_response(existing, http_request, plan_slug=existing_plan[0], plan_name=existing_plan[1])

        # ── Per-bot billing gate, widened by the plan's agent quota ──
        # Default rule: an account gets exactly one bot here, and every
        # additional bot needs its own paid subscription via
        # ``POST /bots/checkout`` so the new agent has a funded counterpart.
        # That default lives in
        # :func:`plan_entitlements_service.can_client_add_new_bot`, whose only
        # caller is this route. It is NOT a shared source of truth with
        # ``/me/entitlements``: that endpoint ships ``limits`` + ``usage`` and
        # never surfaces this decision, so nothing on the frontend consumes the
        # service's answer and the two cannot be "in lockstep". Read alone the
        # service is in fact WRONG about what happens here, on an
        # unlimited-agents plan it answers ``must_subscribe`` while this route
        # returns 201, because the full rule is the service's default AND the
        # widening below. Any surface needing the real answer has to reproduce
        # both clauses; ``app/src/features/agents/agentLimit.ts`` is the
        # frontend mirror that does, off ``limits.bots`` + ``usage.bots``. Fold
        # the widening into the service the day the decision gets an endpoint
        # of its own. Until then it would centralise nothing.
        #
        # ``_plan_bots_limit_allows`` is the override: a plan whose
        # ``limits.bots`` quota still covers the account's current agent count
        # funds this agent already, so it must not be pushed through checkout.
        # Only Enterprise (``bots: -1``) takes that branch today, the other
        # four plans declare ``bots: 1`` and behave exactly as before.
        # Ordering matters: the quota check runs only AFTER the default gate
        # denies, so it can never block a create the default gate would allow
        # (a bespoke plan row missing the ``bots`` key resolves to a limit of 0
        # under ``limit_for``'s conservative default, which would otherwise
        # refuse that account its very first agent).
        from app.services.plan_entitlements_service import can_client_add_new_bot

        decision = can_client_add_new_bot(auth["client_id"], session)
        if not decision.allowed and not _plan_bots_limit_allows(auth["client_id"], session, decision.active_bot_count):
            # Reached only for a genuinely NEW site, the same-site retry above
            # has already returned. The frontend paywall keys on this exact
            # body (``apiErrors.requiresSubscription`` → ``CreateAgentDialog``'s
            # pricing step), so the shape is a contract.
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
        # . Broadcast failures are swallowed inside the service.
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
        # don't need a second round-trip to resolve the created bot, the thin
        # {bot_id, bot_key} envelope is what forced the frontend to re-fetch and
        # select by id, the mistake behind the duplicate-bot onboarding bounce.
        _plan = bot_plan(new_bot.id, session)
        return _bot_to_response(new_bot, http_request, plan_slug=_plan[0], plan_name=_plan[1])


# ── Per-bot checkout ──────────────────────────────────────────────────────


class BotCheckoutRequest(BaseModel):
    """Body for ``POST /bots/checkout``. Start a per-bot subscription.

    The bot row is NOT created here. We pass the bot's name + website +
    domain settings in the Razorpay subscription notes so the activation
    webhook (or the sync verify endpoint) can materialise the bot only
    after payment captures. Dismissed checkouts leave no orphan rows.
    """

    name: str = Field(..., min_length=1, max_length=120)
    website: WebsiteRef | None = None
    plan_slug: str = Field(..., min_length=1, max_length=64, pattern=r"^[a-z0-9_\-]+$")
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
    """Body for ``POST /bots/checkout/verify``. Sync fallback for localhost.

    Webhook delivery is the source of truth in production, but Razorpay
    can't hit ``localhost`` so the success callback hits this endpoint to
    trigger the activation handler synchronously. Idempotent: re-running
    on an already-active subscription is a no-op (the handler short-
    circuits when the local row already exists).
    """

    # Gateway-issued opaque handles, echoed back by the browser after
    # checkout. Bounded before they reach the signature comparison and the
    # gateway lookup; ``pay_``/``sub_`` ids are ~20 chars and the HMAC is 64
    # hex characters.
    razorpay_payment_id: GatewayRef
    razorpay_subscription_id: GatewayRef
    razorpay_signature: GatewaySignature


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

    Free / first-bot creation does NOT go through this endpoint. That
    keeps using ``POST /bots`` directly. Use ``can_client_add_new_bot``
    to decide which path the frontend should take.
    """
    _require_bot_management_access(auth)
    with get_session() as session:
        from app.db.models import Client, Plan
        from app.services import pending_checkout_service, plan_entitlements_service, razorpay_service
        from app.services.plan_service import lock_client_for_billing

        # Serialize this client's billing mutations for the whole read → decide
        # → mint → write sequence (H1). The marker below is a read-then-write
        # check, so without the lock two concurrent submits both read "nothing
        # in flight" and both mint a chargeable mandate, which is the bug, not
        # a smaller version of it. Held to COMMIT, so the loser reads the
        # winner's COMMITTED marker and reuses it.
        lock_client_for_billing(session, auth["client_id"])

        # ``is_active`` is part of the lookup, not a second check: ``delete_plan``
        # soft-deletes by clearing the flag, and a super admin deactivates a tier
        # to withdraw it from sale. Without the predicate a withdrawn plan stays
        # purchasable by slug through a direct API call, the plan list hides it
        # but this route would still mint a subscription on it. Matches
        # ``/subscriptions/checkout`` and ``/subscriptions/change-plan``, which
        # both gate on the flag. Deliberately 404 (not 400): a withdrawn plan is
        # indistinguishable from one that never existed, so callers can't probe
        # for retired tiers.
        plan = (
            session.execute(select(Plan).where(Plan.slug == request.plan_slug, Plan.is_active.is_(True)))
            .scalars()
            .first()
        )
        if plan is None:
            raise HTTPException(status_code=404, detail=f"Plan '{request.plan_slug}' not found.")
        if plan.slug == "free":
            raise HTTPException(
                status_code=400,
                detail="Free plan cannot fund an additional bot. Pick a paid plan.",
            )
        # An unlimited-agent plan is incoherent as a PER-BOT subscription and
        # must be bought at the account level instead.
        #
        # This endpoint mints a subscription scoped to the one bot the
        # activation webhook materialises (``subscription.bot_id`` is stamped
        # with it), which routes that bot to its own isolated credit ledger
        # (``credit_service.resolve_bot_ledger_bot_id``). A plan promising
        # unlimited agents on ONE pooled credit balance therefore self-destructs
        # here: its monthly credits are granted and reset into a single bot's
        # isolated ledger, while every further agent the plan entitles carries
        # no subscription of its own and drains the shared client pool, which
        # that purchase never funded. The agency ends up with one working agent
        # and N silent ones.
        # ``POST /subscriptions/checkout`` creates the same plan's subscription
        # with ``bot_id = NULL``, i.e. against the shared pool, which is what
        # the tier actually sells.
        if plan_entitlements_service.plan_grants_unlimited_bots(plan):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"The {plan.name} plan includes unlimited AI agents and is billed for the whole "
                    "account, not per agent. Subscribe to it from Billing (account checkout) instead."
                ),
            )

        client = session.get(Client, auth["client_id"])
        if client is None:
            raise HTTPException(status_code=404, detail="Account not found.")

        # Resolve the bot's domain whitelist now (deterministic. Derived
        # the same way ``POST /bots`` does) so the webhook handler doesn't
        # have to repeat the logic.
        if request.allowed_domains is not None:
            resolved_domains = request.allowed_domains
        else:
            resolved_domains = _derive_allowed_domains_from_website(request.website)
        # Secure-by-default: enforcement ON when unspecified (fails open on an
        # empty allowlist, so this never bricks a bot without configured domains).
        resolved_check_enabled = True if request.domain_check_enabled is None else bool(request.domain_check_enabled)

        # A re-submit must reuse the in-flight mandate, never mint a sibling
        # beside it. Two authorised mandates both charge a full cycle: prod
        # client 19 paid ₹11,998 for one month, client 8 got two mandates 44
        # seconds apart and 20,000 credits instead of 10,000. Those were the
        # ACCOUNT-level routes; this one is the same defect on the upsell path
        # every paid tier below Enterprise uses to buy an extra agent (an
        # unlimited-agents plan is refused above and never arrives here, which
        # is why live Enterprise testing could not surface it).
        #
        # Same mechanism as ``/subscriptions/checkout`` and ``/change-plan``
        # Branch 3. ``clients.pending_checkout_*`` via
        # ``pending_checkout_service``, with the two differences this path
        # forces, both explained on ``reuse_or_supersede``: the agent does not
        # exist yet, so its identity is compared from the gateway notes rather
        # than from ``pending_checkout_bot_id``, and a failed supersede-cancel
        # is logged rather than fatal.
        #
        # Recording the marker also closes the leak half: until now an
        # abandoned per-agent checkout was tracked nowhere, so nothing could
        # ever supersede or cancel it and it stayed authorizable at Razorpay
        # indefinitely.
        billing_country = client.billing_country or "IN"
        required_notes = razorpay_service.per_bot_checkout_identity(
            bot_name=request.name.strip(),
            bot_website=request.website,
            bot_allowed_domains=resolved_domains,
            bot_domain_check_enabled=resolved_check_enabled,
        )
        try:
            reused = pending_checkout_service.reuse_or_supersede(
                session,
                client_row=client,
                client=client,
                plan=plan,
                billing_cycle=request.billing_cycle,
                country=billing_country,
                bot_id=pending_checkout_service.NEW_BOT_SCOPE,
                required_notes=required_notes,
                cancel_failure_is_fatal=False,
            )
        except razorpay_service.RazorpayBillingError as exc:
            # Never guess: a fetch failure is not evidence the pending mandate
            # is dead, and minting beside a live authorizable one is the exact
            # double-charge this guard exists to prevent.
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        if reused is not None:
            session.commit()
            logger.info(
                "Per-bot checkout retried: client=%s plan=%s cycle=%s reusing sub=%s",
                client.id,
                plan.slug,
                request.billing_cycle,
                reused.get("subscription_id"),
            )
            return reused

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

        # Remember the mandate just minted so the next retry reuses it. Cleared
        # by ``_handle_subscription_activated`` once the customer authorises.
        pending_checkout_service.record(
            client,
            subscription_id=payload.get("subscription_id"),
            plan_id=plan.id,
            billing_cycle=request.billing_cycle,
            country=billing_country,
            bot_id=pending_checkout_service.NEW_BOT_SCOPE,
        )
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
    # already starts from the ``payload`` dict, so the synthetic shape we
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
# ``/{bot_id}`` route below. Otherwise FastAPI matches it against the int path
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
        # . Because the cache check is `is not None`, that empty list becomes a
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
        # Ownership check only. Preview never reads or writes tone from the DB.
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
    config edits"). This is the single endpoint behind name, greeting, tone and
    appearance/branding, which is the most common "it looks wrong" support
    report. Nothing here touches billing, credits, or credentials, but
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
            # ``session_share_domain``. Persistent changes that outlive the
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
                        # controls and lead-email redirection. "don't spend
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

            # Branding-removal add-on guard. Hiding or re-labelling the
            # "Powered by OyeChats" badge is a paid add-on, not a plan
            # inclusion. ``GET /settings/public`` already forces the badge back
            # on for an unentitled bot, but accepting the write anyway left the
            # row asserting something the customer had not bought, which every
            # other reader of ``Bot`` (the dashboard, the bot list, the embed
            # snippet) would surface as if it were true. Reject at the door
            # instead, so the stored state and the entitlement agree.
            _branding_writes = _branding_fields_requiring_addon(bot, update_data)
            if _branding_writes and not _bot_has_branding_addon(session, bot.id):
                logger.warning(
                    "Bot %s branding write rejected, no branding add-on: %s",
                    bot_id,
                    _branding_writes,
                )
                raise HTTPException(
                    status_code=403,
                    detail={
                        "error": "branding_addon_required",
                        "message": (
                            "Removing or customising the 'Powered by OyeChats' badge "
                            "requires the branding removal add-on."
                        ),
                        "fields": _branding_writes,
                    },
                )

            # Sync logos
            if "bot_logo" in update_data:
                update_data["launcher_logo"] = update_data["bot_logo"]
            elif "launcher_logo" in update_data:
                update_data["bot_logo"] = update_data["launcher_logo"]

            # Any avatar write here is the customer's, including clearing it,
            # which is what stops the crawl re-deriving a deleted avatar.
            stamp_manual_avatar(bot, update_data)

            # Merge feature_flags. Partial updates must not wipe existing flags
            if "feature_flags" in update_data and update_data["feature_flags"] is not None:
                current_flags = dict(bot.feature_flags or {})
                current_flags.update(update_data.pop("feature_flags"))
                bot.feature_flags = current_flags

            # Merge language_config. Partial updates must not wipe existing language config
            if "language_config" in update_data and update_data["language_config"] is not None:
                current_lang = dict(bot.language_config or {})
                current_lang.update(update_data.pop("language_config"))
                # Operator translation (Phase 4) depends on the multilingual
                # feature being on: the session language it translates to and
                # from is written only by the language resolver, which returns
                # early when ``enabled`` is false. Validate the MERGED result,
                # not the request body, because this is a partial update: a
                # call sending only ``{"enabled": false}`` would otherwise
                # leave a stale ``operator_translation_enabled: true`` behind
                # and produce a bot that thinks translation is on with no
                # language to translate.
                if current_lang.get("operator_translation_enabled") and not current_lang.get("enabled"):
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            "operator_translation_enabled requires language_config.enabled to be true. "
                            "Enable multilingual for this bot first."
                        ),
                    )
                bot.language_config = current_lang

            # Merge widget_messages. Partial updates must not wipe existing messages
            if "widget_messages" in update_data and update_data["widget_messages"] is not None:
                current_messages = dict(bot.widget_messages or {})
                current_messages.update(update_data.pop("widget_messages"))
                bot.widget_messages = current_messages

            # Merge widget_config. Partial updates must not wipe existing config
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
                # dimensions the user removed or renamed. Orphan dimension dicts
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

            # Smart links follow the same discipline as services: normalize the
            # incoming rows (drop blank/invalid, de-dupe, cap) before persisting
            # so the prompt only ever sees well-formed keyword→URL pairs.
            if "answer_links" in update_data:
                update_data["answer_links"] = _normalize_answer_links(update_data["answer_links"])

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
# * ``GET  /bots/{bot_id}/recrawl``  . Current toggle state, last-run
#                                       summary, next-run timestamp, and a
#                                       ``feature_available`` boolean the UI
#                                       uses to decide between the live card
#                                       and the upsell.
# * ``PATCH /bots/{bot_id}/recrawl`` . Toggle on/off. Enforces the plan
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
    plan. Free / Starter plans get a structured 403 the admin UI catches
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
            # Toggling off then on again resets this. That's the product
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
       null the FK on an ``active`` subscription, which collides with
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
        # ``getattr`` defensively. Test mocks use SimpleNamespace and
        # may not populate per-bot-billing columns.
        sub_id = getattr(bot, "subscription_id", None)

        if sub_id is not None:
            sub = session.get(Subscription, sub_id)
            # Only cancel a sub that's actually funding THIS bot. Legacy
            # / pooled bots have a copy of the client-level subscription
            # id stamped on them (Phase 2 backfill) but the sub itself
            # has ``bot_id IS NULL``. Cancelling that would kill the
            # customer's account-level subscription too.
            if sub is not None and sub.bot_id == bot.id and sub.status in ("active", "trialing", "past_due"):
                # Best-effort cancel in Razorpay so we stop the renewal.
                # Local row is marked canceled regardless, even if the
                # provider call fails, we don't want to leave a stranded
                # active subscription pointing at a bot we just deleted.
                if sub.payment_provider == "razorpay" and sub.razorpay_subscription_id:
                    try:
                        from app.services import razorpay_service

                        razorpay_service.cancel_subscription(sub, at_period_end=False)
                    except Exception:
                        logger.exception(
                            "Razorpay cancel failed for sub %s during bot %s delete. Proceeding with local cancel",
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
