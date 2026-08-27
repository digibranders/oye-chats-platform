"""Admin CRUD + widget runtime for a bot's quotation catalog.

Pricing lives at the **requirement** level, not the service. A service is just a
named grouping; each of its *requirements* carries its own ``price`` and a
``quantity`` ("how many times"). The visitor picks one service, then checks
which of its requirements they want; the quote is the sum of the chosen
requirements' ``price × quantity``.

Two audiences:

* **Admin** (X-API-Key) reads and writes the bot's catalog — the ordered list
  of services, each with its requirements (label · price · quantity) — plus the
  BANT trigger that gates when the flow fires. The trigger is admin-configurable:
  ``required_categories`` picks which BANT dimensions (Need · Timeline ·
  Authority · Budget) count, and ``threshold`` sets how many must be marked.
  Empty ``required_categories`` means "any of the 4 counts" (default: any 2 of
  4). See ``QuotationCatalog.effective_threshold`` for the clamping rule.
* **Widget** (X-Bot-Key) drives the runtime state machine once the session's
  BANT signals cross the trigger:

    idle → selecting → choosing → quoting → complete
                                          ↘ skipped

  ``selecting``: visitor picks one service.
  ``choosing``:  visitor checks which of that service's requirements they want
                 (no prices are ever shown to the visitor).
  ``quoting``:   the bot collects the visitor's email and finalises the quote.
  ``complete`` / ``skipped``: the widget proceeds to handoff.

State lives on ``chat_sessions.quotation_state`` (JSONB). NULL is the
implicit idle state so legacy sessions cost nothing to migrate.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select

from app.api.auth import get_current_bot, get_current_client_strict
from app.config import QUOTATION_EMAIL_DELAY_SECONDS
from app.core.cache import bot_config_key, cache_delete
from app.db.models import Bot, ChatSession, Client
from app.db.repository import get_lead_info_by_session
from app.db.session import get_session
from app.services import email_service
from app.services.plan_entitlements_service import (
    get_bot_entitlements,
    get_entitlements,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["quotation-catalog"])

# ── Constants ────────────────────────────────────────────────────────────────

MAX_SERVICES = 20
MAX_REQUIREMENTS_PER_SERVICE = 20
MAX_OPTIONS_PER_REQUIREMENT = 12
MAX_NAME = 120
MAX_DESCRIPTION = 500
MAX_LABEL = 280
MAX_UNIT = 40

VALID_BANT_KEYS = {"need", "timeline", "authority", "budget"}
VALID_CURRENCIES = {"INR", "USD", "EUR", "GBP", "AUD", "CAD", "SGD", "AED"}

# Plan gating: quotation flow is a Professional-tier feature. Any bot whose
# active subscription resolves to one of these plan slugs may configure and
# run the flow; everyone else gets a 403 on admin CRUD and a silent
# ``active: false`` on the widget runtime.
QUOTATION_PLAN_SLUGS: frozenset[str] = frozenset({"professional", "enterprise"})


def _client_plan_allows(client_id: int, db) -> bool:
    """True when the client's active plan is Professional or higher."""
    try:
        ent = get_entitlements(client_id, db)
    except Exception:
        return False
    return (ent.plan_slug or "").lower() in QUOTATION_PLAN_SLUGS


def _bot_plan_allows(bot: Bot, db) -> bool:
    """True when the bot's own subscription resolves to a plan that allows
    the quotation flow. Reads the per-bot subscription so a workspace with
    multiple plans still gates each bot correctly."""
    try:
        ent = get_bot_entitlements(bot.id, db)
    except Exception:
        return False
    return (ent.plan_slug or "").lower() in QUOTATION_PLAN_SLUGS


# ── Admin schemas ────────────────────────────────────────────────────────────


class RequirementOption(BaseModel):
    """One priced answer within a ``choice`` requirement (e.g. "Next.js")."""

    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=MAX_LABEL)
    price: float = Field(default=0, ge=0)
    quantity: int = Field(default=1, ge=1, le=1_000_000)


