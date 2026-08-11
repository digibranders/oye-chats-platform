import contextlib
import hashlib
import html as html_lib
import ipaddress
import json
import logging
import re
import time
import urllib.request
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel as PydanticBaseModel
from pydantic import Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.auth import (
    bot_subscription_status,
    get_bot_for_chat,
    get_current_bot,
    get_current_client_or_operator,
    impersonation_writable,
)
from app.core.exceptions import SessionOwnershipError
from app.core.langfuse_client import get_langfuse
from app.core.rate_limit import key_from_bot_key, limiter
from app.core.thread_pool import submit_background
from app.db.models import Bot, ChatSession
from app.db.repository import (
    create_or_update_lead_info,
    ensure_chat_session,
    get_lead_info_by_session,
    update_message_feedback,
)
from app.db.session import get_session
from app.schemas.chat import ChatRequest, FeedbackRequest
from app.services.ip_intel_service import fetch_ip_intel
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
# database as JSONB and is rendered as a timeline in the admin UI — bounding
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
# these sets is dropped by _sanitize_journey — never trust widget input.
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

    Accepts the widget's payload — ``[{"path": "/services", "ts":
    "2026-07-09T12:00:15Z", "phase": "pre", "event": "chat_opened"}, ...]``
    — and drops anything malformed rather than raising. ``phase`` and
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
    still union defensively — if the widget lost its localStorage
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
        # Session exists but belongs to a different bot — reject and mint a fresh ID
        return str(uuid.uuid4())
    return provided


class LeadCaptureRequest(PydanticBaseModel):
    session_id: str
    name: str | None = Field(None, max_length=255)
    email: str | None = Field(None, max_length=255)
    phone: str | None = Field(None, max_length=50)
    company: str | None = Field(None, max_length=255)

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Please enter a valid email address.")
        return v


class ValidateEmailRequest(PydanticBaseModel):
    email: str


class BehavioralSignalsRequest(PydanticBaseModel):
    session_id: str
    page_url: str | None = None
    referrer: str | None = None
    utm_params: dict | None = None
    time_on_page: float | None = None  # seconds
    pages_viewed: int | None = None
    is_return_visit: bool = False
    # Ordered list of ``{"path": "/services", "ts": "2026-07-09T12:00:15Z"}``
    # entries recorded by the widget as the visitor navigated between
    # pages on the host site before opening chat. Optional — omitted for
    # legacy widget builds. Capped server-side to _MAX_JOURNEY_ENTRIES
    # per session to bound row size on high-navigation sites.
    journey: list[dict] | None = None


class MeetingBookedRequest(PydanticBaseModel):
    session_id: str
    booking_url: str | None = None
    meeting_time: str | None = None
    attendee_email: str | None = None


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


