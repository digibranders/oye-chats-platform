import asyncio
import hashlib
import html as html_lib
import ipaddress
import json
import logging
import re
import time
import urllib.request
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel as PydanticBaseModel
from pydantic import Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.api.auth import (
    bot_subscription_status,
    get_bot_for_chat,
    get_current_bot,
    get_current_client_or_operator,
    impersonation_writable,
)
from app.core.chat_concurrency import chat_gate
from app.core.exceptions import SessionOwnershipError
from app.core.langfuse_client import get_langfuse
from app.core.rate_limit import consume_vendor_budget, key_from_bot_key, limiter
from app.core.thread_pool import submit_background
from app.core.visitor_privacy import format_visitor_location
from app.db.models import Bot, ChatSession
from app.db.repository import (
    create_or_update_lead_info,
    ensure_chat_session,
    get_lead_info_by_session,
    update_chat_session_language,
    update_message_feedback,
)
from app.db.session import get_session
from app.schemas.chat import (
    ChangeLanguageRequest,
    ChangeLanguageResponse,
    ChatRequest,
    FeedbackRequest,
)
from app.schemas.language import LanguageContext
from app.schemas.validators import (
    MAX_EMAIL,
    CountValue,
    DurationSeconds,
    EmailAddress,
    HttpUrlStr,
    Identifier,
    Name,
    Phone,
    RowId,
    SessionId,
    UtmParams,
    bounded_list,
)
from app.services.ip_intel_service import fetch_ip_intel
from app.services.language_service import (
    detect_message_language_detail,
    detection_is_trusted,
    get_locale_direction,
    is_multilingual_enabled,
    language_from_locale,
    match_supported_locale,
    normalize_locale,
    resolve_initial_locale,
)
from app.services.plan_entitlements_service import (
    is_email_validation_enabled_for_bot,
    is_visitor_intelligence_enabled_for_bot,
)
from app.services.rag_service import rag_pipeline, rag_pipeline_stream

_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")
_SAFE_URL_SCHEME = re.compile(r"^https?://", re.IGNORECASE)


def _sanitize_url(url: str | None, max_len: int = 2000) -> str | None:
    """Return a truncated URL only if it uses http(s), else None."""
    if not url:
        return None
    url = url.strip()[:max_len]
    return url if _SAFE_URL_SCHEME.match(url) else None


# Caps for widget-supplied visitor_journey payloads. The array reaches the
# database as JSONB and is rendered as a timeline in the admin UI. Bounding
# both entry count and per-field length keeps row size predictable on
# high-navigation sites (SPA with hundreds of history.pushState calls) and
# blocks obvious injection (long strings, unexpected schemes).
#
# The cap is 200 (raised from the original 50) because the array now spans
# pre-chat + during-chat + post-chat browsing on a persistent same-visitor
# session, not just "before opening chat". Trim strategy in _merge_journey
# drops oldest pre-phase entries first so chat/post markers are preserved.
_MAX_JOURNEY_ENTRIES = 200
_MAX_JOURNEY_PATH_LEN = 500
_MAX_JOURNEY_TS_LEN = 40

# Whitelisted phase and event tags for journey entries. Anything outside
# these sets is dropped by _sanitize_journey, never trust widget input.
_JOURNEY_PHASES = frozenset({"pre", "chat", "post"})
_JOURNEY_EVENTS = frozenset(
    {
        "chat_opened",
        "chat_closed",
        "handoff_requested",
        "meeting_booked",
        "offline_message_sent",
        "lead_captured",
    }
)


def _sanitize_journey(entries: list | None) -> list[dict] | None:
    """Normalize the widget's ``journey`` array into a bounded list of dicts.

     Accepts the widget's payload. ``[{"path": "/services", "ts":
     "2026-07-09T12:00:15Z", "phase": "pre", "event": "chat_opened"}, ...]``
    , and drops anything malformed rather than raising. ``phase`` and
     ``event`` are optional; each is dropped if not in the whitelist.
     Preserves order (matters for the timeline UI). Returns ``None`` when
     the input is empty or every entry was rejected.
    """
    if not entries:
        return None
    cleaned: list[dict] = []
    for raw in entries[:_MAX_JOURNEY_ENTRIES]:
        if not isinstance(raw, dict):
            continue
        path = raw.get("path")
        if not isinstance(path, str):
            continue
        path = path.strip()[:_MAX_JOURNEY_PATH_LEN]
        if not path:
            continue
        entry: dict = {"path": path}
        ts = raw.get("ts")
        if isinstance(ts, str):
            ts_clean = ts.strip()[:_MAX_JOURNEY_TS_LEN]
            if ts_clean:
                entry["ts"] = ts_clean
        phase = raw.get("phase")
        if isinstance(phase, str) and phase in _JOURNEY_PHASES:
            entry["phase"] = phase
        event = raw.get("event")
        if isinstance(event, str) and event in _JOURNEY_EVENTS:
            entry["event"] = event
        cleaned.append(entry)
    return cleaned or None


def _entry_key(entry: dict) -> tuple:
    """Identity tuple used to dedupe entries across widget resends.

    ``ts`` is stable per entry (widget stamps it once when the entry is
    created), so ``(path, phase, event, ts)`` is a natural dedup key even
    when the same journey is POSTed multiple times.
    """
    return (
        entry.get("path"),
        entry.get("phase"),
        entry.get("event"),
        entry.get("ts"),
    )


def _trim_journey(entries: list[dict], max_len: int = _MAX_JOURNEY_ENTRIES) -> list[dict]:
    """Trim a journey to ``max_len`` entries, preferring to drop pre-phase
    entries from the head first so ``chat`` and ``post`` markers survive.
    Falls back to a pure head trim if pre-phase alone can't get us under
    the cap.
    """
    if len(entries) <= max_len:
        return entries
    over = len(entries) - max_len
    result: list[dict] = []
    dropped = 0
    for entry in entries:
        if dropped < over and entry.get("phase") == "pre":
            dropped += 1
            continue
        result.append(entry)
    if len(result) > max_len:
        result = result[-max_len:]
    return result


def _merge_journey(existing: list[dict] | None, incoming: list[dict] | None) -> list[dict] | None:
    """Merge an incoming journey payload with what's already stored.

    The widget sends the full current journey on every update (not a
    delta), so ``incoming`` is usually a superset of ``existing``. We
    still union defensively. If the widget lost its localStorage
    (private tab, storage cleared, cross-device return) it may send a
    shorter payload that we must not let overwrite our history. Entries
    are deduped by ``_entry_key``; incoming order is preserved for new
    entries so timeline chronology stays intact.
    """
    if not incoming:
        return existing or None
    if not existing:
        return _trim_journey(list(incoming)) or None
    seen = {_entry_key(e) for e in existing}
    merged = list(existing)
    for entry in incoming:
        key = _entry_key(entry)
        if key in seen:
            continue
        seen.add(key)
        merged.append(entry)
    return _trim_journey(merged) or None


def _redact_email(email: str | None) -> str:
    """Return a partially redacted email for safe logging (GDPR)."""
    if not email or "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    return f"{local[0]}***@{domain}"


def _resolve_session_id(provided: str | None, bot_id: int) -> str:
    """Return a validated session_id.

    If the caller supplies one, verify it belongs to this bot before trusting it.
    A session belonging to a different bot gets a fresh server-generated UUID so
    callers cannot hijack another bot's conversation.
    """
    if not provided:
        return str(uuid.uuid4())
    with get_session() as db:
        existing = db.execute(select(ChatSession).where(ChatSession.id == provided)).scalar_one_or_none()
    if existing is not None and existing.bot_id != bot_id:
        # Session exists but belongs to a different bot. Reject and mint a fresh ID
        return str(uuid.uuid4())
    return provided


# The detection-trust rule (its floor, its code-switching escape hatch, and the
# two together) lives in ``language_service.detection_is_trusted``. It moved
# there when live chat gained its own resolver: the bot turn and the live-chat
# turn have to agree about what language a visitor is writing in, and a
# threshold defined twice is how they would come to disagree.
_detection_is_trusted = detection_is_trusted

# Tiers whose resolved locale a trusted message detection is allowed to
# replace. ``browser`` is a header every browser sends and ``persisted`` is a
# locale this same chain resolved earlier; neither outranks the visitor
# actually typing in a script. ``explicit`` and ``site`` are choices and are
# absent from this tuple deliberately.
_DETECTION_OVERRIDABLE_SOURCES = ("default", "browser", "persisted")


def _visitor_language_switch_allowed(lang_cfg: dict) -> bool:
    """The customer's "Let visitors switch language" control.

    Absent means allowed, which is how the widget reads it
    (``allow_visitor_language_switch !== false``), so bots configured before
    the key existed keep the behaviour they have. Only an explicit ``false``
    refuses.
    """
    return lang_cfg.get("allow_visitor_language_switch", True) is not False


def _reconstruct_context(language_code, locale, locked) -> "LanguageContext":
    """Build a LanguageContext from persisted ChatSession columns, for the
    branches that keep an already-resolved language without re-resolving."""
    loc = locale or "en-IN"
    return LanguageContext(
        language=language_code or (language_from_locale(loc) or "en"),
        locale=loc,
        source="explicit" if locked else "persisted",
        confidence=1.0 if locked else 0.85,
        direction=get_locale_direction(loc),
        locked=bool(locked),
    )


def _resolve_visitor_language_and_update_session(
    fastapi_request: Request,
    body: ChatRequest,
    bot: Bot,
    session_id: str,
) -> "LanguageContext | None":
    """Resolve the visitor's language, persist it on the ChatSession if needed,
    and RETURN the effective LanguageContext for the pipeline to consume.

    Returns:
      * ``None`` when multilingual is disabled for this bot, OR when the
        platform-wide ``feature.multilingual_chat_enabled`` switch is off. This
        is the single signal the RAG pipeline uses to stay byte-identical to
        pre-Phase-3 behaviour (no directive, legacy cache key, English canned
        paths, English-tuned retrieval).
      * a ``LanguageContext`` for every enabled bot, whether the language was
        already locked, already settled, freshly resolved, or detected.

    Order of decisions:
      1. Multilingual off, per bot or platform-wide: return None immediately.
      2. Locked session: return the locked context, no write (unless this turn
         is itself an explicit selection).
      3. Settled session with no higher-precedence client signal: return the
         settled context, no write.
      4. Otherwise resolve through the precedence chain. If nothing above the
         default matched, attempt first-turn message detection. Persist and
         return the result.

    Steps 2 and 3 keep this off the hot path: after the first turn the common
    case is a single indexed read with no transaction.
    """
    lang_cfg = getattr(bot, "language_config", None) or {}
    if not is_multilingual_enabled(bot):
        return None

    client_source = (body.language_source or "").strip().lower() or None
    client_locale = body.locale
    if client_source == "explicit" and not _visitor_language_switch_allowed(lang_cfg):
        # Pre-session half of the same control ``POST /chat/language`` enforces.
        # The widget's picker rides the first turn as ``language_source
        # =explicit`` when no session exists yet, so refusing only at that
        # endpoint would leave the toggle bypassable with the public bot key.
        # Demoted rather than rejected: the visitor still gets their turn
        # answered, just in the language the normal precedence chain resolves.
        client_source = None
    # Only these two outrank a language already resolved for the session.
    asserts_override = client_source in ("explicit", "site")

    with get_session() as db:
        # Column-only read: the full ORM entity is not needed to decide this.
        row = db.execute(
            select(
                ChatSession.language_code,
                ChatSession.locale,
                ChatSession.language_locked,
            ).where(ChatSession.id == session_id)
        ).one_or_none()

        existing_locale = None
        if row is not None:
            existing_code, existing_locale, existing_locked = row
            if existing_locked and client_source != "explicit":
                return _reconstruct_context(existing_code, existing_locale, True)
            if existing_code and not asserts_override:
                return _reconstruct_context(existing_code, existing_locale, existing_locked)

        supported = lang_cfg.get("supported_locales") or ["en-IN"]
        default_loc = lang_cfg.get("default_locale") or "en-IN"
        header_lang = fastapi_request.headers.get("accept-language")
        # "Detect the visitor's language" in the dashboard, described there as
        # "From their browser, the page they are on, and their first message."
        # Those are exactly the three tiers gated on it. It was written by the
        # admin UI and read by nothing, so switching it off changed nothing at
        # all. Defaults to True so every bot configured before this reads the
        # flag keeps the behaviour it has. An explicit visitor selection and a
        # locale the customer declared through the JS API are choices, not
        # detection, and stay in effect either way.
        auto_detect = lang_cfg.get("auto_detect", True) is not False

        context = resolve_initial_locale(
            explicit=client_locale if client_source == "explicit" else None,
            # 'site' is the host page's own locale, supplied through
            # OyeChats.init/update/setLocale. Dropping it (as this did) let the
            # browser language outrank a website that had declared its language.
            site=client_locale if client_source == "site" else None,
            html_lang=client_locale if (auto_detect and client_source == "html_lang") else None,
            browser=(client_locale if client_source == "browser" else header_lang) if auto_detect else None,
            persisted=client_locale if client_source == "persisted" else existing_locale,
            supported=supported,
            default=default_loc,
        )

        # First-turn message detection: runs when the resolved tier is one the
        # visitor's own typing outranks (see _DETECTION_OVERRIDABLE_SOURCES),
        # the session has no language yet, and no explicit selection is in
        # play. This is the ONLY place detection runs; a locked or settled
        # session already returned above. Detected locales are narrowed through
        # match_supported_locale, and untrusted / unsupported detections are
        # never persisted.
        if auto_detect and context.source in _DETECTION_OVERRIDABLE_SOURCES and client_source != "explicit":
            detected_lang, confidence, script_letters = detect_message_language_detail(body.question or "")
            if detected_lang and _detection_is_trusted(confidence, script_letters):
                matched = match_supported_locale(detected_lang, supported)
                if matched:
                    context = LanguageContext(
                        language=language_from_locale(matched) or detected_lang,
                        locale=matched,
                        source="message_detected",
                        confidence=confidence,
                        direction=get_locale_direction(matched),
                        locked=False,
                    )

        if row is not None:
            # Nothing actually changed: skip the write and the transaction.
            if existing_locale == context.locale and not context.locked:
                return context
            db.execute(
                update(ChatSession)
                .where(ChatSession.id == session_id)
                .values(
                    language_code=context.language,
                    locale=context.locale,
                    language_source=context.source,
                    language_confidence=context.confidence,
                    language_locked=context.locked,
                )
            )
            db.commit()
        else:
            ensure_chat_session(
                db,
                session_id,
                client_id=bot.client_id,
                bot_id=bot.id,
                language_code=context.language,
                locale=context.locale,
                language_source=context.source,
                language_confidence=context.confidence,
                language_locked=context.locked,
            )
            db.commit()

        return context