class Requirement(BaseModel):
    """A line item within a service.

    ``type="item"`` is a simple tick-on/off line: its ``price × quantity`` is
    added when the visitor selects it. ``type="choice"`` is a question with
    priced ``options``: the visitor picks at most one, and that option's
    ``price × quantity`` is added. ``quantity`` defaults to 1 everywhere."""

    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=MAX_LABEL)
    # The prompt shown to the visitor for this requirement's step. Optional —
    # falls back to the label (or a generic default for items) in the widget.
    question: str = Field(default="", max_length=MAX_LABEL)
    type: Literal["item", "choice"] = "item"
    price: float = Field(default=0, ge=0)
    # How the quantity is decided:
    #   "none"  → always 1 (no quantity concept; hidden everywhere)
    #   "fixed" → the admin's ``quantity`` (or a choice option's quantity)
    #   "ask"   → the visitor picks a number in the widget (``quantity`` is the
    #             pre-filled default)
    quantity_mode: Literal["none", "fixed", "ask"] = "fixed"
    unit_label: str = Field(default="unit", max_length=MAX_UNIT)
    quantity: int = Field(default=1, ge=1, le=1_000_000)
    options: list[RequirementOption] = Field(default_factory=list)

    @field_validator("options")
    @classmethod
    def _validate_options(cls, value: list[RequirementOption]) -> list[RequirementOption]:
        if len(value) > MAX_OPTIONS_PER_REQUIREMENT:
            raise ValueError(f"at most {MAX_OPTIONS_PER_REQUIREMENT} options per requirement")
        seen: set[str] = set()
        for opt in value:
            if opt.id in seen:
                raise ValueError(f"duplicate option id: {opt.id}")
            seen.add(opt.id)
        return value

    @model_validator(mode="after")
    def _check_choice_has_options(self) -> Requirement:
        if self.type == "choice" and not self.options:
            raise ValueError(f"choice requirement '{self.id}' needs at least one option")
        return self


class Service(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=MAX_NAME)
    description: str = Field(default="", max_length=MAX_DESCRIPTION)
    requirements: list[Requirement] = Field(default_factory=list)

    @field_validator("requirements")
    @classmethod
    def _validate_requirements(cls, value: list[Requirement]) -> list[Requirement]:
        if len(value) > MAX_REQUIREMENTS_PER_SERVICE:
            raise ValueError(f"at most {MAX_REQUIREMENTS_PER_SERVICE} requirements per service")
        seen: set[str] = set()
        for req in value:
            if req.id in seen:
                raise ValueError(f"duplicate requirement id: {req.id}")
            seen.add(req.id)
        return value