def _is_resolver_owned_location(current: str) -> bool:
    """May this resolver overwrite ``current``?

    True for the empty string, for the ``"IP: x.x.x.x"`` stamp the request
    handler writes synchronously, and for any value in this resolver's own
    output shape — ``"<city>, <country> | <ip>"``. The last is what lets a
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
    lookups on one unchanging IP — measured at 6 calls for 4 sessions even on
    short conversations. The answer cannot change between turns, so all but the
    first is waste, and ipapi.is is metered.

    Keyed on the IP, not merely on presence, so a visitor who moves from wifi
    to mobile data mid-conversation is still re-resolved once. A missing
    session row means "not yet" and must NOT be read as "already done": the row
    is INSERTed by rag_pipeline on the very request that spawned this thread,
    and can legitimately not exist yet.

    **This is read-then-act, not atomic, and it only deduplicates SEQUENTIAL
    turns.** Two messages whose background threads overlap — a double-send, a
    widget retry, /chat and /chat/stream racing — both read "not resolved" and
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
            # before this thread runs — counting that as resolved would mean
            # geolocation never ran at all.
            location = row.location or ""
            has_location = location.endswith(f"| {ip_address}")
            return has_intel, has_location
    except Exception:
        # A failed check must never SUPPRESS resolution — fall through and do
        # the work rather than silently skipping it.
        logger.debug("could not read prior resolution for session %s", session_id, exc_info=True)
        return False, False


# The per-agent customer toggles, by the enrichment action they gate. Both
# columns default ON: the customer already pays for a plan that includes these,
# so the useful control is an OFF switch, not an OFF default that hides a paid
# feature behind a settings page they have to discover.
_AGENT_TOGGLE_COLUMN = {
    "email_verification": "email_verification_enabled",
    "company_name": "company_lookup_enabled",
}


def _agent_enrichment_opt_in(bot_id: int | None, action: str) -> bool:
    """True when the agent's owner has left this enrichment switched on.

    The THIRD of three independent gates, all of which must pass before a
    credit is spent: the plan (Standard/Professional), the super-admin kill
    switch (``feature.<action>_enabled``), and this customer toggle. It is a
    real server-side gate, not a UI convenience — hiding a switch in the admin
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
    off, the bot can't be resolved, or the ledger can't cover the cost — the
    lead / conversation has already been captured, so a billing shortfall must
    never break it, only drop the optional enrichment. ``action`` doubles as the
    ledger ``reason`` and the ``feature.<action>`` toggle key.

    ``idempotency_key`` is REQUIRED in practice, even though it is optional in
    the signature. Every caller of this function sits on a path that fires more
    than once per billable unit — ``_resolve_and_update_location`` runs on every
    chat message, and ``/chat/lead-capture`` is posted by the widget from both
    the pre-chat form and the handoff form. Without a key, one visitor is
    charged once per MESSAGE or once per POST instead of once per lead, and the
    endpoint's rate limit is per bot-key, which is public. The ledger's unique
    index on the key is what makes "once" durable rather than best-effort.

    Runs in its own committed session so the charge is durable independently of
    the enrichment write that follows. Never raises.
    """
    if idempotency_key is None:
        logger.warning("enrichment charge for %s has no idempotency key — it may double-charge", action)
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
                return True  # priced to 0 (or misconfigured) — nothing to charge
            try:
                credit_service.check_and_deduct(
                    session,
                    bot.client_id,
                    cost,
                    reason=action,
                    reference_id=bot_id,
                    bot_id=credit_service.resolve_bot_ledger_bot_id(bot),
                    idempotency_key=idempotency_key,
                )
            except (credit_service.InsufficientCredits, credit_service.KillSwitchActive):
                return False
            session.commit()
            return True
    except Exception:
        logger.warning(
            "Enrichment charge failed | bot_id=%s action=%s — skipping",
            bot_id,
            action,
            exc_info=True,
        )
        return False


def _resolve_and_update_location(session_id: str, ip_address: str, bot_id: int | None = None):
    """Fire-and-forget: resolve geolocation from IP and update the session in DB.

    ``bot_id`` gates the paid Visitor-Intelligence company lookup
    (``fetch_ip_intel``): it fires only for a Professional bot, when the
    ``company_name`` feature switch is on, and only after 10 credits are
    successfully reserved — otherwise it is skipped silently. The free
    geolocation below always runs regardless of plan.
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
            # Local/private IPs are from dev testing or internal health checks —
            # there is no meaningful visitor geolocation to resolve.
            return

        has_intel, has_location = _already_resolved(session_id, ip_address)

        # ORDER IS LOAD-BEARING: dedup, then plan gate, then the lookup, and
        # the charge LAST — only once we know we have something to sell.
        #
        # The metering (a paid, Professional-only lookup costing
        # `credit_cost.company_name`) and the per-session dedup were written
        # independently. Git merges them without complaint and either order
        # compiles, but charging before the dedup bills the customer 10 credits
        # for EVERY message of a conversation, re-buying an answer that cannot
        # change: a 15-turn chat would cost 150 credits of enrichment against
        # 15 credits of actual AI replies, and ~67 such conversations would
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
                # names — 9 consumer ISPs and a subnet label — and
                # `ip_intel_service` correctly nulls `company_name` for every
                # one of those. Charging before the lookup therefore billed the
                # full 10 credits for "no company identified" nearly every
                # time. We eat the vendor call when we fail to deliver; the
                # customer pays only for an answer.
                #
                # The network signal (`asn_org`, VPN/proxy flags) rides along
                # free — it is the same API response, and the Leads panel
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
                    logger.info("company identified but not charged | session=%s — withholding", session_id)
                    ip_intel = dict(ip_intel)
                    ip_intel["company_name"] = None
                    ip_intel["company_domain"] = None
        if ip_intel:
            # Recorded so a later turn can tell "already done" from "done for a
            # different IP" — see _already_resolved.
            ip_intel["resolved_for_ip"] = ip_address
            for _ in range(5):
                with get_session() as session:
                    chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
                    if chat_session:
                        # MERGE under a namespaced key — never overwrite the whole
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
                    logger.warning(f"ipwho.is returned failure for {ip_address}: {data.get('message')}")
        except Exception as e1:
            logger.warning(f"ipwho.is failed for {ip_address}: {e1}")

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
                        logger.warning(f"ipapi.co returned error for {ip_address}: {data2.get('reason')}")
            except Exception as e2:
                logger.warning(f"ipapi.co also failed for {ip_address}: {e2}")

        if not location:
            return

        # The ChatSession row is INSERTed by rag_pipeline on the same request
        # that spawned this thread. Geo lookups (200-1000ms) usually finish
        # after the INSERT, but a fast ip-api response can race ahead of it
        # — retry briefly so the resolved value isn't dropped on the floor.
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
                    # — on a 10k/month free tier.
                    current = chat_session.location or ""
                    if _is_resolver_owned_location(current):
                        chat_session.location = location
                        session.commit()
                        logger.info(f"Background geolocation resolved | session={session_id} | location={location}")
                    else:
                        logger.info(
                            f"Background geolocation: leaving a non-resolver location alone | "
                            f"session={session_id} | current={current!r}"
                        )
                    return
            time.sleep(0.5)

        logger.warning(f"Background geolocation: session row never appeared | session={session_id}")
    except Exception as e:
        logger.warning(f"Background geolocation failed for session {session_id}: {e}")