class LeadCaptureRequest(PydanticBaseModel):
    session_id: SessionId
    name: Name | None = None
    email: EmailAddress | None = None
    phone: Phone | None = None
    company: Name | None = None
    # True when the widget is re-seeding a NEW session with contact details the
    # same visitor already gave in an EARLIER conversation (see the widget's
    # visitor-name memory). Nothing new was submitted, so this must not fire the
    # ``lead_captured`` webhook or re-run email enrichment: the customer's
    # integrations would otherwise receive a duplicate lead event every time a
    # returning visitor starts another chat. The lead row is still written, which
    # is what lets ``resolve_visitor_name`` skip re-asking for the name.
    restored: bool = False


class ValidateEmailRequest(PydanticBaseModel):
    # Bounded, but deliberately NOT format-validated at the schema layer.
    #
    # This endpoint's entire contract is "is this address usable?", and the
    # widget treats any non-2xx as *pass* (``if (!response.ok) return {valid:
    # true}``, it fails open so a vendor outage never blocks a real visitor).
    # Answering 422 for a syntactically invalid address would therefore make
    # the widget accept exactly the addresses this endpoint exists to catch.
    # The handler's ``_EMAIL_RE`` check returns the correct
    # ``200 {"valid": false}`` instead. The length bound is what matters for
    # safety here: the value is hashed into a Redis key and may be forwarded
    # to a third-party verification vendor.
    email: str = Field(..., min_length=1, max_length=MAX_EMAIL)


class BehavioralSignalsRequest(PydanticBaseModel):
    session_id: SessionId
    # ``_sanitize_url`` still runs on these in the handler (it drops non-http
    # schemes before storage); the constraint here bounds length so the
    # 2 KB-truncating sanitiser is never handed a 10 MB string in the first
    # place, and rejects a non-URL outright instead of silently storing None.
    page_url: HttpUrlStr | None = None
    referrer: HttpUrlStr | None = None
    utm_params: UtmParams | None = None
    # Seconds. Finite and day-bounded: the raw value is persisted to a
    # ``double precision`` column and fed into behavioural scoring, and JSON
    # permits ``NaN`` / ``Infinity`` literals that both would happily accept.
    time_on_page: DurationSeconds | None = None
    pages_viewed: CountValue | None = None
    is_return_visit: bool = False
    # Ordered list of ``{"path": "/services", "ts": "2026-07-09T12:00:15Z"}``
    # entries recorded by the widget as the visitor navigated between
    # pages on the host site before opening chat. Optional. Omitted for
    # legacy widget builds. ``_sanitize_journey`` normalises each entry and
    # keeps at most ``_MAX_JOURNEY_ENTRIES``; the bound here refuses an
    # oversized array up front rather than parsing and discarding it, so the
    # cost of a 100k-entry payload is a 422 and not a 100k-iteration loop.
    journey: Annotated[list[dict], bounded_list(_MAX_JOURNEY_ENTRIES)] | None = None


class MeetingBookedRequest(PydanticBaseModel):
    session_id: SessionId
    # Rendered as an anchor href in the admin Leads UI and in notification
    # email. Scheme allow-listing is what keeps a ``javascript:`` payload out
    # of the customer's dashboard.
    booking_url: HttpUrlStr | None = None
    # ISO-8601. Previously parsed with ``contextlib.suppress``, so an
    # unparseable value silently became a booking with no time on it; the
    # annotation makes the caller's malformed timestamp their 422.
    meeting_time: datetime | None = None
    attendee_email: EmailAddress | None = None


logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])


def _parse_request_context(fastapi_request: Request):
    """Extract IP address, device, and browser from the request (no blocking HTTP calls)."""
    user_agent = fastapi_request.headers.get("user-agent", "Unknown")

    # Cloudflare sets CF-Connecting-IP to the real visitor IP. Check it first
    # before falling back to X-Forwarded-For (which Nginx rewrites to the
    # Cloudflare datacenter IP) or the loopback address of the proxy connection.
    ip_address = (
        fastapi_request.headers.get("cf-connecting-ip", "").strip()
        or fastapi_request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or fastapi_request.headers.get("x-real-ip", "")
        or (fastapi_request.client.host if fastapi_request.client else "unknown")
    )

    device = "Other"
    if "Mobi" in user_agent:
        device = "Mobile"
    elif "Tablet" in user_agent:
        device = "Tablet"
    else:
        device = "Desktop"

    browser = "Unknown Browser"
    if "Chrome" in user_agent:
        browser = "Chrome"
    elif "Firefox" in user_agent:
        browser = "Firefox"
    elif "Safari" in user_agent:
        browser = "Safari"
    elif "Edge" in user_agent:
        browser = "Edge"

    formatted_device = f"{browser} on {device}"
    return ip_address, formatted_device


def _visitor_country_from_request(fastapi_request: Request) -> str | None:
    """Return the visitor's ISO country code from Cloudflare's CF-IPCountry header.

    Cloudflare stamps ``CF-IPCountry`` on every proxied request when IP
    Geolocation is enabled for the zone. Normalized to upper-case; the
    placeholder values Cloudflare uses for unresolvable clients (``XX``
    unknown, ``T1`` Tor) and a missing header all collapse to ``None`` so the
    pricing directive treats them as "not India" and defaults to USD. Header
    lookup is case-insensitive in Starlette, so ``cf-ipcountry`` matches the
    ``CF-IPCountry`` Cloudflare sends.
    """
    country = (fastapi_request.headers.get("cf-ipcountry") or "").strip().upper()
    if country in ("", "XX", "T1"):
        return None
    return country


def _is_resolver_owned_location(current: str) -> bool:
    """May this resolver overwrite ``current``?

    True for the empty string, for the ``"IP: x.x.x.x"`` stamp the request
    handler writes synchronously, and for any value in this resolver's own
    output shape. ``"<city>, <country> | <ip>"``. The last is what lets a
    genuinely new IP replace a stale resolved city.

    False for anything else, so a manually-set or future-resolver value is
    never clobbered. The trailing segment must parse as a real IP rather than
    merely contain a pipe, so a human writing "Head office | Mumbai" keeps it.
    """
    if not current or current.startswith("IP:"):
        return True
    _, separator, tail = current.rpartition("|")
    if not separator:
        return False
    try:
        ipaddress.ip_address(tail.strip())
    except ValueError:
        return False
    return True


def _already_resolved(session_id: str, ip_address: str) -> tuple[bool, bool]:
    """What this session has already resolved FOR THIS IP: (intel, location).

    Both call sites fire this resolver on every message, so a ten-turn
    conversation used to spend ten ipapi.is lookups plus ten geolocation
    lookups on one unchanging IP. Measured at 6 calls for 4 sessions even on
    short conversations. The answer cannot change between turns, so all but the
    first is waste, and ipapi.is is metered.

    Keyed on the IP, not merely on presence, so a visitor who moves from wifi
    to mobile data mid-conversation is still re-resolved once. A missing
    session row means "not yet" and must NOT be read as "already done": the row
    is INSERTed by rag_pipeline on the very request that spawned this thread,
    and can legitimately not exist yet.

    **This is read-then-act, not atomic, and it only deduplicates SEQUENTIAL
    turns.** Two messages whose background threads overlap (a double-send, a
    widget retry, /chat and /chat/stream racing) both read "not resolved" and
    both pay. The window is the width of the whole resolution (up to ~11s of
    vendor timeouts and row-wait retries), so it is not narrow. That is
    accepted rather than fixed: this is a cost optimisation, the duplicate
    write is an idempotent upsert of the same answer, and an advisory lock or
    conditional UPDATE would add a failure mode to a path that must never
    affect the visitor. Said plainly here so nobody reads the guard as a
    guarantee.
    """
    try:
        with get_session() as session:
            row = session.query(ChatSession).filter(ChatSession.id == session_id).first()
            if row is None:
                return False, False
            metadata = row.visitor_metadata or {}
            intel = metadata.get("ip_intel") or {}
            has_intel = isinstance(intel, dict) and intel.get("resolved_for_ip") == ip_address
            # A resolved location is written as "<city>, <country> | <ip>", so
            # the trailing IP is the whole test. That deliberately excludes the
            # bare "IP: x.x.x.x" stamp the request handler writes synchronously
            # before this thread runs. Counting that as resolved would mean
            # geolocation never ran at all.
            location = row.location or ""
            has_location = location.endswith(f"| {ip_address}")
            return has_intel, has_location
    except Exception:
        # A failed check must never SUPPRESS resolution. Fall through and do
        # the work rather than silently skipping it.
        logger.debug("could not read prior resolution for session %s", session_id, exc_info=True)
        return False, False


# The per-agent customer toggles, by the enrichment action they gate. Both
# columns default OFF (migration ``b3d9f1a7c2e5``): enrichment spends credits,
# so it is an explicit opt-in the customer switches on, not a metered feature
# left running until they find the settings page. This is the third of three
# independent gates, the plan and the super-admin kill switch still have to
# pass as well.
_AGENT_TOGGLE_COLUMN = {
    "email_verification": "email_verification_enabled",
    "company_name": "company_lookup_enabled",
}


def _agent_enrichment_opt_in(bot_id: int | None, action: str) -> bool:
    """True when the agent's owner has left this enrichment switched on.

    The THIRD of three independent gates, all of which must pass before a
    credit is spent: the plan (Standard/Professional), the super-admin kill
    switch (``feature.<action>_enabled``), and this customer toggle. It is a
    real server-side gate, not a UI convenience. Hiding a switch in the admin
    app would not stop the charge.

    Denies on any error, and denies an unknown action, matching the
    deny-by-default posture of the plan gates: failing open here spends the
    customer's money.
    """
    column = _AGENT_TOGGLE_COLUMN.get(action)
    if bot_id is None or column is None:
        return False
    try:
        with get_session() as session:
            bot = session.query(Bot).filter(Bot.id == bot_id).first()
            return bool(bot and getattr(bot, column, False))
    except Exception:
        logger.warning("%s opt-in lookup failed for bot=%s", action, bot_id, exc_info=True)
        return False


def _charge_for_enrichment(bot_id: int | None, action: str, *, idempotency_key: str | None = None) -> bool:
    """Reserve credits for a metered enrichment lookup. Return True to proceed.

    Skips silently (returns ``False``) when the super-admin feature switch is
    off, the bot can't be resolved, or the ledger can't cover the cost, the
    lead / conversation has already been captured, so a billing shortfall must
    never break it, only drop the optional enrichment. ``action`` doubles as the
    ledger ``reason`` and the ``feature.<action>`` toggle key.

    ``idempotency_key`` is REQUIRED in practice, even though it is optional in
    the signature. Every caller of this function sits on a path that fires more
    than once per billable unit. ``_resolve_and_update_location`` runs on every
    chat message, and ``/chat/lead-capture`` is posted by the widget from both
    the pre-chat form and the handoff form. Without a key, one visitor is
    charged once per MESSAGE or once per POST instead of once per lead, and the
    endpoint's rate limit is per bot-key, which is public. The ledger's unique
    index on the key is what makes "once" durable rather than best-effort.

    Runs in its own committed session so the charge is durable independently of
    the enrichment write that follows. Never raises.
    """
    if idempotency_key is None:
        logger.warning("enrichment charge for %s has no idempotency key, it may double-charge", action)
    if bot_id is None:
        return False
    from app.services import credit_service

    try:
        with get_session() as session:
            if not credit_service.is_feature_enabled(session, action):
                return False
            bot = session.query(Bot).filter(Bot.id == bot_id).first()
            if bot is None:
                return False
            cost = credit_service.get_credit_cost(session, action)
            if cost <= 0:
                return True  # priced to 0 (or misconfigured), nothing to charge
            try:
                credit_service.check_and_deduct(
                    session,
                    bot.client_id,
                    cost,
                    reason=action,
                    reference_id=bot_id,
                    bot_id=credit_service.resolve_bot_ledger_bot_id(bot),  # scope. None when pooled
                    idempotency_key=idempotency_key,
                    attributed_bot_id=bot.id,  # attribution. Always the real bot
                )
            except (credit_service.InsufficientCredits, credit_service.KillSwitchActive):
                return False
            session.commit()
            return True
    except Exception:
        logger.warning(
            "Enrichment charge failed | bot_id=%s action=%s. Skipping",
            bot_id,
            action,
            exc_info=True,
        )
        return False