class QuotationCatalog(BaseModel):
    """Admin config: services (each with priced requirements) + BANT trigger.

    The trigger lets the admin pick which BANT dimensions (Need · Timeline ·
    Authority · Budget) must be marked before the quotation card fires, and
    how many of the chosen dimensions are required. Empty
    ``required_categories`` means "any of the 4 dimensions counts" (default:
    any 2 of 4)."""

    model_config = ConfigDict(extra="ignore")

    enabled: bool = False
    currency: str = "INR"
    required_categories: list[str] = Field(default_factory=list)
    threshold: int = Field(default=2, ge=1, le=4)
    services: list[Service] = Field(default_factory=list)

    @field_validator("currency")
    @classmethod
    def _validate_currency(cls, value: str) -> str:
        code = (value or "INR").strip().upper()
        if code not in VALID_CURRENCIES:
            raise ValueError(f"currency must be one of {sorted(VALID_CURRENCIES)}")
        return code

    @field_validator("required_categories")
    @classmethod
    def _validate_required_categories(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        seen: set[str] = set()
        for item in value:
            if not isinstance(item, str):
                continue
            key = item.strip().lower()
            if not key or key in seen:
                continue
            if key not in VALID_BANT_KEYS:
                raise ValueError(f"required_categories must be a subset of {sorted(VALID_BANT_KEYS)}")
            cleaned.append(key)
            seen.add(key)
        return cleaned

    @field_validator("services")
    @classmethod
    def _validate_services(cls, value: list[Service]) -> list[Service]:
        if len(value) > MAX_SERVICES:
            raise ValueError(f"at most {MAX_SERVICES} services per bot")
        seen: set[str] = set()
        for service in value:
            if service.id in seen:
                raise ValueError(f"duplicate service id: {service.id}")
            seen.add(service.id)
        return value

    def effective_threshold(self) -> int:
        """Clamp the threshold so a "3 of 2 chosen dimensions" config can
        never be unreachable by construction."""
        if not self.required_categories:
            return max(1, min(4, self.threshold))
        return max(1, min(len(self.required_categories), self.threshold))


# ── Widget runtime schemas ───────────────────────────────────────────────────


class RequirementOptionPublic(BaseModel):
    """Visitor-facing view of a choice option — id + label only, no price."""

    id: str
    label: str


class RequirementPublic(BaseModel):
    """Visitor-facing view of a requirement — never carries prices. ``item``
    is a tick-box; ``choice`` carries its (price-free) options."""

    id: str
    label: str
    question: str = ""
    type: Literal["item", "choice"] = "item"
    quantity_mode: Literal["none", "fixed", "ask"] = "fixed"
    unit_label: str = "unit"
    default_quantity: int = 1
    options: list[RequirementOptionPublic] = Field(default_factory=list)


class ServicePublic(BaseModel):
    id: str
    name: str
    description: str
    requirement_count: int


class ChoosingView(BaseModel):
    """The requirement checklist the visitor picks from, for the one service
    they selected. No prices are exposed."""

    service_id: str
    name: str
    description: str
    requirements: list[RequirementPublic]


class QuoteLine(BaseModel):
    service_id: str
    service_name: str
    requirement_id: str
    label: str
    quantity: int
    unit_label: str = ""
    price: float
    subtotal: float


class QuotationStateOut(BaseModel):
    active: bool
    status: Literal["idle", "selecting", "choosing", "quoting", "complete", "skipped"] = "idle"
    currency: str = "INR"
    services: list[ServicePublic] = Field(default_factory=list)
    selected_service_ids: list[str] = Field(default_factory=list)
    current: ChoosingView | None = None
    quote: list[QuoteLine] = Field(default_factory=list)
    total: float = 0.0


class SelectServicesIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str = Field(min_length=1, max_length=200)
    service_ids: list[str] = Field(default_factory=list)


class RequirementSelectionIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    requirement_id: str = Field(min_length=1, max_length=40)
    # Set for a ``choice`` requirement (the picked option); omitted/None for a
    # ticked ``item`` requirement.
    option_id: str | None = Field(default=None, max_length=40)
    # Set only for an ``ask`` requirement — the visitor's chosen count. 0 (or
    # omitted) means the visitor did not include this requirement.
    quantity: int | None = Field(default=None, ge=0, le=1_000_000)


class RequirementsIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str = Field(min_length=1, max_length=200)
    service_id: str = Field(min_length=1, max_length=40)
    selections: list[RequirementSelectionIn] = Field(default_factory=list)


class SkipIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str = Field(min_length=1, max_length=200)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _normalize(raw) -> QuotationCatalog:
    """Coerce a stored catalog blob into a validated model.

    Malformed / legacy rows degrade to a disabled default so admin GETs and
    runtime trigger checks never explode.
    """
    if not isinstance(raw, dict):
        return QuotationCatalog()
    try:
        return QuotationCatalog.model_validate(raw)
    except Exception:
        return QuotationCatalog()


def _bant_field_present(session: ChatSession, bant_key: str) -> bool:
    score = int(getattr(session, f"bant_{bant_key}_score", 0) or 0)
    value = getattr(session, f"bant_{bant_key}", None)
    return score > 0 or (isinstance(value, str) and bool(value.strip()))


def _bant_marked_count(session: ChatSession, only: list[str] | None = None) -> int:
    keys = only if only else ("need", "budget", "authority", "timeline")
    count = 0
    for key in keys:
        if key not in VALID_BANT_KEYS:
            continue
        if _bant_field_present(session, key):
            count += 1
    return count


def _load_session(db, bot: Bot, session_id: str, *, for_update: bool = False) -> ChatSession | None:
    """Load the session by its PK. ``chat_sessions`` uses a String PK named
    ``id`` (the widget's ``session_xxx`` token), not a ``session_id`` column.

    ``for_update=True`` takes a row lock (``SELECT ... FOR UPDATE``) so the
    read-modify-write on ``quotation_state`` is serialized per session. Every
    handler here rewrites the whole JSONB blob (read dict → mutate → assign
    back), so two overlapping requests for the same session would otherwise
    clobber each other's update. The lock is held only for the (short) request
    transaction and is scoped to the single session row, so it never blocks
    other visitors."""
    stmt = select(ChatSession).where(
        ChatSession.id == session_id,
        ChatSession.bot_id == bot.id,
    )
    if for_update:
        stmt = stmt.with_for_update()
    return db.execute(stmt).scalars().first()


def _services_by_id(catalog: QuotationCatalog) -> dict[str, Service]:
    return {s.id: s for s in catalog.services}


def _public_services(catalog: QuotationCatalog) -> list[ServicePublic]:
    return [
        ServicePublic(
            id=s.id,
            name=s.name,
            description=s.description,
            requirement_count=len(s.requirements),
        )
        for s in catalog.services
    ]


def _compute_quote(catalog: QuotationCatalog, state: dict) -> tuple[list[QuoteLine], float]:
    """Build the quote from the visitor's selections. An ``item`` requirement
    contributes ``price × quantity``; a ``choice`` requirement contributes the
    picked option's ``price × quantity``. ``selected_requirements`` maps
    ``{service_id: {requirement_id: option_id | None}}`` — a key's presence
    means the requirement was selected; the value is the chosen option id for a
    choice, or None for a ticked item."""
    by_id = _services_by_id(catalog)
    selected: list[str] = state.get("selected_service_ids") or []
    chosen: dict = state.get("selected_requirements") or {}
    lines: list[QuoteLine] = []
    total = 0.0
    for sid in selected:
        service = by_id.get(sid)
        if not service:
            continue
        sel = chosen.get(sid) or {}
        # Tolerate the legacy list-of-ids shape (all treated as ticked items).
        if isinstance(sel, list):
            sel = {rid: None for rid in sel}
        for req in service.requirements:
            if req.id not in sel:
                continue
            raw = sel.get(req.id)
            # A selection value may be: a dict {"option", "qty"} (current), a
            # bare option-id string (legacy choice), or None (legacy item).
            if isinstance(raw, dict):
                option_id, visitor_qty = raw.get("option"), raw.get("qty")
            elif isinstance(raw, str):
                option_id, visitor_qty = raw, None
            else:
                option_id, visitor_qty = None, None

            if req.type == "choice":
                opt = next((o for o in req.options if o.id == option_id), None)
                if opt is None:
                    continue
                base_price, base_qty, label = opt.price, opt.quantity, f"{req.label}: {opt.label}"
            else:
                base_price, base_qty, label = req.price, req.quantity, req.label

            if req.quantity_mode == "ask":
                qty = int(visitor_qty or 0)
                if qty <= 0:
                    continue  # the visitor did not include this requirement
            elif req.quantity_mode == "fixed":
                qty = base_qty
            else:  # "none"
                qty = 1
            unit = req.unit_label if req.quantity_mode in ("fixed", "ask") else ""

            subtotal = round(base_price * qty, 2)
            total += subtotal
            lines.append(
                QuoteLine(
                    service_id=sid,
                    service_name=service.name,
                    requirement_id=req.id,
                    label=label,
                    quantity=qty,
                    unit_label=unit,
                    price=base_price,
                    subtotal=subtotal,
                )
            )
    return lines, round(total, 2)


def build_quotation_summary(bot: Bot, chat_session: ChatSession) -> dict | None:
    """Operator/lead-facing quotation summary for a session, or ``None`` when
    the visitor never entered the flow. Shared by the operator session-details
    endpoint and the lead-detail endpoint so both surfaces read identically —
    one line item per chosen requirement (with its service grouping) + running
    total, resolved against the bot's *current* catalog."""
    state = getattr(chat_session, "quotation_state", None) or {}
    if not state:
        return None

    catalog = _normalize(bot.quotation_catalog if bot else None)
    lines, total = _compute_quote(catalog, state)

    line_items = [
        {
            "service_id": line.service_id,
            "service_name": line.service_name,
            "requirement_id": line.requirement_id,
            "label": line.label,
            "quantity": line.quantity,
            "unit_label": line.unit_label,
            "price": line.price,
            "subtotal": line.subtotal,
        }
        for line in lines
    ]

    return {
        "status": state.get("status") or "idle",
        "currency": catalog.currency,
        "line_items": line_items,
        "total": total,
        "activated_at": state.get("activated_at"),
        "completed_at": state.get("completed_at"),
    }


def _send_quotation_owner_email(db, bot: Bot, session: ChatSession) -> None:
    """Notify the client's configured recipients with the full itemised quote
    (line items + total) plus the visitor's contact info. Sent **immediately**
    at accept so the owner learns of a fresh lead without delay. Reply-To is the
    visitor so the owner can reply straight to the lead. Best-effort: any
    failure is logged, never raised into the request path.
    """
    try:
        summary = build_quotation_summary(bot, session)
        if not summary or not summary.get("line_items"):
            return

        lead = get_lead_info_by_session(db, session.id)
        contact = {
            "name": getattr(lead, "name", None),
            "email": getattr(lead, "email", None),
            "phone": getattr(lead, "phone", None),
            "company": getattr(lead, "company", None),
        }

        bot_name = getattr(bot, "name", None) or "AI Assistant"
        visitor_email = (contact["email"] or "").strip() if contact["email"] else ""

        recipients = email_service.get_notification_recipients(bot, "quote")
        for addr in recipients:
            email_service.send_quotation_client_email(
                addr,
                bot_name,
                contact,
                summary["currency"],
                summary["line_items"],
                summary["total"],
                reply_to=visitor_email or None,
            )
    except Exception:
        logger.warning("Quotation owner-email dispatch failed (non-blocking)", exc_info=True)


def _unique_service_names(line_items: list[dict]) -> list[str]:
    """Distinct service names across the quote's line items, order-preserving."""
    names: list[str] = []
    seen: set[str] = set()
    for item in line_items or []:
        name = item.get("service_name")
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    return names


def _send_quotation_visitor_email(db, bot: Bot, session: ChatSession) -> None:
    """Confirm to the visitor that their quote request was received. Carries NO
    pricing — it only acknowledges the request. Sent **immediately** at accept;
    the priced "Your quotation" document follows ~10 min later. Reply-To routes
    back to the client. Best-effort: any failure is logged, never raised.
    """
    try:
        summary = build_quotation_summary(bot, session)
        if not summary or not summary.get("line_items"):
            return

        lead = get_lead_info_by_session(db, session.id)
        visitor_email = (getattr(lead, "email", None) or "").strip()
        if not visitor_email:
            return

        bot_name = getattr(bot, "name", None) or "AI Assistant"
        company_name = getattr(bot, "company_name", None) or bot_name
        client_reply_to = getattr(bot, "reply_to_email", None)
        service_names = _unique_service_names(summary["line_items"])
        email_service.send_quotation_visitor_email(
            visitor_email,
            company_name,
            getattr(lead, "name", None),
            service_names,
            reply_to=client_reply_to,
        )
    except Exception:
        logger.warning("Quotation visitor-email dispatch failed (non-blocking)", exc_info=True)


def _send_quotation_document_email(db, bot: Bot, session: ChatSession) -> None:
    """Send the visitor their finalized, priced quotation inline in the email.

    Deferred ~10 min after accept. Carries the full pricing (per-requirement
    quantity + subtotal + total) in the email body — no PDF attachment.
    Reply-To routes back to the client. Best-effort: any failure is logged,
    never raised.
    """
    try:
        summary = build_quotation_summary(bot, session)
        if not summary or not summary.get("line_items"):
            return

        lead = get_lead_info_by_session(db, session.id)
        visitor_email = (getattr(lead, "email", None) or "").strip()
        if not visitor_email:
            return

        bot_name = getattr(bot, "name", None) or "AI Assistant"
        company_name = getattr(bot, "company_name", None) or bot_name
        client_reply_to = getattr(bot, "reply_to_email", None)
        visitor_name = getattr(lead, "name", None)
        # The quotation is delivered inline in the email body — no PDF attachment.
        email_service.send_quotation_document_email(
            visitor_email,
            company_name,
            visitor_name,
            summary["currency"],
            summary["line_items"],
            summary["total"],
            reply_to=client_reply_to,
        )
    except Exception:
        logger.warning("Quotation document-email dispatch failed (non-blocking)", exc_info=True)


def dispatch_quotation_document_email_for_session(session_id: str, bot_id: int) -> None:
    """Re-load the bot + session on a fresh DB session and fire the priced
    "Your quotation" document email. Entry point for the deferred ARQ task
    ``task_send_quotation_visitor_email``, which runs ~10 minutes after the
    visitor accepts the quote.

    Loading fresh at send time (rather than closing over the request's ORM
    objects) means the email reflects the state as it stands 10 minutes later —
    a lead who added their phone in the meantime, say — and keeps the worker
    from touching a session bound to a long-closed request. Best-effort: a
    missing bot/session or any downstream failure is logged, never raised, so
    the ARQ job doesn't churn retries over an email side effect.
    """
    try:
        with get_session() as db:
            bot = db.get(Bot, bot_id)
            if bot is None:
                logger.warning("Quotation document-email dispatch: bot %s not found", bot_id)
                return
            session = _load_session(db, bot, session_id)
            if session is None:
                logger.warning("Quotation document-email dispatch: session %s not found for bot %s", session_id, bot_id)
                return
            _send_quotation_document_email(db, bot, session)
    except Exception:
        logger.warning(
            "Quotation document-email dispatch failed for session %s (non-blocking)", session_id, exc_info=True
        )


def _schedule_quotation_emails(db, bot: Bot, session: ChatSession) -> None:
    """Dispatch the three completion emails with their intended timing:

    * **Owner** — notified **immediately** with the full itemised quote so a
      fresh lead never waits.
    * **Visitor acknowledgement** ("Your quote request") — **immediately**, no
      pricing, so the visitor gets an instant "we got it".
    * **Visitor quotation** ("Your quotation", priced PDF) — deferred by
      ``QUOTATION_EMAIL_DELAY_SECONDS`` (default 10 min).

    The document-email delay is durable via ARQ when the worker is enabled so it
    survives an API restart. When the worker is disabled (local dev without a
    worker) there is no durable scheduler, so we fall back to sending the
    document email inline rather than dropping it — better an on-time email in
    dev than none. Best-effort throughout: neither send nor an enqueue blip may
    fail the accept the quote has already committed to.
    """
    # Owner + visitor acknowledgement: immediate.
    _send_quotation_owner_email(db, bot, session)
    _send_quotation_visitor_email(db, bot, session)

    # Visitor quotation document (priced PDF): deferred ~10 min.
    from app.worker.enqueue import WORKER_ENABLED, enqueue_sync

    if WORKER_ENABLED:
        try:
            enqueue_sync(
                "task_send_quotation_visitor_email",
                session.id,
                bot.id,
                _defer_by=timedelta(seconds=QUOTATION_EMAIL_DELAY_SECONDS),
            )
            return
        except Exception:
            logger.warning(
                "Failed to enqueue deferred quotation document email for session %s; sending inline",
                session.id,
                exc_info=True,
            )
    _send_quotation_document_email(db, bot, session)


def _choosing_view(catalog: QuotationCatalog, state: dict) -> ChoosingView | None:
    """The requirement checklist for the single selected service, or ``None``
    when the selected service is missing from the current catalog (e.g. an admin
    deleted it mid-flow)."""
    selected: list[str] = state.get("selected_service_ids") or []
    if not selected:
        return None
    sid = selected[0]
    service = _services_by_id(catalog).get(sid)
    if service is None:
        return None
    return ChoosingView(
        service_id=sid,
        name=service.name,
        description=service.description,
        requirements=[
            RequirementPublic(
                id=r.id,
                label=r.label,
                question=r.question,
                type=r.type,
                quantity_mode=r.quantity_mode,
                unit_label=r.unit_label,
                default_quantity=r.quantity,
                options=[RequirementOptionPublic(id=o.id, label=o.label) for o in r.options],
            )
            for r in service.requirements
        ],
    )


# ── Admin endpoints ──────────────────────────────────────────────────────────


@router.get("/bots/{bot_id}/quotation-catalog", response_model=QuotationCatalog)
def get_quotation_catalog(
    bot_id: int,
    client: Client = Depends(get_current_client_strict),
) -> QuotationCatalog:
    """Read the quotation catalog for a bot the caller owns."""
    with get_session() as db:
        bot = db.execute(select(Bot).where(Bot.id == bot_id, Bot.client_id == client.id)).scalars().first()
        if not bot:
            raise HTTPException(status_code=404, detail="bot_not_found")
        return _normalize(bot.quotation_catalog)


@router.put("/bots/{bot_id}/quotation-catalog", response_model=QuotationCatalog)
def put_quotation_catalog(
    bot_id: int,
    payload: QuotationCatalog,
    client: Client = Depends(get_current_client_strict),
) -> QuotationCatalog:
    """Replace the quotation catalog for a bot the caller owns.

    Gated to Professional+ plans. Sub-Professional callers get a 403 with
    ``plan_upgrade_required`` — the admin UI reads that to render an upgrade
    CTA instead of the editor.
    """
    with get_session() as db:
        bot = db.execute(select(Bot).where(Bot.id == bot_id, Bot.client_id == client.id)).scalars().first()
        if not bot:
            raise HTTPException(status_code=404, detail="bot_not_found")
        if not _client_plan_allows(client.id, db):
            raise HTTPException(status_code=403, detail="plan_upgrade_required")
        bot.quotation_catalog = payload.model_dump()
        db.commit()
        # Invalidate the bot-config Redis cache so the widget's next
        # ``get_current_bot`` refetches this row and sees the fresh
        # ``quotation_catalog``. Without this the widget keeps reading a
        # cached Bot with the pre-save catalog for the TTL window.
        cache_delete(bot_config_key(bot.bot_key))
        return payload


# ── Widget runtime endpoints ─────────────────────────────────────────────────


@router.get("/chat/quotation", response_model=QuotationStateOut)
def get_quotation_state(
    session_id: str = Query(min_length=1, max_length=200),
    bot: Bot = Depends(get_current_bot),
) -> QuotationStateOut:
    """Report whether the quotation flow should render right now, and what
    step to show.

    Trigger contract mirrors the qualification flow: disabled / empty / BANT
    below threshold / already terminal → ``active: false``. Otherwise flip
    the session to ``selecting`` on first activation and stream the current
    step through subsequent polls.
    """
    catalog = _normalize(bot.quotation_catalog)
    if not catalog.enabled or not catalog.services:
        return QuotationStateOut(active=False, currency=catalog.currency, services=[])

    with get_session() as db:
        # Locked: this GET conditionally activates the flow (idle → selecting),
        # so it participates in the same per-session write serialization as the
        # POST handlers below.
        session = _load_session(db, bot, session_id, for_update=True)
        if session is None:
            return QuotationStateOut(active=False, currency=catalog.currency, services=[])

        state = dict(session.quotation_state or {})
        status = state.get("status", "idle")

        if status in ("complete", "skipped"):
            lines, total = _compute_quote(catalog, state)
            return QuotationStateOut(
                active=False,
                status=status,
                currency=catalog.currency,
                services=_public_services(catalog),
                selected_service_ids=list(state.get("selected_service_ids") or []),
                quote=lines,
                total=total,
            )

        # Plan gate: quotation is Professional+. Silently inactive for lower
        # tiers so the widget just proceeds to the normal handoff form.
        if not _bot_plan_allows(bot, db):
            return QuotationStateOut(active=False, currency=catalog.currency, services=[])

        marked = _bant_marked_count(session, only=catalog.required_categories or None)
        if marked < catalog.effective_threshold():
            return QuotationStateOut(active=False, currency=catalog.currency, services=[])

        if status == "idle":
            state = {
                "status": "selecting",
                "selected_service_ids": [],
                "selected_requirements": {},
                "activated_at": datetime.now(UTC).isoformat(),
            }
            session.quotation_state = state
            db.commit()
            status = "selecting"

        if status == "selecting":
            return QuotationStateOut(
                active=True,
                status="selecting",
                currency=catalog.currency,
                services=_public_services(catalog),
                selected_service_ids=list(state.get("selected_service_ids") or []),
            )

        if status == "choosing":
            current = _choosing_view(catalog, state)
            if current is None:
                # Selected service vanished from the catalog — reset to selecting.
                state["selected_service_ids"] = []
                state["selected_requirements"] = {}
                state["status"] = "selecting"
                session.quotation_state = state
                db.commit()
                return QuotationStateOut(
                    active=True,
                    status="selecting",
                    currency=catalog.currency,
                    services=_public_services(catalog),
                )
            return QuotationStateOut(
                active=True,
                status="choosing",
                currency=catalog.currency,
                services=_public_services(catalog),
                selected_service_ids=list(state.get("selected_service_ids") or []),
                current=current,
            )

        if status == "quoting":
            lines, total = _compute_quote(catalog, state)
            return QuotationStateOut(
                active=True,
                status="quoting",
                currency=catalog.currency,
                services=_public_services(catalog),
                selected_service_ids=list(state.get("selected_service_ids") or []),
                quote=lines,
                total=total,
            )

        # Unknown status — degrade to inactive rather than 500.
        return QuotationStateOut(active=False, currency=catalog.currency, services=[])


@router.post("/chat/quotation/select-services", response_model=QuotationStateOut)
def select_services(payload: SelectServicesIn, bot: Bot = Depends(get_current_bot)) -> QuotationStateOut:
    """Persist the visitor's single service pick and move to the ``choosing``
    phase (the requirement checklist). An empty selection is treated as a skip.

    The visitor picks exactly one service (the widget is single-select); if the
    payload carries several ids we keep the first valid one.
    """
    catalog = _normalize(bot.quotation_catalog)
    if not catalog.enabled or not catalog.services:
        raise HTTPException(status_code=409, detail="quotation_disabled")

    valid_ids = {s.id for s in catalog.services}
    pick = next((sid for sid in (payload.service_ids or []) if sid in valid_ids), None)

    with get_session() as db:
        session = _load_session(db, bot, payload.session_id, for_update=True)
        if session is None:
            raise HTTPException(status_code=404, detail="session_not_found")

        state = dict(session.quotation_state or {})
        if state.get("status") in ("complete", "skipped"):
            raise HTTPException(status_code=409, detail="quotation_already_closed")

        if pick is None:
            state["status"] = "skipped"
            state["completed_at"] = datetime.now(UTC).isoformat()
            session.quotation_state = state
            db.commit()
            return QuotationStateOut(
                active=False,
                status="skipped",
                currency=catalog.currency,
                services=_public_services(catalog),
            )

        state["selected_service_ids"] = [pick]
        state["selected_requirements"] = {}
        state["status"] = "choosing"
        session.quotation_state = state
        db.commit()

        current = _choosing_view(catalog, state)
        return QuotationStateOut(
            active=True,
            status="choosing",
            currency=catalog.currency,
            services=_public_services(catalog),
            selected_service_ids=[pick],
            current=current,
        )


@router.post("/chat/quotation/requirements", response_model=QuotationStateOut)
def submit_requirements(payload: RequirementsIn, bot: Bot = Depends(get_current_bot)) -> QuotationStateOut:
    """Record the visitor's selections for their chosen service and move to
    ``quoting``. Each selection is a ticked ``item`` (no option_id) or a picked
    option on a ``choice``. An empty/invalid pick set is treated as a skip."""
    catalog = _normalize(bot.quotation_catalog)
    if not catalog.enabled or not catalog.services:
        raise HTTPException(status_code=409, detail="quotation_disabled")

    service = next((s for s in catalog.services if s.id == payload.service_id), None)
    if service is None:
        raise HTTPException(status_code=400, detail="unknown_service")

    reqs_by_id = {r.id: r for r in service.requirements}
    # requirement_id → {"option": <id|None>, "qty": <int|None>}. Presence == picked.
    picks: dict[str, dict] = {}
    for sel in payload.selections or []:
        req = reqs_by_id.get(sel.requirement_id)
        if req is None:
            continue
        # For an ``ask`` requirement, a quantity of 0 (or none) means the
        # visitor didn't include it — drop it rather than record a zero line.
        if req.quantity_mode == "ask" and not (sel.quantity and sel.quantity > 0):
            continue
        qty = int(sel.quantity) if (req.quantity_mode == "ask" and sel.quantity) else None
        if req.type == "choice":
            if sel.option_id and any(o.id == sel.option_id for o in req.options):
                picks[req.id] = {"option": sel.option_id, "qty": qty}
            # An optional choice with no valid option contributes nothing.
        else:
            picks[req.id] = {"option": None, "qty": qty}

    with get_session() as db:
        session = _load_session(db, bot, payload.session_id, for_update=True)
        if session is None:
            raise HTTPException(status_code=404, detail="session_not_found")

        state = dict(session.quotation_state or {})
        if state.get("status") in ("complete", "skipped"):
            raise HTTPException(status_code=409, detail="quotation_already_closed")
        if state.get("status") != "choosing":
            raise HTTPException(status_code=409, detail="quotation_not_choosing")

        if not picks:
            state["status"] = "skipped"
            state["completed_at"] = datetime.now(UTC).isoformat()
            session.quotation_state = state
            db.commit()
            return QuotationStateOut(
                active=False,
                status="skipped",
                currency=catalog.currency,
                services=_public_services(catalog),
                selected_service_ids=list(state.get("selected_service_ids") or []),
            )

        state["selected_service_ids"] = [payload.service_id]
        state["selected_requirements"] = {payload.service_id: picks}
        state["status"] = "quoting"
        session.quotation_state = state
        db.commit()

        lines, total = _compute_quote(catalog, state)
        return QuotationStateOut(
            active=True,
            status="quoting",
            currency=catalog.currency,
            services=_public_services(catalog),
            selected_service_ids=[payload.service_id],
            quote=lines,
            total=total,
        )


@router.post("/chat/quotation/accept", response_model=QuotationStateOut)
def accept_quote(payload: SkipIn, bot: Bot = Depends(get_current_bot)) -> QuotationStateOut:
    """Mark the quote accepted; widget then proceeds to handoff with the
    quote persisted on the session for the operator to see."""
    catalog = _normalize(bot.quotation_catalog)
    with get_session() as db:
        session = _load_session(db, bot, payload.session_id, for_update=True)
        if session is None:
            raise HTTPException(status_code=404, detail="session_not_found")

        state = dict(session.quotation_state or {})
        if state.get("status") in ("complete", "skipped"):
            lines, total = _compute_quote(catalog, state)
            return QuotationStateOut(
                active=False,
                status=state.get("status", "complete"),
                currency=catalog.currency,
                services=_public_services(catalog),
                selected_service_ids=list(state.get("selected_service_ids") or []),
                quote=lines,
                total=total,
            )

        state["status"] = "complete"
        state["completed_at"] = datetime.now(UTC).isoformat()
        session.quotation_state = state
        db.commit()
        lines, total = _compute_quote(catalog, state)
        # Notify the owner immediately (full itemised quote), acknowledge to the
        # visitor immediately ("Your quote request", no pricing), and defer the
        # priced "Your quotation" document (PDF) by ~10 min per spec.
        # Best-effort; the quote is already saved, so a dispatch/scheduling
        # failure must never fail the accept.
        _schedule_quotation_emails(db, bot, session)
        return QuotationStateOut(
            active=False,
            status="complete",
            currency=catalog.currency,
            services=_public_services(catalog),
            selected_service_ids=list(state.get("selected_service_ids") or []),
            quote=lines,
            total=total,
        )


@router.post("/chat/quotation/skip", response_model=QuotationStateOut)
def skip_quotation(payload: SkipIn, bot: Bot = Depends(get_current_bot)) -> QuotationStateOut:
    """Visitor escape hatch — end the flow immediately, preserving partial
    picks so the operator still sees what they chose."""
    catalog = _normalize(bot.quotation_catalog)
    with get_session() as db:
        session = _load_session(db, bot, payload.session_id, for_update=True)
        if session is None:
            raise HTTPException(status_code=404, detail="session_not_found")

        state = dict(session.quotation_state or {})
        if state.get("status") in ("complete", "skipped"):
            return QuotationStateOut(
                active=False,
                status=state.get("status", "skipped"),
                currency=catalog.currency,
                services=_public_services(catalog),
            )

        state["status"] = "skipped"
        state["completed_at"] = datetime.now(UTC).isoformat()
        session.quotation_state = state
        db.commit()
        return QuotationStateOut(
            active=False,
            status="skipped",
            currency=catalog.currency,
            services=_public_services(catalog),
            selected_service_ids=list(state.get("selected_service_ids") or []),
        )