def _enrich_lead_in_background(session_id: str, email: str | None, bot_id: int | None = None):
    """Fire-and-forget: free domain extraction + Reoon power-mode validation.

    Two independent checks, not chained — the domain is free and always
    attempted regardless of plan; Reoon validation (Standard + Professional
    only — checked via ``is_email_validation_enabled_for_bot`` — and metered
    at ``credit_cost.email_verification``, so skipped when the feature switch
    is off or the ledger can't cover it) determines is_valid_email/email_score
    but never blocks the domain from being written, and neither one ever blocks
    lead capture itself (that already succeeded before this was scheduled).
    Power mode can take
    seconds to over a minute per Reoon's own docs — that's fine here since
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
    # the credits are reserved — otherwise skip silently (domain extraction below
    # still runs; lead capture already succeeded).
    #
    # Keyed per (session, address) because the widget POSTs /chat/lead-capture
    # from TWO places — the pre-chat form and the handoff form — so one visitor
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
            lead.company = domain
        if validation:
            # Use the SAME predicate the widget's blur check uses. Storing
            # Reoon's strict ``is_safe_to_send`` here instead meant a lead the
            # widget had just accepted (catch-all corporate domain) was stored
            # as invalid and could then never be sent a follow-up — the widget
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

    # Resolve the domain to the company's own declared identity — QUEUED, not
    # run here. See `_queue_lead_company_resolution`.
    _queue_lead_company_resolution(session_id, domain, bot_id)


def _queue_lead_company_resolution(session_id: str, domain: str | None, bot_id: int | None) -> None:
    """Hand the company resolution to the durable queue, or the pool if it is down.

    This used to be a tail call on this same thread, justified in a comment
    that was simply wrong: the pool is FIFO, so total worker-seconds are
    identical either way, and staying on an already-acquired slot lets the
    crawl BYPASS the queue rather than waiting behind queued geolocation and
    BANT — worse for the neighbours the comment claimed to protect.

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

        enqueue_sync("task_resolve_lead_company", session_id, domain, bot_id)
    else:
        submit_background(_resolve_lead_company, session_id, domain, bot_id)