def _resolve_and_update_location(session_id: str, ip_address: str, bot_id: int | None = None):
    """Fire-and-forget: resolve geolocation from IP and update the session in DB.

    ``bot_id`` gates the paid Visitor-Intelligence company lookup
    (``fetch_ip_intel``): it fires only for a Professional bot, when the
    ``company_name`` feature switch is on, and only after 5 credits are
    successfully reserved. Otherwise it is skipped silently. The free
    geolocation below always runs regardless of plan.

    PRIVACY. THIS MUST STAY OFF THE REQUEST PATH, and not only for latency.
    Every vendor call in here (and in ``ip_intel_service.fetch_ip_intel``) puts
    the visitor's address in the URL. ``https://ipwho.is/<addr>``,
    ``https://ipapi.co/<addr>/json/``, ``?q=<addr>&key=<vendor key>``. Sentry's
    StdlibIntegration patches ``http.client`` and records outbound URLs with
    ``parse_url(real_url, sanitize=False)``: full path, full query, no
    redaction, as the span name and as ``span.data["url"]``. A span is only
    emitted into a live transaction, and ``submit_background`` forks a fresh
    scope per task (``core.thread_pool``) precisely so one can never be
    inherited here, which is what keeps the address and the vendor key out of
    Sentry today. Call any of this inline from a route and both ship on a
    tenth of all traffic, because ``traces_sample_rate=0.1``.
    """
    try:
        # Validate IP format to prevent SSRF via crafted X-Forwarded-For values.
        # Without this, an attacker could inject arbitrary strings (e.g. path
        # traversal, newlines for header injection) into the geolocation URLs.
        ip_address = ip_address.strip()
        try:
            parsed_ip = ipaddress.ip_address(ip_address)
        except ValueError:
            logger.warning("Invalid IP address rejected: %r", ip_address[:100])
            return

        is_local = parsed_ip.is_loopback or parsed_ip.is_private
        if is_local:
            # Local/private IPs are from dev testing or internal health checks.
            # There is no meaningful visitor geolocation to resolve.
            return

        has_intel, has_location = _already_resolved(session_id, ip_address)

        # ORDER IS LOAD-BEARING: dedup, then plan gate, then the lookup, and
        # the charge LAST. Only once we know we have something to sell.
        #
        # The metering (a paid, Professional-only lookup costing
        # `credit_cost.company_name`) and the per-session dedup were written
        # independently. Git merges them without complaint and either order
        # compiles, but charging before the dedup bills the customer 5 credits
        # for EVERY message of a conversation, re-buying an answer that cannot
        # change: a 15-turn chat would cost 75 credits of enrichment against
        # 15 credits of actual AI replies, and ~134 such conversations would
        # exhaust a Professional plan's entire monthly allowance.
        ip_intel = None
        if not has_intel:
            from app.services import credit_service

            with get_session() as session:
                vi_enabled = bot_id is not None and is_visitor_intelligence_enabled_for_bot(bot_id, session)
                feature_on = credit_service.is_feature_enabled(session, "company_name")

            # Evaluated lazily inside the `and` chain, not before it: this
            # opens its own session and SELECTs the bot, and every non-
            # Professional conversation would otherwise pay for a result the
            # short-circuit immediately discards.
            if vi_enabled and feature_on and _agent_enrichment_opt_in(bot_id, "company_name"):
                ip_intel = fetch_ip_intel(ip_address)

                # CHARGE ONLY IF WE ACTUALLY IDENTIFIED AN EMPLOYER.
                #
                # Most visitors cannot be resolved to a company at all: an IP
                # only names one when that company owns its range. Measured on
                # production traffic, 10 resolutions produced ZERO usable
                # names (9 consumer ISPs and a subnet label) and
                # `ip_intel_service` correctly nulls `company_name` for every
                # one of those. Charging before the lookup therefore billed the
                # full 5 credits for "no company identified" nearly every
                # time. We eat the vendor call when we fail to deliver; the
                # customer pays only for an answer.
                #
                # The network signal (`asn_org`, VPN/proxy flags) rides along
                # free, it is the same API response, and the Leads panel
                # presents it as routing information rather than as a company.
                identified = bool(ip_intel and ip_intel.get("company_name"))
                if identified and not _charge_for_enrichment(
                    # `idempotency_key` is the durable backstop for the dedup
                    # above, which is a best-effort read: two overlapping
                    # background threads can both reach here, and the ledger
                    # accepts only the first.
                    bot_id,
                    "company_name",
                    idempotency_key=f"enrich:company_name:{session_id}",
                ):
                    # Out of credits, or the switch flipped off mid-flight.
                    # Keep the free network signal so the operator still sees
                    # who routed the visitor and the dedup still latches, but
                    # withhold the paid identification.
                    logger.info("company identified but not charged | session=%s. Withholding", session_id)
                    ip_intel = dict(ip_intel)
                    ip_intel["company_name"] = None
                    ip_intel["company_domain"] = None
        if ip_intel:
            # Recorded so a later turn can tell "already done" from "done for a
            # different IP". See _already_resolved.
            ip_intel["resolved_for_ip"] = ip_address
            for _ in range(5):
                with get_session() as session:
                    chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
                    if chat_session:
                        # MERGE under a namespaced key, never overwrite the whole
                        # blob. ``visitor_metadata`` predates this feature and is
                        # also read by the operator console's session panel, which
                        # looks for user-agent keys (browser/os). Assigning a fresh
                        # dict (rather than mutating in place) is what makes
                        # SQLAlchemy flush the JSONB change.
                        existing = dict(chat_session.visitor_metadata or {})
                        existing["ip_intel"] = ip_intel
                        chat_session.visitor_metadata = existing
                        session.commit()
                        logger.info(
                            f"IP intel resolved | session={session_id} | "
                            f"company={ip_intel.get('company_name')} type={ip_intel.get('company_type')}"
                        )
                        break
                time.sleep(0.5)

        if not ip_address or has_location:
            return

        location = None

        # PRIVACY, the vendor-failure logs below key on ``session_id``, never on
        # ``ip_address``. Sentry's LoggingIntegration turns every WARNING record
        # into a breadcrumb, so an address interpolated here rode out attached to
        # the next error this process reported. ``session_id`` is the join key to
        # everything else anyway (including the stored address, for an operator
        # with DB access) so the line lost nothing worth having. The two
        # requests themselves carry the address in their URL; see the PRIVACY
        # paragraph in this function's docstring.

        # Primary: ipwho.is (10k/month free, HTTPS, no key, no per-second cap).
        try:
            req = urllib.request.Request(
                f"https://ipwho.is/{ip_address}",
                headers={"User-Agent": "Mozilla/5.0"},
            )
            with urllib.request.urlopen(req, timeout=3.0) as response:
                data = json.loads(response.read().decode())
                if data.get("success"):
                    city = data.get("city", "") or ""
                    country = data.get("country", "") or ""
                    if city and country:
                        location = f"{city}, {country} | {ip_address}"
                    elif country:
                        location = f"{country} | {ip_address}"
                else:
                    logger.warning(f"ipwho.is returned failure | session={session_id} | {data.get('message')}")
        except Exception as e1:
            logger.warning(f"ipwho.is failed | session={session_id} | {e1}")

        # Fallback: ipapi.co (~30k/month free, HTTPS, no key).
        if not location:
            try:
                req2 = urllib.request.Request(
                    f"https://ipapi.co/{ip_address}/json/",
                    headers={"User-Agent": "OyeChats/1.0"},
                )
                with urllib.request.urlopen(req2, timeout=3.0) as response2:
                    data2 = json.loads(response2.read().decode())
                    if not data2.get("error"):
                        city = data2.get("city", "") or ""
                        country = data2.get("country_name", "") or ""
                        if city and country:
                            location = f"{city}, {country} | {ip_address}"
                        elif country:
                            location = f"{country} | {ip_address}"
                    else:
                        logger.warning(f"ipapi.co returned error | session={session_id} | {data2.get('reason')}")
            except Exception as e2:
                logger.warning(f"ipapi.co also failed | session={session_id} | {e2}")

        if not location:
            return

        # The ChatSession row is INSERTed by rag_pipeline on the same request
        # that spawned this thread. Geo lookups (200-1000ms) usually finish
        # after the INSERT, but a fast ip-api response can race ahead of it
        # . Retry briefly so the resolved value isn't dropped on the floor.
        for _ in range(5):
            with get_session() as session:
                chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
                if chat_session:
                    # Overwrite only values THIS resolver owns: the raw "IP: …"
                    # stamp from the request handler, or an earlier resolved
                    # value of ours. Anything else (a manual edit, a future
                    # resolver) is left alone.
                    #
                    # "or an earlier resolved value of ours" is load-bearing.
                    # Without it a visitor who changes network mid-conversation
                    # kept their FIRST city forever: the new value was silently
                    # dropped here, `_already_resolved` then never saw a
                    # location matching the new IP, and so every subsequent
                    # message re-ran both geo vendors and threw the answer away
                    # , on a 10k/month free tier.
                    current = chat_session.location or ""
                    if _is_resolver_owned_location(current):
                        chat_session.location = location
                        session.commit()
                        # PRIVACY, the stored value is "<City>, <Country> | <IP>";
                        # the log gets the geography only. This is the one site in
                        # this function where redaction beats dropping the field:
                        # ``format_visitor_location`` leaves a real city behind
                        # rather than the constant it would return for the
                        # pre-resolution "IP: <addr>" stamp, so the line still says
                        # what the vendor resolved. See ``core.visitor_privacy``.
                        logger.info(
                            f"Background geolocation resolved | session={session_id} | "
                            f"location={format_visitor_location(location)}"
                        )
                    else:
                        logger.info(
                            f"Background geolocation: leaving a non-resolver location alone | "
                            f"session={session_id} | current={format_visitor_location(current)!r}"
                        )
                    return
            time.sleep(0.5)

        logger.warning(f"Background geolocation: session row never appeared | session={session_id}")
    except Exception as e:
        # PRIVACY. ``e`` only. The vendor URLs above carry the visitor's address
        # in their path, and urllib's exceptions do not repeat the URL in
        # ``str()``; nothing else in this function may put one in a log record.
        logger.warning(f"Background geolocation failed | session={session_id} | {e}")


def _enrich_lead_in_background(session_id: str, email: str | None, bot_id: int | None = None):
    """Fire-and-forget: free domain extraction + Reoon power-mode validation.

    Two independent checks, not chained, the domain is free and always
    attempted regardless of plan; Reoon validation (Standard + Professional
    only. Checked via ``is_email_validation_enabled_for_bot``, and metered
    at ``credit_cost.email_verification``, so skipped when the feature switch
    is off or the ledger can't cover it) determines is_valid_email/email_score
    but never blocks the domain from being written, and neither one ever blocks
    lead capture itself (that already succeeded before this was scheduled).
    Power mode can take
    seconds to over a minute per Reoon's own docs. That's fine here since
    nothing is waiting on this thread. ``bot_id`` is optional only for
    backward-compat with any already-queued background task from before
    this signature changed; a missing bot_id denies the paid check
    (deny-by-default), matching every other gate in this codebase.
    """
    if not email:
        return

    from app.db.models import LeadInfo
    from app.services.email_domain_service import extract_company_domain
    from app.services.reoon_service import is_obviously_undeliverable, verify_email

    domain = extract_company_domain(email)

    validation = None
    with get_session() as session:
        plan_allows_verification = bot_id is not None and is_email_validation_enabled_for_bot(bot_id, session)
    # Reoon is a metered call (10 credits): only fire it when the plan allows it,
    # the agent has opted in (AI Agent → Advanced), the feature switch is on, AND
    # the credits are reserved. Otherwise skip silently (domain extraction below
    # still runs; lead capture already succeeded).
    #
    # Keyed per (session, address) because the widget POSTs /chat/lead-capture
    # from TWO places (the pre-chat form and the handoff form) so one visitor
    # who fills the form and then asks for a human produces two calls, one lead,
    # and would otherwise be billed twice. That endpoint is rate-limited per
    # BOT KEY, which is embedded in the widget and therefore public, so an
    # unkeyed charge is also a drain vector: 10/min × 10 credits = 6,000
    # credits/hour, which empties a Standard plan's monthly allowance in about
    # 25 minutes.
    email_fingerprint = hashlib.sha256(email.strip().lower().encode()).hexdigest()[:16]
    if (
        plan_allows_verification
        and _agent_enrichment_opt_in(bot_id, "email_verification")
        and _charge_for_enrichment(
            bot_id,
            "email_verification",
            idempotency_key=f"enrich:email_verification:{session_id}:{email_fingerprint}",
        )
    ):
        validation = verify_email(email)

    with get_session() as session:
        lead = session.query(LeadInfo).filter(LeadInfo.session_id == session_id).first()
        if not lead:
            logger.warning(f"Lead enrichment: LeadInfo row not found | session={session_id}")
            return

        if domain:
            if lead.company and lead.company != domain:
                # The visitor corrected their address to a different employer.
                # `company_name` / description / logo were resolved FROM the old
                # domain, so they are now simply wrong, and `companyDisplay`
                # renders the resolved name ABOVE the domain, which would put
                # "Infosys Limited" over "wipro.com" on a sales rep's screen.
                # Clearing them here is also what lets the dedup guard in
                # `_company_already_resolved` recognise this as unanswered.
                lead.company_name = None
                lead.company_description = None
                lead.company_logo_url = None
            lead.company = domain
        if validation:
            # Use the SAME predicate the widget's blur check uses. Storing
            # Reoon's strict ``is_safe_to_send`` here instead meant a lead the
            # widget had just accepted (catch-all corporate domain) was stored
            # as invalid and could then never be sent a follow-up, the widget
            # and the follow-up gate disagreed about the same address.
            lead.is_valid_email = not is_obviously_undeliverable(validation)
            lead.email_score = validation.get("overall_score")

        try:
            session.commit()
            logger.info(
                f"Lead enriched | session={session_id} | domain={domain} | "
                f"is_valid_email={validation.get('is_safe_to_send') if validation else 'unknown'}"
            )
        except Exception as e:
            session.rollback()
            logger.warning(f"Failed to save background lead enrichment for {session_id}: {e}")

    # Resolve the domain to the company's own declared identity. QUEUED, not
    # run here. See `_queue_lead_company_resolution`.
    _queue_lead_company_resolution(session_id, domain, bot_id)


