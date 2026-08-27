"""Admin CRUD + widget runtime for a bot's quotation catalog.

Two audiences:

* **Admin** (X-API-Key) reads and writes the bot's catalog — the ordered list
  of billable services, prices, and per-service questions — plus the BANT
  trigger that gates when the flow fires. The trigger is admin-configurable:
  ``required_categories`` picks which BANT dimensions (Need · Timeline ·
  Authority · Budget) count, and ``threshold`` sets how many must be marked.
  Empty ``required_categories`` means "any of the 4 counts" (default: any 2 of
  4). See ``QuotationCatalog.effective_threshold`` for the clamping rule.
* **Widget** (X-Bot-Key) drives the runtime state machine once the session's
  BANT signals cross the trigger:

    idle → selecting → answering → quoting → complete
                                          ↘ skipped

  ``selecting``: visitor picks which services they want a quote for.
  ``answering``: for each selected service, the bot walks its questions +
                 collects a quantity.
  ``quoting``:   the bot computes and shows the final quote card.
  ``complete`` / ``skipped``: the widget proceeds to handoff.

State lives on ``chat_sessions.quotation_state`` (JSONB). NULL is the
implicit idle state so legacy sessions cost nothing to migrate.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from app.api.auth import get_current_bot, get_current_client_strict
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
MAX_QUESTIONS_PER_SERVICE = 8
MAX_OPTIONS = 8
MAX_NAME = 120
MAX_DESCRIPTION = 500
MAX_UNIT_LABEL = 40
MAX_QUESTION_TEXT = 280
MAX_OPTION_TEXT = 120
MAX_ANSWER_LENGTH = 2000

VALID_QUESTION_TYPES = {"text", "choice", "number"}
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


class ServiceQuestion(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=MAX_QUESTION_TEXT)
    type: Literal["text", "choice", "number"] = "text"
    options: list[str] = Field(default_factory=list)
    required: bool = True

    @field_validator("options")
    @classmethod
    def _clean_options(cls, value: list[str]) -> list[str]:
        cleaned = [opt.strip() for opt in value if isinstance(opt, str) and opt.strip()]
        if len(cleaned) > MAX_OPTIONS:
            raise ValueError(f"at most {MAX_OPTIONS} options per question")
        for opt in cleaned:
            if len(opt) > MAX_OPTION_TEXT:
                raise ValueError(f"option too long (max {MAX_OPTION_TEXT} chars)")
        return cleaned


class Service(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=MAX_NAME)
    description: str = Field(default="", max_length=MAX_DESCRIPTION)
    unit_label: str = Field(default="unit", max_length=MAX_UNIT_LABEL)
    price_per_unit: float = Field(ge=0)
    default_quantity: int = Field(default=1, ge=0, le=100000)
    questions: list[ServiceQuestion] = Field(default_factory=list)

    @field_validator("questions")
    @classmethod
    def _validate_questions(cls, value: list[ServiceQuestion]) -> list[ServiceQuestion]:
        if len(value) > MAX_QUESTIONS_PER_SERVICE:
            raise ValueError(f"at most {MAX_QUESTIONS_PER_SERVICE} questions per service")
        seen: set[str] = set()
        for q in value:
            if q.id in seen:
                raise ValueError(f"duplicate question id: {q.id}")
            seen.add(q.id)
            if q.type == "choice" and not q.options:
                raise ValueError(f"choice question '{q.id}' needs at least one option")
        return value


class QuotationCatalog(BaseModel):
    """Admin config: services + BANT-based trigger.

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


class ServicePublic(BaseModel):
    id: str
    name: str
    description: str
    unit_label: str
    price_per_unit: float
    default_quantity: int
    question_count: int


class CurrentServiceView(BaseModel):
    id: str
    name: str
    description: str
    unit_label: str
    price_per_unit: float
    default_quantity: int
    question: dict | None = None  # None == time to collect quantity
    service_index: int
    service_total: int
    question_index: int
    question_total: int


class QuoteLine(BaseModel):
    service_id: str
    name: str
    unit_label: str
    price_per_unit: float
    quantity: int
    subtotal: float


class QuotationStateOut(BaseModel):
    active: bool
    status: Literal["idle", "selecting", "answering", "quoting", "complete", "skipped"] = "idle"
    currency: str = "INR"
    services: list[ServicePublic] = Field(default_factory=list)
    selected_service_ids: list[str] = Field(default_factory=list)
    current: CurrentServiceView | None = None
    quote: list[QuoteLine] = Field(default_factory=list)
    total: float = 0.0


class SelectServicesIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str = Field(min_length=1, max_length=200)
    service_ids: list[str] = Field(default_factory=list)


class AnswerIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str = Field(min_length=1, max_length=200)
    service_id: str = Field(min_length=1, max_length=40)
    question_id: str = Field(min_length=1, max_length=40)
    answer: str = Field(min_length=0, max_length=MAX_ANSWER_LENGTH)


class QuantityIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str = Field(min_length=1, max_length=200)
    service_id: str = Field(min_length=1, max_length=40)
    quantity: int = Field(ge=0, le=100000)


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
    ``id`` (the widget's ``session_xxx`` token), not a ``session_id`` column
    — the earlier version of this helper queried a non-existent column and
    silently returned None, which is why the quotation card never rendered.

    ``for_update=True`` takes a row lock (``SELECT ... FOR UPDATE``) so the
    read-modify-write on ``quotation_state`` is serialized per session. Every
    handler here rewrites the whole JSONB blob (read dict → mutate → assign
    back), so two overlapping requests for the same session — a poll racing a
    POST, or a retried request racing its original — would otherwise clobber
    each other's update and silently drop an answer or quote off a stale
    selection. The lock is held only for the (short) request transaction and is
    scoped to the single session row, so it never blocks other visitors."""
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
            unit_label=s.unit_label,
            price_per_unit=s.price_per_unit,
            default_quantity=s.default_quantity,
            question_count=len(s.questions),
        )
        for s in catalog.services
    ]


def _compute_quote(catalog: QuotationCatalog, state: dict) -> tuple[list[QuoteLine], float]:
    by_id = _services_by_id(catalog)
    quantities = state.get("quantities") or {}
    selected: list[str] = state.get("selected_service_ids") or []
    lines: list[QuoteLine] = []
    total = 0.0
    for sid in selected:
        service = by_id.get(sid)
        if not service:
            continue
        qty = int(quantities.get(sid, service.default_quantity) or 0)
        subtotal = round(service.price_per_unit * qty, 2)
        total += subtotal
        lines.append(
            QuoteLine(
                service_id=sid,
                name=service.name,
                unit_label=service.unit_label,
                price_per_unit=service.price_per_unit,
                quantity=qty,
                subtotal=subtotal,
            )
        )
    return lines, round(total, 2)


def build_quotation_summary(bot: Bot, chat_session: ChatSession) -> dict | None:
    """Operator/lead-facing quotation summary for a session, or ``None`` when
    the visitor never entered the flow. Shared by the operator session-details
    endpoint and the lead-detail endpoint so both surfaces read identically -
    itemised lines (with each service's per-question answers) + running total,
    resolved against the bot's *current* catalog (a since-edited/deleted
    service still shows via its id/name captured at answer time)."""
    state = getattr(chat_session, "quotation_state", None) or {}
    if not state:
        return None

    catalog = _normalize(bot.quotation_catalog if bot else None)
    lines, total = _compute_quote(catalog, state)
    by_id = _services_by_id(catalog)
    answers: dict = state.get("answers") or {}

    line_items = []
    for line in lines:
        service = by_id.get(line.service_id)
        question_defs = {q.id: q for q in service.questions} if service else {}
        service_answers = answers.get(line.service_id) or {}
        answer_rows = [
            {
                "question_id": qid,
                "question_text": question_defs[qid].text if qid in question_defs else qid,
                "answer": value,
            }
            for qid, value in service_answers.items()
        ]
        line_items.append(
            {
                "service_id": line.service_id,
                "name": line.name,
                "unit_label": line.unit_label,
                "price_per_unit": line.price_per_unit,
                "quantity": line.quantity,
                "subtotal": line.subtotal,
                "answers": answer_rows,
            }
        )

    return {
        "status": state.get("status") or "idle",
        "currency": catalog.currency,
        "line_items": line_items,
        "total": total,
        "activated_at": state.get("activated_at"),
        "completed_at": state.get("completed_at"),
    }


def _send_quotation_emails(db, bot: Bot, session: ChatSession) -> None:
    """Fire the visitor confirmation + client notification emails for a just
    completed quote. Best-effort: any failure is logged, never raised into the
    request path (the quote is already saved; email is a side effect).

    Two audiences, two contents:
    * **Visitor** — a no-pricing confirmation. The widget never shows visitors
      prices, so neither does their email; it only acknowledges the request.
    * **Client** — the itemised quote (line items + total) plus the visitor's
      contact info, sent to the bot's configured notification recipients.
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
        company_name = getattr(bot, "company_name", None) or bot_name
        client_reply_to = getattr(bot, "reply_to_email", None)
        visitor_email = (contact["email"] or "").strip() if contact["email"] else ""

        # Visitor confirmation (no pricing). Reply-To routes back to the client.
        if visitor_email:
            service_names = [item.get("name") for item in summary["line_items"]]
            email_service.send_quotation_visitor_email(
                visitor_email,
                company_name,
                contact["name"],
                service_names,
                reply_to=client_reply_to,
            )

        # Client notification (full itemised quote). Reply-To is the visitor so
        # the client can reply straight to the lead.
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
        logger.warning("Quotation email dispatch failed (non-blocking)", exc_info=True)


def _view_current(catalog: QuotationCatalog, state: dict) -> CurrentServiceView | None:
    """Report the current step for the ``answering`` status: either the next
    unanswered question for the current service, or ``question=None`` to
    signal "time to collect this service's quantity", or advance to the
    next selected service. Returns None when every selected service has
    completed its Q&A + quantity — the caller flips status to ``quoting``.
    """
    by_id = _services_by_id(catalog)
    selected: list[str] = state.get("selected_service_ids") or []
    if not selected:
        return None
    s_idx = int(state.get("current_service_index", 0) or 0)
    answers: dict = state.get("answers") or {}
    quantities: dict = state.get("quantities") or {}
    while s_idx < len(selected):
        sid = selected[s_idx]
        service = by_id.get(sid)
        if service is None:
            s_idx += 1
            continue
        service_answers = answers.get(sid, {})
        # Next unanswered question in this service.
        for q_idx, q in enumerate(service.questions):
            if q.id in service_answers:
                continue
            return CurrentServiceView(
                id=service.id,
                name=service.name,
                description=service.description,
                unit_label=service.unit_label,
                price_per_unit=service.price_per_unit,
                default_quantity=service.default_quantity,
                question={
                    "id": q.id,
                    "text": q.text,
                    "type": q.type,
                    "options": list(q.options),
                    "required": q.required,
                },
                service_index=s_idx,
                service_total=len(selected),
                question_index=q_idx,
                question_total=len(service.questions),
            )
        # All questions answered — need a quantity next.
        if sid not in quantities:
            return CurrentServiceView(
                id=service.id,
                name=service.name,
                description=service.description,
                unit_label=service.unit_label,
                price_per_unit=service.price_per_unit,
                default_quantity=service.default_quantity,
                question=None,
                service_index=s_idx,
                service_total=len(selected),
                question_index=len(service.questions),
                question_total=len(service.questions),
            )
        s_idx += 1
    return None


# Note: there is no persisted "advance service pointer" step — ``_view_current``
# walks past completed services on every fetch, so a hard refresh always lands
# on the same step without any extra bookkeeping.


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
        # Locked: this GET conditionally activates the flow (idle → selecting)
        # and advances answering → quoting, so it participates in the same
        # per-session write serialization as the POST handlers below.
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
                "current_service_index": 0,
                "answers": {},
                "quantities": {},
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

        if status == "answering":
            current = _view_current(catalog, state)
            if current is None:
                state["status"] = "quoting"
                session.quotation_state = state
                db.commit()
                status = "quoting"
            else:
                return QuotationStateOut(
                    active=True,
                    status="answering",
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
    """Persist the visitor's service picks and move to the ``answering`` phase.
    An empty selection is treated as a skip (nothing to quote for)."""
    catalog = _normalize(bot.quotation_catalog)
    if not catalog.enabled or not catalog.services:
        raise HTTPException(status_code=409, detail="quotation_disabled")

    valid_ids = {s.id for s in catalog.services}
    picks: list[str] = []
    seen: set[str] = set()
    for sid in payload.service_ids or []:
        if sid in valid_ids and sid not in seen:
            picks.append(sid)
            seen.add(sid)

    with get_session() as db:
        session = _load_session(db, bot, payload.session_id, for_update=True)
        if session is None:
            raise HTTPException(status_code=404, detail="session_not_found")

        state = dict(session.quotation_state or {})
        if state.get("status") in ("complete", "skipped"):
            raise HTTPException(status_code=409, detail="quotation_already_closed")

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
            )

        state["selected_service_ids"] = picks
        state["current_service_index"] = 0
        state.setdefault("answers", {})
        state.setdefault("quantities", {})
        state["status"] = "answering"
        session.quotation_state = state

        # If no selected service has any questions AND no quantities are
        # pending, jump straight to ``quoting`` — otherwise the widget would
        # poll an ``answering`` status with no current step.
        current = _view_current(catalog, state)
        if current is None:
            state["status"] = "quoting"
            session.quotation_state = state
            db.commit()
            lines, total = _compute_quote(catalog, state)
            return QuotationStateOut(
                active=True,
                status="quoting",
                currency=catalog.currency,
                services=_public_services(catalog),
                selected_service_ids=picks,
                quote=lines,
                total=total,
            )

        db.commit()
        return QuotationStateOut(
            active=True,
            status="answering",
            currency=catalog.currency,
            services=_public_services(catalog),
            selected_service_ids=picks,
            current=current,
        )


@router.post("/chat/quotation/answer", response_model=QuotationStateOut)
def submit_answer(payload: AnswerIn, bot: Bot = Depends(get_current_bot)) -> QuotationStateOut:
    """Record one per-service answer and return the next step."""
    catalog = _normalize(bot.quotation_catalog)
    if not catalog.enabled or not catalog.services:
        raise HTTPException(status_code=409, detail="quotation_disabled")

    service = next((s for s in catalog.services if s.id == payload.service_id), None)
    if service is None:
        raise HTTPException(status_code=400, detail="unknown_service")
    question = next((q for q in service.questions if q.id == payload.question_id), None)
    if question is None:
        raise HTTPException(status_code=400, detail="unknown_question")

    answer = (payload.answer or "").strip()
    if question.required and not answer:
        raise HTTPException(status_code=422, detail="answer_required")
    if question.type == "choice" and answer:
        # Choice questions are multi-select in the widget: the answer is a
        # comma-joined list of the options the visitor checked. Every part
        # must be one of the admin's configured options.
        selections = [part.strip() for part in answer.split(",") if part.strip()]
        if not selections or any(part not in question.options for part in selections):
            raise HTTPException(status_code=422, detail="answer_not_in_options")
    if question.type == "number" and answer:
        try:
            float(answer)
        except ValueError as e:
            raise HTTPException(status_code=422, detail="answer_not_a_number") from e

    with get_session() as db:
        session = _load_session(db, bot, payload.session_id, for_update=True)
        if session is None:
            raise HTTPException(status_code=404, detail="session_not_found")

        state = dict(session.quotation_state or {})
        if state.get("status") in ("complete", "skipped"):
            raise HTTPException(status_code=409, detail="quotation_already_closed")
        if state.get("status") != "answering":
            raise HTTPException(status_code=409, detail="quotation_not_answering")

        answers = dict(state.get("answers") or {})
        service_answers = dict(answers.get(payload.service_id) or {})
        service_answers[payload.question_id] = answer[:MAX_ANSWER_LENGTH]
        answers[payload.service_id] = service_answers
        state["answers"] = answers

        current = _view_current(catalog, state)
        if current is None:
            state["status"] = "quoting"
            session.quotation_state = state
            db.commit()
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

        state["current_service_index"] = current.service_index
        session.quotation_state = state
        db.commit()
        return QuotationStateOut(
            active=True,
            status="answering",
            currency=catalog.currency,
            services=_public_services(catalog),
            selected_service_ids=list(state.get("selected_service_ids") or []),
            current=current,
        )


@router.post("/chat/quotation/quantity", response_model=QuotationStateOut)
def submit_quantity(payload: QuantityIn, bot: Bot = Depends(get_current_bot)) -> QuotationStateOut:
    """Record the visitor's chosen quantity for the current service."""
    catalog = _normalize(bot.quotation_catalog)
    if not catalog.enabled or not catalog.services:
        raise HTTPException(status_code=409, detail="quotation_disabled")

    service = next((s for s in catalog.services if s.id == payload.service_id), None)
    if service is None:
        raise HTTPException(status_code=400, detail="unknown_service")

    with get_session() as db:
        session = _load_session(db, bot, payload.session_id, for_update=True)
        if session is None:
            raise HTTPException(status_code=404, detail="session_not_found")

        state = dict(session.quotation_state or {})
        if state.get("status") in ("complete", "skipped"):
            raise HTTPException(status_code=409, detail="quotation_already_closed")
        if state.get("status") != "answering":
            raise HTTPException(status_code=409, detail="quotation_not_answering")

        quantities = dict(state.get("quantities") or {})
        quantities[payload.service_id] = int(payload.quantity)
        state["quantities"] = quantities

        current = _view_current(catalog, state)
        if current is None:
            state["status"] = "quoting"
            session.quotation_state = state
            db.commit()
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

        state["current_service_index"] = current.service_index
        session.quotation_state = state
        db.commit()
        return QuotationStateOut(
            active=True,
            status="answering",
            currency=catalog.currency,
            services=_public_services(catalog),
            selected_service_ids=list(state.get("selected_service_ids") or []),
            current=current,
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
        # Notify the visitor (confirmation, no pricing) and the client (full
        # itemised quote). Non-blocking + best-effort; the quote is already
        # saved, so an email failure must never fail the accept.
        _send_quotation_emails(db, bot, session)
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
    answers and quantities so the operator still sees what they gave."""
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