def _resolve_lead_company(session_id: str, domain: str | None, bot_id: int | None) -> None:
    """Turn the lead's email domain into a company name, description and logo.

    "infosys.com" becomes "Infosys Limited". The work happens in
    ``company_profile_service``, which crawls the domain root, prefers the
    site's OWN declared identity (schema.org, then og:site_name) and only
    spends an LLM call when the site declares nothing. Results are cached in a
    cross-tenant table keyed by registrable domain, so the second lead from any
    company — on any customer's bot — is free.

    Gated exactly like the IP→company lookup, because to a customer they are
    one feature ("who is this visitor's company?") with two signal sources:
    the plan, the super-admin kill switch, and the per-agent toggle.

    It shares the IP path's IDEMPOTENCY KEY on purpose. A session where the IP
    already identified an employer has been charged; finding the same answer
    again from the email domain must not bill twice. Whichever signal gets
    there first pays, once per session.

    ``lead.company`` keeps the raw domain either way — a failed resolution
    degrades to "infosys.com", never to nothing.
    """
    if not domain or bot_id is None:
        return

    from app.db.models import LeadInfo
    from app.services import credit_service
    from app.services.company_profile_service import resolve_company

    try:
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
            logger.info("company resolved for %s but not charged — withholding", session_id)
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
    layer never raises — it returns a canned error message — so the credit is
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
                bot_id=credit_service.resolve_bot_ledger_bot_id(bot),
            )
            db.commit()
        logger.info("Refunded ai_chat credit (generation failed) bot_id=%s cost=%s", bot.id, cost)
    except Exception:
        logger.exception("Failed to refund ai_chat credit for bot %s", getattr(bot, "id", "?"))


def _final_metadata_failure_flag(chunk: str) -> bool | None:
    """If ``chunk`` IS a terminal ``FINAL_METADATA`` frame, return its
    ``generation_failed`` flag (bool); otherwise return None.

    The pipeline yields the terminal frame as its own ``\\nFINAL_METADATA:{...}``
    yield, so a genuine frame is exactly the marker (ignoring surrounding
    whitespace) followed by JSON. Answer text that merely *contains* the marker
    mid-sentence is NOT treated as a frame — that's why we require the stripped
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
# produced — so the marker must be applied to that wrapper, not to the inner
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

    IMPORTANT — the write guard does **not** run on this endpoint. It lives in
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
    # Owner-preview (Build Studio) replies are free — skip deduction entirely,
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
                    bot_id=credit_service.resolve_bot_ledger_bot_id(bot),
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

    try:
        ip_address, formatted_device = _parse_request_context(request)
        location = f"IP: {ip_address}"
        session_id = _resolve_session_id(body.session_id, bot.id)

        # Fire-and-forget geolocation (saves 2-8s per request)
        submit_background(_resolve_and_update_location, session_id, ip_address, bot.id)

        logger.info(f"Chat request | bot_id={bot.id} | bot_name={bot.name} | session={session_id}")

        result = rag_pipeline(
            bot,
            body.question,
            session_id=session_id,
            location=location,
            device=formatted_device,
            bot_id=bot.id,
            cta_dimension=body.cta_dimension,
        )

        ans_len = len(result.get("answer", ""))
        logger.info(f"Chat response generated | session={session_id} | answer_length={ans_len}")
        # Refund the credit when the pipeline only produced a canned error
        # message (both LLMs exhausted) — the visitor got no real answer.
        if result.get("generation_failed") and not is_preview:
            _refund_ai_chat_credit(bot, cost)
        return result
    except HTTPException:
        raise
    except SessionOwnershipError:
        raise
    except Exception as e:
        bot_id = getattr(bot, "id", "?")
        err_type = type(e).__name__
        logger.error(f"Chat failed for bot {bot_id}: {err_type}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Chat request failed. Please try again.") from e


def _offline_stream(bot: Bot, reason: str):
    """SSE generator that mirrors the rag-pipeline protocol on the offline path.

    The widget expects ``METADATA:{...}`` → text chunks → ``FINAL_METADATA:{...}``.
    We emit a complete shape here so the widget's parser doesn't fall into
    its error path when the bot is offline — visitor sees the offline
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