def _queue_lead_company_resolution(session_id: str, domain: str | None, bot_id: int | None) -> None:
    """Hand the company resolution to the durable queue, or the pool if it is down.

    This used to be a tail call on this same thread, justified in a comment
    that was simply wrong: the pool is FIFO, so total worker-seconds are
    identical either way, and staying on an already-acquired slot lets the
    crawl BYPASS the queue rather than waiting behind queued geolocation and
    BANT. Worse for the neighbours the comment claimed to protect.

    The real problem it created: `/chat/lead-capture` is authenticated by the
    widget's bot key, which is public, and the resolution charges only for an
    ANSWER, so an unresolvable domain costs the caller nothing. Fresh session
    ids with random domains therefore bought unlimited crawls at ~70s of one
    worker each, against a `max_workers=3` pool shared platform-wide. One
    abusive key could stall geolocation and BANT for every bot in the process.

    Same shape as `webhook_service.queue_webhook_delivery`: the durable queue
    when the ARQ worker is running, the thread pool when it is not, so a
    single-process deployment still resolves companies.
    """
    if not domain or bot_id is None:
        return

    from app.worker.enqueue import WORKER_ENABLED

    if WORKER_ENABLED:
        from app.worker.enqueue import enqueue_sync

        # `_job_id` makes ARQ itself reject a duplicate: the widget POSTs
        # /chat/lead-capture from both the pre-chat and handoff forms, and two
        # posts landing close together both pass `_company_already_resolved`
        # (a read) before either writes. The DB guard stops the common
        # sequential repeat; this stops the concurrent one, so we never pay
        # our crawl vendor twice for one visitor. Keyed on the domain too, so
        # a visitor who corrects their address to a different employer still
        # gets resolved.
        enqueue_sync(
            "task_resolve_lead_company",
            session_id,
            domain,
            bot_id,
            _job_id=f"resolve-company:{session_id}:{domain}",
        )
    else:
        submit_background(_resolve_lead_company, session_id, domain, bot_id)


def _company_already_resolved(session_id: str, domain: str) -> bool:
    """Has this lead's company already been answered FOR THIS DOMAIN?

    The widget POSTs /chat/lead-capture from TWO places (the pre-chat form and
    the handoff form) so one visitor produces two runs. The shared ledger key
    makes the second one free for the CUSTOMER, but nothing stopped it
    re-crawling on OUR vendor account. This is the IP path's `_already_resolved`
    guard, which the domain path never had.

    Two things it deliberately does NOT do:

    * It does not skip when the domain has CHANGED. `lead.company` is rewritten
      on every capture, so a second POST with a different address moves the
      domain while a name-only guard would freeze the old `company_name`, and
      `companyDisplay` would then render "Infosys Limited" above "wipro.com",
      a confidently wrong company on a sales rep's screen.
    * It does not fail closed. This is a cost optimisation, not a gate: a
      transient DB error must never SUPPRESS the enrichment, because nothing
      retries it, the only trigger is another lead-capture POST. Matching
      `_already_resolved`, an error falls through and does the work.
    """
    from app.db.models import LeadInfo

    try:
        with get_session() as session:
            existing = session.query(LeadInfo).filter(LeadInfo.session_id == session_id).first()
            return existing is not None and bool(existing.company_name) and existing.company == domain
    except Exception:
        logger.warning("company dedup check failed for session=%s. Resolving anyway", session_id, exc_info=True)
        return False


def _resolve_lead_company(session_id: str, domain: str | None, bot_id: int | None) -> None:
    """Turn the lead's email domain into a company name, description and logo.

    "infosys.com" becomes "Infosys Limited". The work happens in
    ``company_profile_service``, which crawls the domain root, prefers the
    site's OWN declared identity (schema.org, then og:site_name) and only
    spends an LLM call when the site declares nothing. Results are cached in a
    cross-tenant table keyed by registrable domain, so the second lead from any
    company (on any customer's bot) is free.

    Gated exactly like the IP→company lookup, because to a customer they are
    one feature ("who is this visitor's company?") with two signal sources:
    the plan, the super-admin kill switch, and the per-agent toggle.

    It shares the IP path's IDEMPOTENCY KEY on purpose. A session where the IP
    already identified an employer has been charged; finding the same answer
    again from the email domain must not bill twice. Whichever signal gets
    there first pays, once per session.

    ``lead.company`` keeps the raw domain either way, a failed resolution
    degrades to "infosys.com", never to nothing.
    """
    if not domain or bot_id is None:
        return

    from app.db.models import LeadInfo
    from app.services import credit_service
    from app.services.company_profile_service import resolve_company

    try:
        if _company_already_resolved(session_id, domain):
            return
        with get_session() as session:
            allowed = is_visitor_intelligence_enabled_for_bot(bot_id, session)
            feature_on = credit_service.is_feature_enabled(session, "company_name")
        if not (allowed and feature_on and _agent_enrichment_opt_in(bot_id, "company_name")):
            return

        company = resolve_company(domain)
        if company is None:
            return  # parked domain, unreachable site, or nothing declared

        # Charge only for an answer, same rule as the IP path: we absorb the
        # crawl when we cannot identify anyone.
        if not _charge_for_enrichment(bot_id, "company_name", idempotency_key=f"enrich:company_name:{session_id}"):
            logger.info("company resolved for %s but not charged. Withholding", session_id)
            return

        with get_session() as session:
            lead = session.query(LeadInfo).filter(LeadInfo.session_id == session_id).first()
            if lead is None:
                return
            lead.company_name = company.name
            lead.company_description = company.description
            lead.company_logo_url = company.logo_url
            session.commit()
        logger.info("lead company resolved | session=%s | %s -> %s", session_id, domain, company.name)
    except Exception:
        # Enrichment must never surface to a visitor, and the lead is already
        # captured and committed by this point.
        logger.warning("lead company resolution failed for session=%s", session_id, exc_info=True)


_DEFAULT_OFFLINE_MESSAGE = "We're currently away. Please leave a message and we'll get back to you soon."


def _polite_offline_payload(bot: Bot, *, reason: str) -> dict:
    """Build the no-LLM response served when the bot's owner can't take traffic.

    Returns the customer-configured ``offline_message`` (falling back to a
    neutral default) wrapped in a stable schema the widget already knows
    how to render. HTTP 200 is intentional: from the visitor's point of
    view nothing is broken, the team is just away.
    """
    message = (bot.offline_message or "").strip() or _DEFAULT_OFFLINE_MESSAGE
    return {
        "answer": message,
        "status": "service_unavailable",
        "reason": reason,
        "metadata": {
            "service_unavailable": True,
            "offline": True,
            "reason": reason,
        },
    }


def _refund_ai_chat_credit(bot: Bot, cost: int) -> None:
    """Return a previously-charged ``ai_chat`` credit when generation ultimately
    produced no real answer (both LLMs exhausted / mid-stream error). The LLM
    layer never raises (it returns a canned error message) so the credit is
    committed before we know the reply failed; this reverses it.

    Best-effort: a refund failure must never mask the response or the original
    error, so all exceptions are swallowed with a log.
    """
    if cost <= 0:
        return
    from app.services import credit_service

    try:
        with get_session() as db:
            credit_service.refund(
                db,
                bot.client_id,
                cost,
                reference_id=bot.id,
                note="ai_chat generation failed",
                bot_id=credit_service.resolve_bot_ledger_bot_id(bot),  # scope. None when pooled
                attributed_bot_id=bot.id,  # attribution. Mirrors the deduction it reverses
            )
            db.commit()
        logger.info("Refunded ai_chat credit (generation failed) bot_id=%s cost=%s", bot.id, cost)
    except Exception:
        logger.exception("Failed to refund ai_chat credit for bot %s", getattr(bot, "id", "?"))


def _deduct_ai_chat_credit_sync(bot: Bot) -> int:
    """Deduct one ``ai_chat`` credit and return the cost charged.

    Extracted verbatim from the streaming endpoint so the blocking synchronous
    DB work (get_session + check_and_deduct + commit) can run in a threadpool via
    ``asyncio.to_thread`` instead of on the async event loop, where it stalled
    every concurrent chat. Semantics are unchanged: on an empty balance it raises
    HTTP 402, on the billing kill switch HTTP 503, both propagate out of
    ``to_thread`` to the caller exactly as an inline raise would. Callers must
    skip this for preview replies (they are free).
    """
    from app.services import credit_service

    with get_session() as db:
        cost = credit_service.get_credit_cost(db, "ai_chat")
        try:
            credit_service.check_and_deduct(
                db,
                bot.client_id,
                cost,
                reason="ai_chat",
                reference_id=bot.id,
                bot_id=credit_service.resolve_bot_ledger_bot_id(bot),  # scope. None when pooled
                attributed_bot_id=bot.id,  # attribution. Always the real bot
            )
            db.commit()
        except credit_service.InsufficientCredits as exc:
            db.rollback()
            raise HTTPException(
                status_code=402,
                detail={
                    "error": "insufficient_credits",
                    "required": exc.required,
                    "available": exc.available,
                    "message": "You're out of credits. Upgrade your plan or buy a top-up to keep chatting.",
                },
            ) from exc
        except credit_service.KillSwitchActive as exc:
            db.rollback()
            raise HTTPException(
                status_code=503,
                detail={"error": "billing_paused", "message": "Billing is temporarily paused for maintenance."},
            ) from exc
    return cost


def _final_metadata_failure_flag(chunk: str) -> bool | None:
    """If ``chunk`` IS a terminal ``FINAL_METADATA`` frame, return its
    ``generation_failed`` flag (bool); otherwise return None.

    The pipeline yields the terminal frame as its own ``\\nFINAL_METADATA:{...}``
    yield, so a genuine frame is exactly the marker (ignoring surrounding
    whitespace) followed by JSON. Answer text that merely *contains* the marker
    mid-sentence is NOT treated as a frame. That's why we require the stripped
    chunk to *start* with the marker rather than searching for it anywhere.
    Combined with the caller taking the LAST frame's flag (the genuine terminal
    frame is always emitted last), a forged mid-stream frame cannot cause a
    spurious refund."""
    stripped = chunk.strip()
    marker = "FINAL_METADATA:"
    if not stripped.startswith(marker):
        return None
    try:
        return bool(json.loads(stripped[len(marker) :].strip()).get("generation_failed"))
    except (ValueError, TypeError, AttributeError):
        return None