# Decorator order matters exactly as on ``POST /chat`` above — the marker goes
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
    — no credit deduction — exactly like the non-streaming ``POST /chat``.

    Marked writable for a super-admin impersonation session (design §6.1,
    "Preview-mode test chat"), with the same mechanics documented on ``POST
    /chat``: the write guard does not run on this endpoint, and the
    owner-preview-only constraint is enforced in
    ``auth._resolve_preview_client`` rather than by the marker.
    """
    # ── Subscription gate (widget side) ──
    # Mirror ``/chat`` — when the bot owner's subscription is inactive,
    # stream the offline message rather than running the RAG pipeline. No
    # credits are deducted; the SSE shape stays the same so the widget
    # renders the message exactly like a normal short reply.
    owner_status = bot_subscription_status(bot.client_id, subscription_id=getattr(bot, "subscription_id", None))
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
    # Owner-preview (Build Studio) replies are free — skip deduction entirely,
    # mirroring POST /chat, but bounded by a per-bot daily quota
    # (PREVIEW_DAILY_LIMIT) so an owner can't proxy real visitor traffic
    # through preview for unlimited free LLM completions. ``cost`` stays 0 so
    # the refund path below is a no-op. See app/services/preview_quota.py.
    is_preview = getattr(bot, "_is_preview", False)
    cost = 0
    if is_preview:
        from app.services.preview_quota import check_and_increment_preview

        if not check_and_increment_preview(bot.id):
            logger.info("chat_stream_preview_quota_exceeded bot_id=%s", bot.id)
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
                    bot_id=credit_service.resolve_bot_ledger_bot_id(bot),
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

    ip_address, formatted_device = _parse_request_context(request)
    location = f"IP: {ip_address}"
    session_id = _resolve_session_id(body.session_id, bot.id)

    # Fire-and-forget geolocation
    submit_background(_resolve_and_update_location, session_id, ip_address, bot.id)

    logger.info(f"Chat stream request | bot_id={bot.id} | bot_name={bot.name} | session={session_id}")

    async def _stream_with_refund():
        """Proxy the RAG stream and, once it finishes, refund the credit if the
        terminal FINAL_METADATA frame flagged a failed generation (both LLMs
        exhausted / mid-stream error). A client disconnect before that frame
        cancels this generator and skips the refund — correct, since we never
        confirmed a failed reply and must never over-refund a delivered one."""
        generation_failed = False
        async for chunk in rag_pipeline_stream(
            bot,
            body.question,
            session_id=session_id,
            location=location,
            device=formatted_device,
            bot_id=bot.id,
            cta_dimension=body.cta_dimension,
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
        if generation_failed and not is_preview:
            _refund_ai_chat_credit(bot, cost)

    return StreamingResponse(_stream_with_refund(), media_type="text/event-stream")


@router.post("/chat/validate-email")
@limiter.limit("20/minute", key_func=key_from_bot_key)
def validate_email_endpoint(body: ValidateEmailRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """Real-time check the widget calls on email-field blur, before the
    visitor can submit the handoff or offline-message form. Auth: X-Bot-Key.

    Paid plans only (every tier above Free) — gated per-bot via
    ``is_email_validation_enabled_for_bot`` so a Free bot never fires the
    paid Reoon call (not just hides its result): its widget still submits
    the form normally, exactly as it did before this feature existed.

    Deliberately lenient: blocks only unambiguous junk (bad syntax,
    disposable addresses, spamtraps, domains with no working mail server).
    Catch-all and "unknown" results are let through — many real B2B
    companies run catch-all mail gateways that Reoon can't confirm
    deliverability on either way, and this endpoint's job is to keep fake
    leads out, not to reject genuine visitors it can't fully verify. Fails
    open (valid=True) if Reoon is unreachable, unconfigured, or the bot's
    plan doesn't include this feature — an infra hiccup or a lower tier
    must never block a real visitor from talking to a human. See
    docs/superpowers/plans/2026-08-08-visitor-intelligence.md.
    """
    email = body.email.strip().lower()
    if not _EMAIL_RE.match(email):
        return {"valid": False, "reason": "Please enter a valid email address."}

    with get_session() as session:
        # Plan gate (Standard + Professional), the per-agent customer opt-in, AND
        # the super-admin feature switch. This real-time blur check is NOT metered
        # — it's a pre-submit UX helper, not the billable per-lead verification —
        # but it must respect the same on/off controls so it never calls Reoon
        # for an agent that has verification turned off.
        from app.services import credit_service

        if (
            not is_email_validation_enabled_for_bot(bot.id, session)
            or not credit_service.is_feature_enabled(session, "email_verification")
            or not _agent_enrichment_opt_in(bot.id, "email_verification")
        ):
            return {"valid": True}

    from app.services.reoon_service import is_obviously_undeliverable, verify_email

    validation = verify_email(email)
    if validation is None:
        return {"valid": True}

    if is_obviously_undeliverable(validation):
        return {"valid": False, "reason": "This email address doesn't look right — mind double-checking it?"}
    return {"valid": True}


@router.post("/chat/lead-capture")
@limiter.limit("10/minute", key_func=key_from_bot_key)
def lead_capture_endpoint(body: LeadCaptureRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """Capture lead contact info from pre-chat or handoff form. Auth: X-Bot-Key.

    Email validation (Reoon) runs entirely in the background via
    ``_enrich_lead_in_background`` — never here. Reoon's power mode can take
    seconds to over a minute; blocking this endpoint on it would hang the
    visitor's live chat request. A possibly-invalid email is still captured:
    Reoon has known false positives (confirmed empirically — see
    docs/superpowers/plans/2026-08-08-visitor-intelligence.md §04), so
    hard-rejecting a lead the visitor is actively submitting risks losing a
    real one. The validation result instead gates the *manual* follow-up
    send later (Gate 1 in ``lead_routes.send_manual_follow_up``).
    """
    from app.services.plan_entitlements_service import is_lead_source_attribution_enabled_for_bot

    try:
        with get_session() as session:
            chat_session = ensure_chat_session(session, body.session_id, bot_id=bot.id)

            # Snapshot UTM + visitor_journey onto the lead row only when the
            # owning client's plan includes Lead Source Attribution. Free /
            # Starter clients still get their lead captured (with contact
            # info) — they just don't get the durable per-lead attribution
            # copy that Standard / Professional clients see in the Leads UI.
            utm_snapshot: dict | None = None
            journey_snapshot: list | None = None
            if getattr(bot, "id", None) is not None and is_lead_source_attribution_enabled_for_bot(bot.id, session):
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
            chat_session = ensure_chat_session(session, body.session_id, bot_id=bot.id)

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
            # no journey — preserves the pre-2.0-widget fast path.
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
        # Let the global handler turn this into a clean 404 — don't mask as 500.
        raise
    except IntegrityError as e:
        # Two near-simultaneous widget requests for a brand-new session_id can
        # race on the chat_sessions PK insert. ``ensure_chat_session`` retries
        # internally, but the retry's re-SELECT can still miss the winner if its
        # commit isn't yet visible. Behavioral signals are idempotent from the
        # widget's perspective — losing one signal is harmless and far better
        # than 500ing, which makes the widget retry and amplifies the race.
        logger.warning(f"Behavioral signals race ignored | bot={bot.id} session={body.session_id} | {e.orig}")
        return {"success": True, "behavioral_score": None}
    except Exception as e:
        logger.error(f"Behavioral signals failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to record behavioral signals.") from e


@router.post("/chat/meeting-booked")
@limiter.limit("10/minute", key_func=key_from_bot_key)
def meeting_booked_endpoint(body: MeetingBookedRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    try:
        from datetime import datetime

        from app.db.models import MeetingBooking
        from app.services.webhook_service import fire_webhook

        with get_session() as session:
            ensure_chat_session(session, body.session_id, bot_id=bot.id)
            meeting_time = None
            if body.meeting_time:
                with contextlib.suppress(Exception):
                    meeting_time = datetime.fromisoformat(body.meeting_time)

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
                        "meeting_time": body.meeting_time,
                        "attendee_email": body.attendee_email,
                    },
                )
            except Exception as wh_err:
                logger.warning(f"Webhook dispatch failed (non-blocking): {wh_err}")

            return {"success": True}
    except SessionOwnershipError:
        raise
    except Exception as e:
        logger.error(f"Meeting booking save failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to save meeting booking.") from e


@router.get("/chat/lead-info/{session_id}")
def get_lead_info_endpoint(session_id: str, bot: Bot = Depends(get_current_bot)):
    """
    Fetch existing lead info for a widget session. Auth: X-Bot-Key.
    Always returns HTTP 200 — non-critical endpoint that must never block widget load.
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


@router.get("/chat/history/{session_id}")
def get_history_endpoint(
    request: Request,
    session_id: str,
    bot_id: int | None = Query(None),
    before: int | None = Query(None, description="Cursor — return messages with id < this value (for pagination)"),
    limit: int = Query(50, ge=1, le=200, description="Max messages to return"),
):
    """Retrieve chat history for a given session.

    Accepts both admin auth (X-API-Key / X-Operator-Key) and widget auth (X-Bot-Key).
    Supports cursor-based pagination via `before` param.
    """
    # Dual auth: try client/operator first, fall back to bot key (widget).
    # Only fall back to bot-key when NO admin auth headers were provided.
    # If admin headers are present but invalid, propagate the error —
    # otherwise a deactivated operator with a valid bot key could still
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
        # ``fastapi.params.Security`` sentinel objects, which are truthy — a
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
        with get_session() as db:
            bot_obj = db.execute(
                select(Bot).where(Bot.bot_key == raw_bot_key, Bot.is_active.is_(True))
            ).scalar_one_or_none()
            if not bot_obj:
                raise HTTPException(status_code=401, detail="Invalid bot key")
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
            # Widget calls (``auth["type"] == "bot"``) skip this — a visitor's
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
                # Filter by the parent session's ``created_at`` — a whole
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
                }
                for m in all_history
            ]
    except Exception as e:
        logger.error(f"Failed to fetch history: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch chat history.") from e