# NOTE ON DECORATOR ORDER: ``impersonation_writable`` sits directly under the
# route decorator and ABOVE ``limiter.limit``. ``limiter.limit`` returns a
# wrapper, and the router registers whatever the decorator directly beneath it
# produced, so the marker must be applied to that wrapper, not to the inner
# function, or the guard would read it back off the wrong object.
@router.post("/chat")
@impersonation_writable
@limiter.limit("30/minute", key_func=key_from_bot_key)
def chat_endpoint(body: ChatRequest, request: Request, bot: Bot = Depends(get_bot_for_chat)):
    """
    RAG Endpoint: Analyzes the question, retrieves relevant documents for the bot,
    and generates a standalone answer.
    Authenticated via X-Bot-Key or X-API-Key (resolves default bot). Owner-preview
    requests (Build Studio: ?preview=true&bot_id=) resolve any owned bot and are free.

    Marked writable for a super-admin impersonation session (design §6.1,
    "Preview-mode test chat"): an owner-preview reply skips credit deduction
    entirely, so exercising the AI Agent costs the Account nothing.

    IMPORTANT, the write guard does **not** run on this endpoint. It lives in
    the Client resolvers, and this route authenticates through
    ``get_bot_for_chat`` instead, which resolves a Bot. The marker is therefore
    not what makes this safe. The real constraint is enforced in
    ``auth._resolve_preview_client``: an ``X-Impersonation-Token`` is accepted
    **only** on the owner-preview path (``preview=true`` + ``bot_id``, which
    sets ``_is_preview`` and skips deduction) and is never forwarded to
    ``get_current_bot``, so the paid widget path on this same endpoint stays
    unreachable under impersonation. The kill switch is checked there too.
    """
    # ── Subscription gate (widget side) ──
    # When the bot owner's trial has expired (or the subscription is
    # otherwise inactive) we return HTTP 200 with the configured offline
    # message instead of a 4xx error. The visitor sees a polite "we're
    # away" reply; nothing on the customer's website breaks. Credits are
    # not deducted on this path.
    owner_status = bot_subscription_status(bot.client_id, subscription_id=getattr(bot, "subscription_id", None))
    if owner_status not in ("trialing", "active", "past_due"):
        logger.info(
            "chat_blocked_inactive_subscription bot_id=%s client_id=%s status=%s",
            bot.id,
            bot.client_id,
            owner_status,
        )
        return _polite_offline_payload(bot, reason=f"subscription_{owner_status}")

    # ── Credit enforcement: must match /chat/stream ──
    # Owner-preview (Build Studio) replies are free. Skip deduction entirely,
    # but bounded by a per-bot daily quota (PREVIEW_DAILY_LIMIT) so an owner
    # can't proxy real visitor traffic through preview for unlimited free LLM
    # completions. See app/services/preview_quota.py.
    is_preview = getattr(bot, "_is_preview", False)
    cost = 0
    if is_preview:
        from app.services.preview_quota import check_and_increment_preview

        if not check_and_increment_preview(bot.id):
            logger.info("chat_preview_quota_exceeded bot_id=%s", bot.id)
            raise HTTPException(status_code=429, detail="preview_daily_limit_reached")
    else:
        from app.services import credit_service

        with get_session() as db:
            cost = credit_service.get_credit_cost(db, "ai_chat")
            try:
                credit_service.check_and_deduct(
                    db,
                    bot.client_id,
                    cost,
                    reason="ai_chat",
                    reference_id=bot.id,
                    bot_id=credit_service.resolve_bot_ledger_bot_id(bot),  # scope. None when pooled
                    attributed_bot_id=bot.id,  # attribution. Always the real bot
                )
                db.commit()
            except credit_service.InsufficientCredits as exc:
                db.rollback()
                raise HTTPException(
                    status_code=402,
                    detail={
                        "error": "insufficient_credits",
                        "required": exc.required,
                        "available": exc.available,
                        "message": "You're out of credits. Upgrade your plan or buy a top-up to keep chatting.",
                    },
                ) from exc
            except credit_service.KillSwitchActive as exc:
                db.rollback()
                raise HTTPException(
                    status_code=503,
                    detail={"error": "billing_paused", "message": "Billing is temporarily paused for maintenance."},
                ) from exc

    refund_done = False

    def _refund_once() -> None:
        """Reverse this request's deduction exactly once.

        The credit is charged before the pipeline runs, so every post-deduction
        failure path has to give it back, and no two of them may give it back
        twice (a preview or a shed request charged nothing at all)."""
        nonlocal refund_done
        if is_preview or not cost or refund_done:
            return
        refund_done = True
        _refund_ai_chat_credit(bot, cost)

    try:
        ip_address, formatted_device = _parse_request_context(request)
        location = f"IP: {ip_address}"
        visitor_country = _visitor_country_from_request(request)
        session_id = _resolve_session_id(body.session_id, bot.id)
        language_ctx = _resolve_visitor_language_and_update_session(request, body, bot, session_id)

        # Fire-and-forget geolocation (saves 2-8s per request)
        submit_background(_resolve_and_update_location, session_id, ip_address, bot.id)

        # TEMPORARY (region-aware pricing rollout): confirm Cloudflare is
        # stamping CF-IPCountry on production traffic. Demote to DEBUG once
        # logs show real country codes (not None). See spec
        # docs/superpowers/specs/2026-08-13-region-aware-pricing-design.md.
        logger.info("visitor_country header | bot_id=%s | cf_ipcountry=%s", bot.id, visitor_country)
        logger.info(f"Chat request | bot_id={bot.id} | bot_name={bot.name} | session={session_id}")

        result = rag_pipeline(
            bot,
            body.question,
            session_id=session_id,
            location=location,
            device=formatted_device,
            bot_id=bot.id,
            cta_dimension=body.cta_dimension,
            visitor_country=visitor_country,
            language=language_ctx,
        )

        ans_len = len(result.get("answer", ""))
        logger.info(f"Chat response generated | session={session_id} | answer_length={ans_len}")
        # Refund the credit when the pipeline only produced a canned error
        # message (both LLMs exhausted), the visitor got no real answer.
        if result.get("generation_failed"):
            _refund_once()
        return result
    except HTTPException:
        _refund_once()
        raise
    except SessionOwnershipError:
        _refund_once()
        raise
    except Exception as e:
        _refund_once()
        bot_id = getattr(bot, "id", "?")
        err_type = type(e).__name__
        logger.error(f"Chat failed for bot {bot_id}: {err_type}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Chat request failed. Please try again.") from e


def _offline_stream(bot: Bot, reason: str):
    """SSE generator that mirrors the rag-pipeline protocol on the offline path.

    The widget expects ``METADATA:{...}`` → text chunks → ``FINAL_METADATA:{...}``.
    We emit a complete shape here so the widget's parser doesn't fall into
    its error path when the bot is offline. Visitor sees the offline
    message rendered like a normal reply.
    """
    import json

    message = (bot.offline_message or "").strip() or _DEFAULT_OFFLINE_MESSAGE
    metadata = {
        "service_unavailable": True,
        "offline": True,
        "reason": reason,
    }
    yield f"METADATA:{json.dumps(metadata)}\n"
    yield message
    yield f"\nFINAL_METADATA:{json.dumps({**metadata, 'answer': message})}\n"


# Decorator order matters exactly as on ``POST /chat`` above, the marker goes
# above ``limiter.limit`` so it lands on the object the router registers.
@router.post("/chat/stream")
@impersonation_writable
@limiter.limit("30/minute", key_func=key_from_bot_key)
async def chat_stream_endpoint(body: ChatRequest, request: Request, bot: Bot = Depends(get_bot_for_chat)):
    """
    Streaming RAG Endpoint: Streams the response token-by-token via SSE.
    Protocol: METADATA:{json} → text chunks → FINAL_METADATA:{json}
    Authenticated via X-Bot-Key (widget) or X-API-Key. Owner-preview requests
    (Build Studio: ``?preview=true&bot_id=``) resolve any owned bot and are free
    (no credit deduction) exactly like the non-streaming ``POST /chat``.

    Marked writable for a super-admin impersonation session (design §6.1,
    "Preview-mode test chat"), with the same mechanics documented on ``POST
    /chat``: the write guard does not run on this endpoint, and the
    owner-preview-only constraint is enforced in
    ``auth._resolve_preview_client`` rather than by the marker.
    """
    # ── Subscription gate (widget side) ──
    # Mirror ``/chat``. When the bot owner's subscription is inactive,
    # stream the offline message rather than running the RAG pipeline. No
    # credits are deducted; the SSE shape stays the same so the widget
    # renders the message exactly like a normal short reply.
    #
    # These pre-stream checks are synchronous SQLAlchemy work; run them in a
    # threadpool (asyncio.to_thread) so they never block the single event loop
    # that is concurrently streaming other visitors' chats. Semantics unchanged.
    owner_status = await asyncio.to_thread(
        bot_subscription_status, bot.client_id, subscription_id=getattr(bot, "subscription_id", None)
    )
    if owner_status not in ("trialing", "active", "past_due"):
        logger.info(
            "chat_stream_blocked_inactive_subscription bot_id=%s client_id=%s status=%s",
            bot.id,
            bot.client_id,
            owner_status,
        )
        return StreamingResponse(
            _offline_stream(bot, reason=f"subscription_{owner_status}"),
            media_type="text/event-stream",
        )

    # ── Credit enforcement: deduct 1 credit per AI reply (configurable) ──
    # Owner-preview (Build Studio) replies are free. Skip deduction entirely,
    # mirroring POST /chat, but bounded by a per-bot daily quota
    # (PREVIEW_DAILY_LIMIT) so an owner can't proxy real visitor traffic
    # through preview for unlimited free LLM completions. ``cost`` stays 0 so
    # the refund path below is a no-op. See app/services/preview_quota.py.
    is_preview = getattr(bot, "_is_preview", False)
    cost = 0
    if is_preview:
        from app.services.preview_quota import check_and_increment_preview

        if not await asyncio.to_thread(check_and_increment_preview, bot.id):
            logger.info("chat_stream_preview_quota_exceeded bot_id=%s", bot.id)
            raise HTTPException(status_code=429, detail="preview_daily_limit_reached")
    else:
        # Offloaded credit deduction (see _deduct_ai_chat_credit_sync): identical
        # transaction/refund semantics, off the event loop. HTTP 402/503 raised in
        # the thread propagate here unchanged.
        cost = await asyncio.to_thread(_deduct_ai_chat_credit_sync, bot)

    refund_done = False

    def _refund_once() -> None:
        """Reverse this request's deduction exactly once.

        The credit is charged before anything else runs, so session resolution,
        the concurrency gate and the stream itself must all give it back on
        failure — and none of them may give it back twice."""
        nonlocal refund_done
        if is_preview or not cost or refund_done:
            return
        refund_done = True
        _refund_ai_chat_credit(bot, cost)

    try:
        ip_address, formatted_device = _parse_request_context(request)
        location = f"IP: {ip_address}"
        visitor_country = _visitor_country_from_request(request)
        session_id = await asyncio.to_thread(_resolve_session_id, body.session_id, bot.id)
        language_ctx = await asyncio.to_thread(
            _resolve_visitor_language_and_update_session, request, body, bot, session_id
        )
    except Exception:
        # Nothing was generated (session ownership, language write, a DB blip),
        # so the visitor is not charged for a reply they never got.
        _refund_once()
        raise

    # Fire-and-forget geolocation
    submit_background(_resolve_and_update_location, session_id, ip_address, bot.id)

    # TEMPORARY (region-aware pricing rollout): see the matching note on
    # POST /chat above. Confirms CF-IPCountry reaches the origin in production.
    logger.info("visitor_country header | bot_id=%s | cf_ipcountry=%s", bot.id, visitor_country)
    logger.info(f"Chat stream request | bot_id={bot.id} | bot_name={bot.name} | session={session_id}")

    # ── Backpressure: bound concurrent generations below the DB pool ──
    # A global gate caps in-flight chat generations under the connection pool so
    # a traffic spike can never exhaust it (the measured collapse mode). Excess
    # requests wait briefly then get a fast 503 (Retry-After) instead of a 30s
    # QueuePool hang. Acquired here (after the cheap subscription/credit gates so
    # their early-returns never hold a slot) and released in the generator's
    # finally below (covers success, error, and client disconnect). If the gate
    # sheds this request we refund the credit just deducted, so a rejected chat is
    # never charged.
    _slot = chat_gate.slot()
    try:
        await _slot.__aenter__()
    except HTTPException:
        _refund_once()
        raise

    async def _stream_with_refund():
        """Proxy the RAG stream and, once it finishes, refund the credit if the
        terminal FINAL_METADATA frame flagged a failed generation (both LLMs
        exhausted / mid-stream error). A client disconnect before that frame
        cancels this generator and skips the refund. Correct, since we never
        confirmed a failed reply and must never over-refund a delivered one.

        Always releases the concurrency slot on exit (success, error, or the
        GeneratorExit raised on client disconnect), so a shed/cancelled stream
        can never leak a slot and starve the gate."""
        generation_failed = False
        try:
            async for chunk in rag_pipeline_stream(
                bot,
                body.question,
                session_id=session_id,
                location=location,
                device=formatted_device,
                bot_id=bot.id,
                cta_dimension=body.cta_dimension,
                visitor_country=visitor_country,
                language=language_ctx,
            ):
                if isinstance(chunk, str):
                    flag = _final_metadata_failure_flag(chunk)
                    if flag is not None:
                        # Last genuine terminal frame wins; the real one is emitted
                        # last, so it overrides any earlier (even forged) frame.
                        generation_failed = flag
                yield chunk
            # Never refund a preview (nothing was charged); otherwise refund a
            # confirmed failed generation.
            if generation_failed:
                _refund_once()
        except Exception:
            # The pipeline blew up mid-stream: no complete answer was billed
            # for. GeneratorExit/CancelledError (client disconnect) are
            # BaseExceptions and deliberately not caught here — we never
            # confirmed a failure, and the visitor may have had the answer.
            _refund_once()
            raise
        finally:
            # Release the concurrency slot no matter how the stream ends.
            await _slot.__aexit__(None, None, None)

    return StreamingResponse(_stream_with_refund(), media_type="text/event-stream")