# ── Visitor file upload — presigned B2 PUT URL ──

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
    filename: str
    content_type: str
    size: int  # bytes — validated before issuing the URL
    session_id: str  # must belong to the authenticated bot


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

    safe_name = body.filename.replace("/", "").replace("\\", "")[:100]
    ext = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else "bin"
    key = f"chat-files/{uuid.uuid4()}.{ext}"

    from app.services.r2_service import _build_public_url, generate_presigned_post

    # Presigned POST (not PUT) so R2 enforces the 10 MB ceiling via the policy's
    # content-length-range — the request-body ``size`` is otherwise only
    # advisory and a holder of a presigned PUT could store an arbitrary-size
    # object on the public CDN.
    presigned = generate_presigned_post(key, body.content_type, _MAX_SIZE_BYTES)
    file_url = _build_public_url(key)
    return {"upload_url": presigned["url"], "fields": presigned["fields"], "file_url": file_url, "key": key}


# ── Transcript Email ──


class TranscriptEmailRequest(PydanticBaseModel):
    session_id: str
    recipient_email: str

    @field_validator("recipient_email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        import re

        v = v.strip().lower()
        if not re.match(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$", v):
            raise ValueError("Please enter a valid email address.")
        return v


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
    request_id: str | None = None  # optional — extra guard against stale popups


@router.get("/chat/connect-request/{session_id}")
def get_pending_connect_request(session_id: str, bot: Bot = Depends(get_current_bot)):
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

    # Widget polls this every 5s while in bot mode — perfect signal for
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
    session_id: str,
    body: ConnectRequestResponseBody,
    bot: Bot = Depends(get_current_bot),
):
    """Visitor accepts or declines an operator's connect-request.

    On accept we atomically promote the session to live chat and assign it to
    the requesting operator. On decline (or stale ``request_id``) we just
    consume the pending entry — the bot conversation continues unchanged.
    """
    from sqlalchemy import update as sa_update

    from app.db.models import ChatAuditLog, Operator
    from app.services.live_chat_service import manager as live_manager

    pending = live_manager.get_connect_request(session_id)
    if not pending:
        return {"ok": True, "result": "expired"}

    # Optional request_id guard — protects against an old popup the visitor
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
            # Operator was removed mid-flight — clear the request and bail out.
            live_manager.clear_connect_request(session_id)
            await live_manager.notify_connect_request_resolved(operator_id, session_id, "expired", visitor_name=None)
            return {"ok": True, "result": "expired"}

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

        # Accept path — must be a bot session AND still in bot status.
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

    accepted_ok = await live_manager.accept_chat(session_id, operator_id, operator_name)
    if not accepted_ok:
        logger.warning(
            "DB accepted connect-request for %s → operator %s but manager rejected it. "
            "DB is authoritative — proceeding.",
            session_id,
            operator_id,
        )

    await live_manager.notify_connect_request_resolved(operator_id, session_id, "accepted", visitor_name=visitor_name)

    # Refresh the operator console's qualified-bot list — this session has
    # been removed from the "still chatting with AI" pool.
    import asyncio as _asyncio

    _asyncio.create_task(live_manager.broadcast_qualified_bot_changed(bot.client_id, session_id))

    return {
        "ok": True,
        "result": "accepted",
        "operator_name": operator_name,
        "visitor_name": visitor_name,
    }