# Same limiter treatment as the other public widget endpoints on this router.
# This one writes and locks session state from an unauthenticated visitor
# context (the bot key is public), so leaving it unthrottled let a single
# visitor rewrite a session's language without bound.
@router.post("/chat/language", response_model=ChangeLanguageResponse)
@limiter.limit("20/minute", key_func=key_from_bot_key)
def change_chat_language(
    request: Request,
    body: ChangeLanguageRequest,
    bot: Bot = Depends(get_current_bot),
):
    """Explicitly change the language for an active chat session.

    Validates that the bot has multilingual enabled, that the locale is one the
    bot actually offers, and that the session belongs to this bot, then locks
    the session language.
    """
    lang_cfg = getattr(bot, "language_config", None) or {}

    # A bot that has not enabled multilingual must not accept language writes at
    # all. Previously the `enabled` flag only gated *validation*, so a disabled
    # bot accepted any well-formed locale and locked it onto the session, which
    # broke the guarantee that such bots behave exactly as they did before.
    # Also refused when the platform switch is off: otherwise a visitor could
    # still lock a language onto a session that the pipeline will then ignore,
    # leaving the session marked Hindi while every answer comes back English.
    if not is_multilingual_enabled(bot):
        raise HTTPException(status_code=403, detail="Multilingual is not enabled for this bot")

    # "Let visitors switch language", enforced server-side. It was checked only
    # in the widget (which hides its picker), and this endpoint authenticates
    # with the public bot key, so anyone reading a customer's page source could
    # switch and LOCK a session language for a bot whose owner turned the
    # picker off.
    if not _visitor_language_switch_allowed(lang_cfg):
        raise HTTPException(status_code=403, detail="Visitor language switching is disabled for this bot")

    normalized = normalize_locale(body.locale)
    if not normalized:
        raise HTTPException(status_code=400, detail="Invalid locale format")

    supported = lang_cfg.get("supported_locales") or ["en-IN"]

    # Always narrow through match_supported_locale. Gating this on
    # `is_supported_locale` skipped the narrowing whenever the base language
    # matched, so a request for fr-CA against a bot offering only fr-FR stored
    # fr-CA: a locale the bot has neither configuration nor content for.
    matched = match_supported_locale(normalized, supported)
    if not matched:
        raise HTTPException(status_code=400, detail="Unsupported locale")
    normalized = matched

    lang_code = language_from_locale(normalized) or "en"

    with get_session() as db:
        try:
            update_chat_session_language(
                db,
                body.session_id,
                bot.id,
                language_code=lang_code,
                locale=normalized,
                language_source="explicit",
                language_confidence=1.0,
                language_locked=True,
            )
            db.commit()
        except SessionOwnershipError:
            raise HTTPException(status_code=404, detail="Chat session not found") from None
        except Exception as e:
            db.rollback()
            logger.exception("Failed to update chat session language: %s", e)
            raise HTTPException(status_code=500, detail="Failed to update language") from e

    return ChangeLanguageResponse(
        language=lang_code,
        locale=normalized,
        source="explicit",
        locked=True,
    )


# A Reoon verdict for a given address does not change day to day, and this
# check is unmetered, so caching it is the cheapest way to bound vendor spend
# on a public endpoint.
_REOON_VERDICT_TTL_S = 24 * 60 * 60
# A verdict that BLOCKS a visitor is held only long enough to absorb a burst.
# See `validate_email_endpoint` for why the two are not symmetric.
_REOON_BLOCKED_TTL_S = 5 * 60

# Two different ceilings, because this route has two different costs.
#
# The decorator below bounds REQUESTS from one visitor (the limit key is
# ``<bot-key>:<client-ip>``). It is a flood guard for the DB gate checks and
# the cache read, set far above anything a person filling a form can reach.
#
# ``_REOON_BUDGET`` bounds the only expensive thing here, the vendor call, and
# is spent in the handler at the point we are about to make one. A cached
# answer costs nothing and must not consume it. Keeping them separate is what
# stops a visitor who re-checks addresses we already hold verdicts for from
# exhausting the budget that guards our Reoon bill, and then having their next
# address let through unchecked.
_REOON_REQUEST_LIMIT = "60/minute"
_REOON_BUDGET = "20/minute"


def _email_verdict(bot: Bot, request: Request, email: str) -> bool | None:
    """Reoon's verdict for one address, shared by every visitor-facing capture path.

    Returns ``True`` (obviously undeliverable), ``False`` (usable as far as
    Reoon can tell), or ``None`` meaning "not checked": the plan, the agent
    opt-in or the platform switch says no, the vendor budget is spent, or Reoon
    itself could not be reached. Callers must treat ``None`` as PASS. An infra
    hiccup or a lower tier must never block a real visitor.

    Extracted so ``/chat/validate-email`` and the meeting-booking path ask the
    question exactly once, in one place. They previously disagreed: the widget
    forms were gated on this verdict and ``attendee_email`` was not checked at
    all, so the one address a booking is actually followed up on was the one
    nobody verified.
    """
    with get_session() as session:
        # Plan gate (Standard + Professional), the per-agent customer opt-in, AND
        # the super-admin feature switch. This real-time blur check is NOT metered
        # (it's a pre-submit UX helper, not the billable per-lead verification)
        # but it must respect the same on/off controls so it never calls Reoon
        # for an agent that has verification turned off.
        from app.services import credit_service

        if (
            not is_email_validation_enabled_for_bot(bot.id, session)
            or not credit_service.is_feature_enabled(session, "email_verification")
            or not _agent_enrichment_opt_in(bot.id, "email_verification")
        ):
            return None

    from app.core.cache import cache_get, cache_set
    from app.services.reoon_service import (
        REOON_INTERACTIVE_TIMEOUT_S,
        is_obviously_undeliverable,
        verify_email,
    )

    # CACHED, because this call is UNMETERED and the endpoint is public.
    #
    # It is authenticated only by the widget's bot key (embedded in customer
    # pages), so every Reoon call it makes lands on OyeChats' account with no
    # ledger row anywhere. Metering it would be the wrong fix: this is a
    # pre-submit UX helper that fires on field blur, and charging a customer
    # because a visitor tabbed through a form twice is indefensible. The cache
    # plus ``_REOON_BUDGET`` bound the spend instead.
    #
    # The two verdicts get DIFFERENT lifetimes, because they fail in opposite
    # directions. A "deliverable" answer is safe to hold for a day: the worst
    # case is that we let through an address that went bad since. An
    # "undeliverable" answer BLOCKS the visitor (`HandoffForm` refuses to
    # submit on it) and `is_obviously_undeliverable` reads a live DNS/SMTP
    # probe that this codebase already documents as having known false
    # positives. Holding one of those for 24 hours pins a real person out of
    # every OyeChats widget on the internet (the key is the address, not the
    # tenant, because deliverability is a property of the address). A short
    # window still collapses the abuse case (a loop on the public bot key
    # hammers the same few addresses within seconds) while letting a
    # transient false verdict clear on the visitor's next try.
    #
    # Keyed on a hash so no raw address is stored in Redis, and prefixed like
    # every other key this platform writes (`core/cache.PREFIX`) so a shared
    # Redis can't collide and a prefix flush can reach it.
    fingerprint = hashlib.sha256(email.strip().lower().encode()).hexdigest()[:32]
    cache_key = f"oyechats:reoon:verdict:{fingerprint}"

    cached = cache_get(cache_key)
    if isinstance(cached, dict) and "undeliverable" in cached:
        return bool(cached["undeliverable"])

    # About to spend money. This is the point the budget is for, and the
    # only path that reaches it, so a visitor re-checking addresses we
    # already have verdicts for can never exhaust it.
    if not consume_vendor_budget("reoon_verify", key_from_bot_key(request), _REOON_BUDGET):
        logger.warning(
            "reoon_budget_exhausted | bot=%s. Returning unverified",
            bot.id,
        )
        return None

    # The SHORT budget: a visitor is waiting on this one.
    validation = verify_email(email, timeout=REOON_INTERACTIVE_TIMEOUT_S)
    if validation is None:
        # Reoon unreachable. Fail OPEN. A visitor must never be blocked
        # from submitting because our vendor is down. Not cached: the next
        # attempt should retry rather than inherit an outage.
        return None
    undeliverable = is_obviously_undeliverable(validation)
    ttl = _REOON_BLOCKED_TTL_S if undeliverable else _REOON_VERDICT_TTL_S
    cache_set(cache_key, {"undeliverable": undeliverable}, ttl)
    return undeliverable


@router.post("/chat/validate-email")
@limiter.limit(_REOON_REQUEST_LIMIT, key_func=key_from_bot_key)
def validate_email_endpoint(body: ValidateEmailRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """Real-time check the widget calls on email-field blur, before the
    visitor can submit the handoff or offline-message form. Auth: X-Bot-Key.

    Paid plans only (every tier above Free). Gated per-bot via
    ``is_email_validation_enabled_for_bot`` so a Free bot never fires the
    paid Reoon call (not just hides its result): its widget still submits
    the form normally, exactly as it did before this feature existed.

    Deliberately lenient: blocks only unambiguous junk (bad syntax,
    disposable addresses, spamtraps, domains with no working mail server).
    Catch-all and "unknown" results are let through. Many real B2B
    companies run catch-all mail gateways that Reoon can't confirm
    deliverability on either way, and this endpoint's job is to keep fake
    leads out, not to reject genuine visitors it can't fully verify. Fails
    open (valid=True) if Reoon is unreachable, unconfigured, or the bot's
    plan doesn't include this feature, an infra hiccup or a lower tier
    must never block a real visitor from talking to a human. See
    docs/superpowers/plans/2026-08-08-visitor-intelligence.md.

    Every fail-open path returns ``200`` with ``unverified: true`` rather than
    an error status. The widget must never have to infer a verdict from a
    status code: a ``429`` says something about our budget, nothing about the
    address, and a client that reads one as "valid" turns every throttled
    moment into a validation hole. Saying so explicitly also makes the skips
    countable in logs instead of invisible.
    """
    email = body.email.strip().lower()
    if not _EMAIL_RE.match(email):
        return {"valid": False, "reason": "Please enter a valid email address."}

    undeliverable = _email_verdict(bot, request, email)
    if undeliverable is None:
        return {"valid": True, "unverified": True}
    if undeliverable:
        return {"valid": False, "reason": "This email address doesn't look right. Mind double-checking it?"}
    return {"valid": True}


@router.post("/chat/lead-capture")
@limiter.limit("10/minute", key_func=key_from_bot_key)
def lead_capture_endpoint(body: LeadCaptureRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """Capture lead contact info from pre-chat or handoff form. Auth: X-Bot-Key.

    Email validation (Reoon) runs entirely in the background via
    ``_enrich_lead_in_background``, never here. Reoon's power mode can take
    seconds to over a minute; blocking this endpoint on it would hang the
    visitor's live chat request. A possibly-invalid email is still captured:
    Reoon has known false positives (confirmed empirically. See
    docs/superpowers/plans/2026-08-08-visitor-intelligence.md §04), so
    hard-rejecting a lead the visitor is actively submitting risks losing a
    real one. The validation result instead gates the *manual* follow-up
    send later (Gate 1 in ``lead_routes.send_manual_follow_up``).
    """
    from app.services.plan_entitlements_service import is_lead_source_attribution_enabled_for_bot

    try:
        with get_session() as session:
            chat_session = ensure_chat_session(session, body.session_id, client_id=bot.client_id, bot_id=bot.id)

            # Snapshot UTM + visitor_journey onto the lead row only when the
            # owning client's plan includes Lead Source Attribution. Free /
            # Starter clients still get their lead captured (with contact
            # info). They just don't get the durable per-lead attribution
            # copy that Standard / Professional clients see in the Leads UI.
            utm_snapshot: dict | None = None
            journey_snapshot: list | None = None
            # A restored lead is written against a session created moments ago,
            # before any page-view or UTM signal has been recorded, so both
            # snapshots would be empty. Skip the entitlement lookup entirely
            # rather than pay a plan query per new conversation.
            if (
                not body.restored
                and getattr(bot, "id", None) is not None
                and is_lead_source_attribution_enabled_for_bot(bot.id, session)
            ):
                utm_snapshot = chat_session.utm_params or None
                journey_snapshot = chat_session.visitor_journey or None

            create_or_update_lead_info(
                session,
                session_id=body.session_id,
                bot_id=bot.id,
                name=body.name,
                email=body.email,
                phone=body.phone,
                company=body.company,
                utm_params=utm_snapshot,
                visitor_journey=journey_snapshot,
            )
            session.commit()

            # Re-seeding a known visitor's details into a fresh session is not a
            # new lead: no webhook, no enrichment. Both are keyed to the visitor
            # ACTUALLY submitting something, and the enrichment work was already
            # done when they first did.
            if body.restored:
                logger.info(f"Lead restored | bot={bot.id} session={body.session_id}")
                return {"success": True, "session_id": body.session_id, "restored": True}

            logger.info(f"Lead captured | bot={bot.id} session={body.session_id} email={_redact_email(body.email)}")

            # Fire background enrichment
            from app.core.thread_pool import submit_background

            submit_background(_enrich_lead_in_background, body.session_id, body.email, bot.id)
            try:
                from app.services.webhook_service import fire_webhook

                fire_webhook(
                    bot.id,
                    "lead_captured",
                    {
                        "session_id": body.session_id,
                        "name": body.name,
                        "email": body.email,
                        "phone": body.phone,
                        "company": body.company,
                    },
                )
            except Exception as wh_err:
                logger.warning(f"Webhook dispatch failed (non-blocking): {wh_err}")
            return {"success": True, "session_id": body.session_id}
    except SessionOwnershipError:
        raise
    except Exception as e:
        logger.error(f"Lead capture failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to capture lead information.") from e


@router.post("/chat/behavioral-signals")
# Widget flushes every 3s while a visitor navigates, so this ceiling
# needs to accommodate several concurrent visitors on a busy bot.
# 600/min = up to ~30 fast-navigating visitors per minute without any
# silent 429s. Idempotent merge on the server (see _merge_journey) makes
# accidental burst-sends harmless.
@limiter.limit("600/minute", key_func=key_from_bot_key)
def behavioral_signals_endpoint(body: BehavioralSignalsRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """Receive behavioral signals from the widget and compute a behavioral score.

    Called on session init with page context, and on beforeunload with time-on-page.
    Auth: X-Bot-Key.
    """
    from app.db.models import VisitorEvent
    from app.services.behavioral_service import score_behavioral_signals

    try:
        with get_session() as session:
            chat_session = ensure_chat_session(session, body.session_id, client_id=bot.client_id, bot_id=bot.id)

            # Store page context on the session (first call wins for URL/referrer)
            safe_page_url = _sanitize_url(body.page_url)
            if safe_page_url and not chat_session.page_url:
                chat_session.page_url = safe_page_url
            safe_referrer = _sanitize_url(body.referrer)
            if safe_referrer and not chat_session.referrer:
                chat_session.referrer = safe_referrer
            if body.utm_params and not chat_session.utm_params:
                chat_session.utm_params = body.utm_params

            # Merge-append: the widget sends the full current journey on
            # every update (pre-chat, chat markers, post-chat pages), and
            # we union it with what's stored. Entries dedupe by (path,
            # phase, event, ts) so widget resends are idempotent. Reassign
            # the column (not mutate in place) so SQLAlchemy detects the
            # change on JSONB. Skip the whole branch when the widget sent
            # no journey. Preserves the pre-2.0-widget fast path.
            safe_journey = _sanitize_journey(body.journey)
            if safe_journey:
                merged_journey = _merge_journey(chat_session.visitor_journey, safe_journey)
                if merged_journey != chat_session.visitor_journey:
                    chat_session.visitor_journey = merged_journey

            # Update visit count from widget
            if body.is_return_visit and chat_session.visit_count <= 1:
                chat_session.visit_count = max(chat_session.visit_count, 2)

            # Record visitor events
            if safe_page_url:
                session.add(
                    VisitorEvent(
                        session_id=body.session_id,
                        bot_id=bot.id,
                        event_type="page_view",
                        event_data={"url": safe_page_url},
                    )
                )
            if body.utm_params and any(body.utm_params.values()):
                session.add(
                    VisitorEvent(
                        session_id=body.session_id,
                        bot_id=bot.id,
                        event_type="utm_captured",
                        event_data=body.utm_params,
                    )
                )
            if body.is_return_visit:
                session.add(
                    VisitorEvent(
                        session_id=body.session_id,
                        bot_id=bot.id,
                        event_type="return_visit",
                        event_data={"visit_count": chat_session.visit_count},
                    )
                )
            if body.time_on_page and body.time_on_page > 0:
                session.add(
                    VisitorEvent(
                        session_id=body.session_id,
                        bot_id=bot.id,
                        event_type="time_on_site",
                        event_data={"seconds": round(body.time_on_page, 1)},
                    )
                )

            # Compute and store behavioral score
            new_score = score_behavioral_signals(
                {
                    "is_return_visit": body.is_return_visit,
                    "utm_params": body.utm_params,
                    "time_on_page": body.time_on_page or 0,
                    "pages_viewed": body.pages_viewed or 0,
                    "referrer": body.referrer or "",
                },
                bot=bot,
            )
            # Only upgrade behavioral score (never downgrade)
            if new_score > chat_session.behavioral_score:
                chat_session.behavioral_score = new_score

            session.commit()
            logger.info(f"Behavioral signals recorded | bot={bot.id} session={body.session_id} score={new_score}")
            return {"success": True, "behavioral_score": chat_session.behavioral_score}
    except SessionOwnershipError:
        # Let the global handler turn this into a clean 404. Don't mask as 500.
        raise
    except IntegrityError as e:
        # Two near-simultaneous widget requests for a brand-new session_id can
        # race on the chat_sessions PK insert. ``ensure_chat_session`` retries
        # internally, but the retry's re-SELECT can still miss the winner if its
        # commit isn't yet visible. Behavioral signals are idempotent from the
        # widget's perspective. Losing one signal is harmless and far better
        # than 500ing, which makes the widget retry and amplifies the race.
        logger.warning(f"Behavioral signals race ignored | bot={bot.id} session={body.session_id} | {e.orig}")
        return {"success": True, "behavioral_score": None}
    except Exception as e:
        logger.error(f"Behavioral signals failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to record behavioral signals.") from e


@router.post("/chat/meeting-booked")
@limiter.limit("10/minute", key_func=key_from_bot_key)
def meeting_booked_endpoint(body: MeetingBookedRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """Record a confirmed meeting booking. Auth: X-Bot-Key.

    ``attendee_email`` goes through the SAME verification as every other
    visitor-supplied address (``_email_verdict``). It was the one capture path
    that skipped it, which made the gate meaningless in the place it matters
    most: the pre-chat, handoff and offline forms all refuse an obviously
    undeliverable address, while the address a sales rep actually sends the
    invite to was never checked. Fail-open is preserved exactly, an unchecked
    verdict (plan, opt-in, budget, vendor down) books the meeting.
    """
    try:
        from app.db.models import MeetingBooking
        from app.services.webhook_service import fire_webhook

        if body.attendee_email and _email_verdict(bot, request, body.attendee_email) is True:
            logger.info(f"Meeting booking rejected, undeliverable attendee email | bot={bot.id}")
            raise HTTPException(
                status_code=400,
                detail="This email address doesn't look right. Mind double-checking it?",
            )

        with get_session() as session:
            ensure_chat_session(session, body.session_id, client_id=bot.client_id, bot_id=bot.id)
            # Already parsed and validated by the schema, an unparseable
            # timestamp is a 422 rather than a booking silently stored with
            # no time on it.
            meeting_time = body.meeting_time

            session.add(
                MeetingBooking(
                    session_id=body.session_id,
                    bot_id=bot.id,
                    booking_url=body.booking_url,
                    meeting_time=meeting_time,
                    attendee_email=body.attendee_email,
                    status="scheduled",
                )
            )
            session.commit()

            try:
                fire_webhook(
                    bot.id,
                    "meeting_booked",
                    {
                        "session_id": body.session_id,
                        "booking_url": body.booking_url,
                        "meeting_time": meeting_time.isoformat() if meeting_time else None,
                        "attendee_email": body.attendee_email,
                    },
                )
            except Exception as wh_err:
                logger.warning(f"Webhook dispatch failed (non-blocking): {wh_err}")

            return {"success": True}
    except SessionOwnershipError:
        raise
    except HTTPException:
        # The verification refusal above is a deliberate answer, not a failure
        # to save; the blanket handler below would turn it into a 500.
        raise
    except Exception as e:
        logger.error(f"Meeting booking save failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to save meeting booking.") from e


@router.get("/chat/lead-info/{session_id}")
def get_lead_info_endpoint(session_id: SessionId, bot: Bot = Depends(get_current_bot)):
    """
    Fetch existing lead info for a widget session. Auth: X-Bot-Key.
    Always returns HTTP 200. Non-critical endpoint that must never block widget load.
    Used by the widget to pre-fill HandoffForm fields and skip re-asking known info.
    """
    try:
        with get_session() as session:
            chat_session = session.execute(
                select(ChatSession).where(
                    ChatSession.id == session_id,
                    ChatSession.bot_id == bot.id,
                )
            ).scalar_one_or_none()
            if not chat_session:
                return {"lead_info": None}
            lead_info = get_lead_info_by_session(session, session_id)
            if not lead_info:
                return {"lead_info": None}
            return {
                "lead_info": {
                    "name": lead_info.name,
                    "email": lead_info.email,
                    "phone": lead_info.phone,
                    "company": lead_info.company,
                }
            }
    except Exception as e:
        logger.error(f"Failed to fetch lead info for session {session_id}: {e}")
        return {"lead_info": None}  # Always non-breaking for the widget


@router.post("/chat/feedback/{message_id}")
@limiter.limit("30/minute", key_func=key_from_bot_key)
def submit_feedback_endpoint(
    message_id: int, body: FeedbackRequest, request: Request, bot: Bot = Depends(get_current_bot)
):
    """Submit feedback (thumbs up/down) for a specific bot reply. Also scores the Langfuse trace if available."""
    try:
        with get_session() as session:
            from app.db.models import ChatMessage as CM

            success = update_message_feedback(
                session, message_id, client_id=None, feedback_value=body.feedback, bot_id=bot.id
            )
            session.commit()
            if not success:
                raise HTTPException(status_code=404, detail="Message not found or does not belong to this bot")

            # Score the Langfuse trace if trace_id exists
            lf = get_langfuse()
            if lf:
                msg = session.query(CM).filter(CM.id == message_id).first()
                if msg and msg.trace_id:
                    try:
                        lf.create_score(
                            trace_id=msg.trace_id,
                            name="user-feedback",
                            value=float(body.feedback),
                            data_type="NUMERIC",
                        )
                    except Exception as score_err:
                        logger.warning(f"Langfuse score failed (non-breaking): {score_err}")

            return {"message": "Feedback saved successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Feedback submission failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to save feedback.") from e


def _public_translations(raw: dict | None) -> dict | None:
    """Strip internal fields from a ``ChatMessage.translations`` blob.

    ``provider`` / ``model`` / ``created_at`` are stored for audit and cost
    attribution, not for rendering, and the widget serves this endpoint to
    anyone holding the (public) bot key. Only what a client actually draws
    leaves the server.
    """
    if not isinstance(raw, dict):
        return None
    public = {}
    for lang, entry in raw.items():
        if not isinstance(entry, dict):
            continue
        trimmed = {"status": entry.get("status", "ok")}
        if isinstance(entry.get("content"), str):
            trimmed["content"] = entry["content"]
        public[lang] = trimmed
    return public or None


@router.get("/chat/history/{session_id}")
@limiter.limit("60/minute", key_func=key_from_bot_key)
def get_history_endpoint(
    request: Request,
    session_id: SessionId,
    bot_id: RowId | None = Query(None),
    before: int | None = Query(None, ge=1, description="Cursor. Return messages with id < this value"),
    limit: int = Query(50, ge=1, le=200, description="Max messages to return"),
):
    """Retrieve chat history for a given session.

    Accepts both admin auth (X-API-Key / X-Operator-Key) and widget auth (X-Bot-Key).
    Supports cursor-based pagination via `before` param.
    """
    # Dual auth: try client/operator first, fall back to bot key (widget).
    # Only fall back to bot-key when NO admin auth headers were provided.
    # If admin headers are present but invalid, propagate the error.
    # Otherwise a deactivated operator with a valid bot key could still
    # read chat history by triggering the silent fallback.
    auth = None
    resolved_bot_id = bot_id
    has_admin_auth = bool(
        request.headers.get("X-API-Key")
        or request.headers.get("X-Operator-Key")
        or request.headers.get("X-Agent-Key")
        or request.headers.get("X-Impersonation-Token")
    )
    if has_admin_auth:
        # This is the one place the resolver is invoked directly rather than via
        # ``Depends``, so FastAPI does not fill the defaults for us. EVERY
        # parameter must be passed explicitly: the unfilled defaults are
        # ``fastapi.params.Security`` sentinel objects, which are truthy, a
        # partially-specified call would take the impersonation branch for every
        # caller and blow up in ``_parse_workspace_id`` on a sentinel.
        auth = get_current_client_or_operator(
            request,
            api_key=request.headers.get("X-API-Key"),
            operator_key=request.headers.get("X-Operator-Key"),
            legacy_agent_key=request.headers.get("X-Agent-Key"),
            workspace_id_raw=request.headers.get("X-Workspace-Id"),
            impersonation_token=request.headers.get("X-Impersonation-Token"),
        )
    else:
        raw_bot_key = request.headers.get("X-Bot-Key")
        if not raw_bot_key:
            raise HTTPException(status_code=401, detail="Authentication required")
        # Resolve through the shared widget resolver rather than a local
        # SELECT: it is what enforces the bot's origin allowlist and the
        # owner's suspension/deactivation state, both of which a hand-rolled
        # lookup here silently skipped.
        bot_obj = get_current_bot(request, bot_key=raw_bot_key, api_key=None)
        resolved_bot_id = bot_obj.id
        auth = {"client_id": bot_obj.client_id, "type": "bot"}

    try:
        from datetime import UTC, datetime, timedelta

        from app.db.models import Bot as BotModel
        from app.db.models import ChatMessage, ChatSession
        from app.services.plan_entitlements_service import UNLIMITED, get_chat_history_retention_days

        with get_session() as session:
            all_history = []
            sids = session_id.split(",")

            resolve_bot_ids = []
            if not resolved_bot_id:
                query = select(BotModel.id).where(BotModel.client_id == auth["client_id"])
                bots = session.execute(query).scalars().all()
                resolve_bot_ids = list(bots)

            # Plan-driven retention cutoff for admin / operator callers.
            # Widget calls (``auth["type"] == "bot"``) skip this, a visitor's
            # in-progress conversation must be readable regardless of the
            # workspace owner's plan, otherwise a mid-chat refresh would blank
            # out messages the visitor is actively looking at.
            created_after = None
            if auth.get("type") != "bot":
                retention_days = get_chat_history_retention_days(auth["client_id"], session)
                if retention_days != UNLIMITED:
                    created_after = datetime.now(UTC) - timedelta(days=retention_days)

            for sid in sids:
                # Build paginated query with cursor support
                stmt = (
                    select(ChatMessage)
                    .join(ChatSession, ChatMessage.session_id == ChatSession.id)
                    .join(BotModel, ChatSession.bot_id == BotModel.id)
                    .where(
                        ChatMessage.session_id == sid,
                        BotModel.client_id == auth["client_id"],
                    )
                )
                if resolved_bot_id:
                    stmt = stmt.where(BotModel.id == resolved_bot_id)
                elif resolve_bot_ids:
                    stmt = stmt.where(BotModel.id.in_(resolve_bot_ids))
                # Filter by the parent session's ``created_at``, a whole
                # conversation older than the retention window is hidden as
                # a unit. Message-level filtering would leak "session started
                # 20 days ago, but here are 3 recent messages" fragments that
                # confuse the transcript view.
                if created_after is not None:
                    stmt = stmt.where(ChatSession.created_at >= created_after)

                if before is not None:
                    stmt = stmt.where(ChatMessage.id < before)

                stmt = stmt.order_by(ChatMessage.id.desc()).limit(limit)
                history = session.execute(stmt).scalars().all()
                all_history.extend(history)

            # Reverse to chronological order (we queried desc for cursor)
            all_history.sort(key=lambda m: (m.created_at, m.id))

            return [
                {
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "timestamp": m.created_at.isoformat(),
                    "feedback": m.feedback if hasattr(m, "feedback") else None,
                    # Media-card payloads are the whole reason a bot answer
                    # renders as a video/document card after a refresh. Return
                    # them alongside content so the widget hydrates cards
                    # from history the same way it does from a live stream.
                    "media_card": getattr(m, "media_card", None),
                    "media_secondary": getattr(m, "media_secondary", None),
                    # Phase 4. Both clients rebuild their thread from THIS
                    # endpoint on every reconnect, so a translation that lived
                    # only on the wire vanished on refresh and left the visitor
                    # looking at a half-translated conversation. ``content``
                    # above is always the canonical original; these are derived.
                    "source_language": getattr(m, "source_language", None),
                    "translations": _public_translations(getattr(m, "translations", None)),
                }
                for m in all_history
            ]
    except Exception as e:
        logger.error(f"Failed to fetch history: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch chat history.") from e


# ── Visitor file upload. Presigned B2 PUT URL ──

_ALLOWED_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/pdf",
    "text/plain",
}
_MAX_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB


class UploadUrlRequest(PydanticBaseModel):
    # The stored object key is built from this, so it is bounded here as well
    # as stripped of separators in the handler.
    filename: str = Field(..., min_length=1, max_length=255)
    # Checked against ``_ALLOWED_CONTENT_TYPES`` in the handler and embedded in
    # the presigned POST policy; bounded so an oversized string never reaches
    # the signing call.
    content_type: str = Field(..., min_length=1, max_length=128)
    # bytes, the caller's declared size. ``ge=1`` closes the negative-size
    # case: the handler's only guard was ``> _MAX_SIZE_BYTES``, which -1
    # passes. The upper bound stays in the handler so an oversized request
    # keeps its established ``400`` contract rather than becoming a 422, and
    # R2's content-length-range policy remains the authoritative ceiling
    # regardless of what the caller declares here.
    size: int = Field(..., ge=1)
    session_id: SessionId  # must belong to the authenticated bot


@router.post("/chat/upload-url")
@limiter.limit("20/minute", key_func=key_from_bot_key)
async def get_visitor_upload_url(
    body: UploadUrlRequest,
    request: Request,
    bot: Bot = Depends(get_current_bot),
):
    """Return a presigned B2 PUT URL so the widget can upload a file directly.

    Auth: X-Bot-Key header. The widget uploads via PUT (no auth needed) then
    sends the file_url over the live-chat WebSocket.
    """
    if body.content_type not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail=f"File type '{body.content_type}' is not allowed.")
    if body.size > _MAX_SIZE_BYTES:
        raise HTTPException(status_code=400, detail="File exceeds 10 MB limit.")

    # Anti-abuse: bind the presigned CDN upload to a real chat session that
    # belongs to THIS bot. The bot key is public, so without this anyone could
    # mint upload URLs and host arbitrary content on cdn.oyechats.com under a
    # victim's key. Requiring a bot-owned session ties the capability to an
    # actual conversation (and enables per-session cleanup/accounting later).
    with get_session() as session:
        owned_session = session.execute(
            select(ChatSession.id).where(
                ChatSession.id == body.session_id,
                ChatSession.bot_id == bot.id,
            )
        ).scalar_one_or_none()
    if not owned_session:
        raise HTTPException(status_code=404, detail="Chat session not found.")

    from app.services.r2_service import _build_public_url, generate_presigned_post, safe_object_extension

    # The stored key never contains the caller's name. Only a fresh UUID and
    # an allow-listed extension. Sharing the helper with ``upload_chat_file``
    # keeps the two upload paths from drifting apart on what an extension is.
    key = f"chat-files/{uuid.uuid4()}.{safe_object_extension(body.filename)}"

    # Presigned POST (not PUT) so R2 enforces the 10 MB ceiling via the policy's
    # content-length-range, the request-body ``size`` is otherwise only
    # advisory and a holder of a presigned PUT could store an arbitrary-size
    # object on the public CDN.
    presigned = generate_presigned_post(key, body.content_type, _MAX_SIZE_BYTES)
    file_url = _build_public_url(key)
    return {"upload_url": presigned["url"], "fields": presigned["fields"], "file_url": file_url, "key": key}


# ── Transcript Email ──


class TranscriptEmailRequest(PydanticBaseModel):
    session_id: SessionId
    recipient_email: EmailAddress


@router.post("/chat/transcript")
@limiter.limit("3/minute", key_func=key_from_bot_key)
def send_chat_transcript(
    body: TranscriptEmailRequest,
    request: Request,
    bot: Bot = Depends(get_current_bot),
):
    """Send the chat transcript for a session to the visitor's email.

    Auth: X-Bot-Key header (widget).
    Rate limit: 3 per minute per bot key to prevent abuse.
    """
    from app.db.models import ChatMessage
    from app.services.email_service import send_transcript_email

    with get_session() as session:
        # Verify session belongs to this bot
        chat_session = session.execute(
            select(ChatSession).where(
                ChatSession.id == body.session_id,
                ChatSession.bot_id == bot.id,
            )
        ).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Chat session not found.")

        # Anti-exfiltration: recipient_email is visitor-typed free text, so on
        # its own a leaked session_id would let anyone mail another visitor's
        # conversation to an arbitrary inbox. When the session has a captured
        # lead email, the transcript may only be sent to THAT address. Sessions
        # with no lead on file keep the anonymous self-send flow (there is no
        # identity to protect beyond the session_id itself).
        lead = get_lead_info_by_session(session, body.session_id)
        lead_email = (getattr(lead, "email", None) or "").strip().lower()
        if lead_email and body.recipient_email.strip().lower() != lead_email:
            raise HTTPException(
                status_code=403,
                detail="This transcript can only be sent to the email on file for this chat.",
            )

        # Fetch all messages in chronological order
        messages = (
            session.execute(
                select(ChatMessage)
                .where(ChatMessage.session_id == body.session_id)
                .order_by(ChatMessage.created_at.asc())
            )
            .scalars()
            .all()
        )
        if not messages:
            raise HTTPException(status_code=404, detail="No messages found for this session.")

        message_dicts = [
            {
                "role": msg.role,
                "content": html_lib.escape(msg.content or ""),
                "created_at": msg.created_at.isoformat() if msg.created_at else None,
            }
            for msg in messages
        ]

    send_transcript_email(
        to_email=body.recipient_email,
        bot_name=bot.name,
        messages=message_dicts,
        reply_to=bot.reply_to_email,
    )

    return {"success": True, "message": f"Transcript sent to {body.recipient_email}"}


# ──────────────────────────────────────────────────────────────────────────────
# Operator → visitor connect-request consent flow
#
# Operator initiates via /operators/connect-request/{session_id}; the visitor
# widget polls the GET endpoint below to discover the pending invite and posts
# back yes/no. On accept the session transitions to live chat and the operator
# is assigned. On decline (or expiry) the session keeps chatting with the AI.
# ──────────────────────────────────────────────────────────────────────────────


class ConnectRequestResponseBody(PydanticBaseModel):
    accepted: bool
    request_id: Identifier | None = None  # optional. Extra guard against stale popups


@router.get("/chat/connect-request/{session_id}")
def get_pending_connect_request(session_id: SessionId, bot: Bot = Depends(get_current_bot)):
    """Widget polls this while in bot mode to discover operator-initiated
    connect invitations. Returns ``{ pending: false }`` when none.

    Auth: ``X-Bot-Key`` (visitor widget). The session must belong to the bot.
    """
    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            return {"pending": False}
        if chat_session.bot_id != bot.id:
            raise HTTPException(status_code=403, detail="Access denied")

    from app.services.live_chat_service import manager as live_manager

    # Widget polls this every 5s while in bot mode. Perfect signal for
    # "visitor is still on the page chatting with the AI". We piggyback the
    # heartbeat here so we don't need a second endpoint for presence.
    live_manager.record_bot_session_activity(session_id)

    req = live_manager.get_connect_request(session_id)
    if not req:
        return {"pending": False}
    return {
        "pending": True,
        "request_id": req["request_id"],
        "operator_name": req["operator_name"],
        "expires_at": req["expires_at"],
    }


@router.post("/chat/connect-request/{session_id}/respond")
async def respond_to_connect_request(
    session_id: SessionId,
    body: ConnectRequestResponseBody,
    bot: Bot = Depends(get_current_bot),
):
    """Visitor accepts or declines an operator's connect-request.

    On accept we atomically promote the session to live chat and assign it to
    the requesting operator. On decline (or stale ``request_id``) we just
    consume the pending entry, the bot conversation continues unchanged.
    """
    from sqlalchemy import update as sa_update

    from app.db.models import ChatAuditLog, Operator
    from app.services.live_chat_service import manager as live_manager

    pending = live_manager.get_connect_request(session_id)
    if not pending:
        return {"ok": True, "result": "expired"}

    # Optional request_id guard. Protects against an old popup the visitor
    # left open while the operator already cancelled & re-issued.
    if body.request_id and body.request_id != pending["request_id"]:
        return {"ok": True, "result": "stale"}

    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            live_manager.clear_connect_request(session_id)
            raise HTTPException(status_code=404, detail="Session not found")
        if chat_session.bot_id != bot.id:
            raise HTTPException(status_code=403, detail="Access denied")

        operator_id = pending["operator_id"]
        operator_name = pending["operator_name"]
        operator = session.execute(select(Operator).where(Operator.id == operator_id)).scalar_one_or_none()
        if not operator or operator.client_id != bot.client_id:
            # Operator was removed mid-flight. Clear the request and bail out.
            live_manager.clear_connect_request(session_id)
            await live_manager.notify_connect_request_resolved(operator_id, session_id, "expired", visitor_name=None)
            return {"ok": True, "result": "expired"}
        # Capture the avatar while the session is open (the object is read again
        # after the block, where a lazy-load would raise DetachedInstanceError).
        operator_avatar = operator.avatar_url

        if not body.accepted:
            live_manager.clear_connect_request(session_id)
            lead = get_lead_info_by_session(session, session_id)
            visitor_name = (lead.name if lead else None) or "Visitor"
            session.add(
                ChatAuditLog(
                    session_id=session_id,
                    operator_id=operator_id,
                    action="connect_declined",
                )
            )
            session.commit()
            await live_manager.notify_connect_request_resolved(
                operator_id, session_id, "declined", visitor_name=visitor_name
            )
            return {"ok": True, "result": "declined"}

        # Accept path. Must be a bot session AND still in bot status.
        if chat_session.status != "bot":
            live_manager.clear_connect_request(session_id)
            await live_manager.notify_connect_request_resolved(operator_id, session_id, "expired")
            return {"ok": True, "result": "expired"}

        claimed = session.execute(
            sa_update(ChatSession)
            .where(ChatSession.id == session_id, ChatSession.status == "bot")
            .values(status="live", assigned_operator_id=operator_id)
            .returning(ChatSession.id)
        ).scalar_one_or_none()
        if not claimed:
            live_manager.clear_connect_request(session_id)
            await live_manager.notify_connect_request_resolved(operator_id, session_id, "expired")
            return {"ok": True, "result": "expired"}

        session.add(
            ChatAuditLog(
                session_id=session_id,
                operator_id=operator_id,
                action="connect_accepted",
            )
        )

        lead = get_lead_info_by_session(session, session_id)
        visitor_name = (lead.name if lead else None) or "Visitor"
        department_id = chat_session.department_id
        session.commit()

    live_manager.clear_connect_request(session_id)
    live_manager._session_metadata[session_id] = {
        "name": visitor_name,
        "reason": "Connect-request accepted by visitor",
    }
    if department_id is not None:
        live_manager._session_departments[session_id] = department_id

    accepted_ok = await live_manager.accept_chat(session_id, operator_id, operator_name, operator_avatar)
    if not accepted_ok:
        logger.warning(
            "DB accepted connect-request for %s → operator %s but manager rejected it. "
            "DB is authoritative. Proceeding.",
            session_id,
            operator_id,
        )

    await live_manager.notify_connect_request_resolved(operator_id, session_id, "accepted", visitor_name=visitor_name)

    # Refresh the operator console's qualified-bot list. This session has
    # been removed from the "still chatting with AI" pool.
    import asyncio as _asyncio

    _asyncio.create_task(live_manager.broadcast_qualified_bot_changed(bot.client_id, session_id))

    return {
        "ok": True,
        "result": "accepted",
        "operator_name": operator_name,
        "operator_avatar": operator_avatar,
        "visitor_name": visitor_name,
    }
