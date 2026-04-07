# OyeChats Qualify — Codex gpt-5.4 Execution Prompts

Run each prompt in order with:
```bash
codex exec --skip-git-repo-check -m gpt-5.4 --config model_reasoning_effort="high" --sandbox workspace-write --full-auto -C /Users/siddiqueahmed/Desktop/AI/oye-chats/platform "PROMPT" 2>/dev/null
```

---

# PHASE 1: Behavioral Scoring + Multi-CTA

---

## Step 1.1: Verify & Fix Phase 1A Backend

```
You are working on the OyeChats platform — a SaaS chatbot platform. The git repo is at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform with subdirectories: api/ (FastAPI backend), widget/ (React chat widget), app/ (React admin dashboard).

Phase 1A backend was partially implemented. Read and verify these 5 files are correct and consistent. Fix any bugs:

FILE 1: api/alembic/versions/0016_behavioral_scoring.py
- Must add columns to chat_sessions: behavioral_score (Integer, server_default="0"), page_url (String, nullable), referrer (String, nullable), utm_params (JSONB, nullable), visit_count (Integer, server_default="1")
- Must add column to bant_signals: source (String, server_default="llm")
- Must create visitor_events table with: id (PK), session_id (String FK to chat_sessions.id CASCADE), bot_id (Integer FK to bots.id CASCADE), event_type (String), event_data (JSONB), created_at (DateTime with timezone)
- Must have index ix_visitor_events_session_id
- Previous migration is 0015_bant_v2_scoring. Follow the exact same pattern as that file (imports, op usage, type annotations).

FILE 2: api/app/db/models.py
- ChatSession class must have: behavioral_score, page_url, referrer, utm_params, visit_count columns (BEFORE the BANT fields section)
- ChatSession must have relationship: visitor_events = relationship("VisitorEvent", back_populates="session", cascade="all, delete-orphan")
- BANTSignal class must have: source = Column(String, default="llm", server_default="llm", nullable=False) — AFTER score_after, BEFORE created_at
- VisitorEvent class must exist between BANTSignal and Department classes with: id, session_id (FK CASCADE, indexed), bot_id (FK CASCADE), event_type, event_data (JSONB), created_at, and relationships to ChatSession and Bot
- NOTE: There may also be a BotGrowthEvent model — do NOT remove it, it was added by another branch

FILE 3: api/app/services/behavioral_service.py
- Must export score_behavioral_signals(signals: dict, bot: Bot | None) -> int
- Default config: max_score=20, return_visit_score=5, utm_present_score=3, time_on_site_threshold=60, time_on_site_score=3, pages_viewed_threshold=3, pages_viewed_score=4, known_referrer_score=5
- known_referrers list: google.com, linkedin.com, facebook.com, twitter.com, x.com, bing.com, youtube.com, github.com, producthunt.com, g2.com, capterra.com
- Config overridable via bot.bant_config["behavioral_config"]
- Must have get_behavioral_config(bot) and _normalize_referrer(referrer) helpers

FILE 4: api/app/services/lead_service.py
- calculate_lead_score(session) must return min(bant_score + behavioral_score, 100) — use getattr(session, "behavioral_score", 0) for backward compat
- build_lead_response() must include "bant_score", "behavioral_score", and "behavioral" dict with page_url, referrer, utm_params, visit_count in the returned dict
- The composite "score" field must be min(bant_score + behavioral_score, 100)

FILE 5: api/app/api/chat_routes.py
- Must have BehavioralSignalsRequest pydantic model with: session_id (str), page_url (str|None), referrer (str|None), utm_params (dict|None), time_on_page (float|None), pages_viewed (int|None), is_return_visit (bool=False)
- Must have POST /chat/behavioral-signals endpoint that: ensures session exists, stores page context (first-call-wins for URL/referrer), records VisitorEvent entries, computes behavioral score via score_behavioral_signals(), only upgrades score (never downgrades), commits and returns {success, behavioral_score}
- The endpoint must import VisitorEvent from models and score_behavioral_signals from behavioral_service INSIDE the function (lazy import pattern used elsewhere)

After verifying/fixing, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check app/db/models.py app/services/behavioral_service.py app/services/lead_service.py app/api/chat_routes.py alembic/versions/0016_behavioral_scoring.py && uv run ruff format app/db/models.py app/services/behavioral_service.py app/services/lead_service.py app/api/chat_routes.py alembic/versions/0016_behavioral_scoring.py"

Fix any lint/format issues.
```

---

## Step 1.2: Widget API — Behavioral Signal Functions

```
You are working on OyeChats widget at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/widget/.

Read widget/src/services/api.js. This file has all widget-to-backend API calls. It uses:
- const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com'
- getHeaders() returns {'Content-Type':'application/json', 'X-Bot-Key': window.OYECHATS_BOT_KEY} or 'X-API-Key' fallback
- All functions are async exports using fetch()

Add these 3 new exported functions BEFORE the getChatbotSettings function (around line 254):

1. collectPageContext() — synchronous, no async needed:
   - Reads window.location.href as page_url
   - Reads document.referrer as referrer
   - Parses URLSearchParams for utm_source, utm_medium, utm_campaign, utm_content, utm_term
   - Detects return visit: checks localStorage key "oyechats_visitor_{botKey}" where botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || 'default'. If exists, is_return_visit=true. If not, sets it to Date.now().toString()
   - Tracks pages_viewed: increments sessionStorage key "oyechats_pages_{botKey}"
   - Returns { page_url, referrer, utm_params (null if empty), is_return_visit, pages_viewed, _load_time: performance.now() }

2. sendBehavioralSignals(sessionId, signals) — async, fire-and-forget:
   - POST to ${API_URL}/chat/behavioral-signals with getHeaders()
   - Body: { session_id: sessionId, page_url, referrer, utm_params, time_on_page, pages_viewed, is_return_visit } from signals
   - Catch errors silently with console.warn('[OyeChats] Behavioral signals error:', error)
   - Do NOT throw — this must never block chat

3. sendTimeOnPage(sessionId, loadTime) — sync-ish, for page unload:
   - Calculate timeOnPage = (performance.now() - loadTime) / 1000
   - If timeOnPage < 1, return early
   - Get pages_viewed from sessionStorage key "oyechats_pages_{botKey}"
   - Use fetch with keepalive:true to POST /chat/behavioral-signals (this survives page unload)
   - Wrap in try/catch, no error propagation

After changes, run: cd widget && npm run lint
Fix any lint errors.
```

---

## Step 1.3: Widget ChatWindow — Behavioral Integration

```
You are working on OyeChats widget at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/widget/.

Read widget/src/components/ChatWindow.jsx (large file, ~1100 lines). Make these precise changes:

CHANGE 1 — Import (line ~3):
Current: import { sendMessageStream, getChatHistory, submitLeadCapture, requestHandoff, getLeadInfo, submitOfflineMessage } from '../services/api';
Add to imports: collectPageContext, sendBehavioralSignals, sendTimeOnPage

CHANGE 2 — Add refs (after line ~146 where handoffTriggeredRef is declared):
Add these two lines:
const pageContextRef = useRef(null);
const behavioralSentRef = useRef(false);

CHANGE 3 — Add useEffect for page context (AFTER the initialization useEffect that ends around line ~229 with "}, []);"):
Add this new useEffect:
useEffect(() => {
    pageContextRef.current = collectPageContext();
    const handleUnload = () => {
        const sid = sessionId || localStorage.getItem('chat_session_id');
        if (sid && pageContextRef.current) {
            sendTimeOnPage(sid, pageContextRef.current._load_time);
        }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
}, [sessionId]);

CHANGE 4 — Send behavioral signals in handleSend (inside the onMetadata callback, around line ~430):
Find this existing code block:
    onMetadata: (metadata) => {
        if (metadata.session_id && metadata.session_id !== sessionId) {
            setSessionId(metadata.session_id);
            localStorage.setItem('chat_session_id', metadata.session_id);
        }
    },
ADD after the localStorage.setItem line (but still inside onMetadata):
    // Send behavioral signals once per conversation
    const resolvedSid = metadata.session_id || sessionId;
    if (resolvedSid && !behavioralSentRef.current && pageContextRef.current) {
        behavioralSentRef.current = true;
        sendBehavioralSignals(resolvedSid, pageContextRef.current);
    }

CHANGE 5 — Reset behavioral ref in handleNewChat (around line ~361):
Find the handleNewChat function. After the line "handoffFormInjectedRef.current = false;" add:
    behavioralSentRef.current = false;
    pageContextRef.current = collectPageContext();

After all changes, run: cd widget && npm run lint && npm run build
Fix any lint or build errors.
```

---

## Step 1.4: Multi-CTA Backend — rag_service.py

```
You are working on OyeChats backend at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/api/.

Read api/app/services/rag_service.py. Find the CTA instruction section (around lines 345-400). The current code:

1. Lines 349-355: Builds missing_dims list for dimensions with score == 0
2. Lines 360-365: Builds cta_dims list from missing_dims where cta_enabled is True
3. Lines 367-377: Builds cta_instruction string with text:
   "CTA MARKER (INTERNAL — invisible to user):
   If you ask a qualifying question, append the marker [CTA:dimension_name] at the very end
   of your response (e.g., [CTA:timeline]). This marker will be stripped before showing to
   the visitor. Only include ONE [CTA:] marker per response, only for a dimension with
   score 0, and only for these CTA-enabled dimensions:"

Make these changes:

CHANGE 1 — Line 354: Change the condition for adding to missing_dims from "score == 0" to "score < 15":
Before: if score == 0:
After:  if score < 15:

CHANGE 2 — Lines 370-376: Update the CTA instruction text. Replace:
"Only include ONE [CTA:] marker per response, only for a dimension with
score 0, and only for these CTA-enabled dimensions:"
With:
"Only include ONE [CTA:] marker per response, only for CTA-enabled dimensions
that have not been fully assessed yet (score below 15). These are the eligible dimensions:"

Do NOT change the _CTA_PATTERN regex, _strip_cta_marker function, or any other code. Only the two changes above.

After changes, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check app/services/rag_service.py && uv run ruff format app/services/rag_service.py"
Fix any issues.
```

---

## Step 1.5: Multi-CTA Widget — ChatWindow.jsx

```
You are working on OyeChats widget at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/widget/.

Read widget/src/components/ChatWindow.jsx. Make these 3 changes for multi-CTA support:

CHANGE 1 — Add new ref (around line 99):
Find: const ctaShownRef = useRef(false);
Add AFTER it: const ctaDimensionsShownRef = useRef(new Set());

CHANGE 2 — Update CTA gate in onFinalMetadata (around line 477):
Find this exact code:
    if (finalMeta.cta && !ctaShownRef.current) {
        ctaShownRef.current = true;
        setActiveCTA(finalMeta.cta);
    }
Replace with:
    if (finalMeta.cta) {
        const dim = finalMeta.cta.dimension;
        if (!dim || !ctaDimensionsShownRef.current.has(dim)) {
            if (dim) ctaDimensionsShownRef.current.add(dim);
            setActiveCTA(finalMeta.cta);
        }
    }

CHANGE 3 — Reset new ref in handleNewChat (around line 361):
Find the handleNewChat function. After the existing line "handoffFormInjectedRef.current = false;" (and after the behavioral refs reset if present), add:
    ctaDimensionsShownRef.current = new Set();

After changes, run: cd widget && npm run lint && npm run build
Fix any lint or build errors.
```

---

## Step 1.6: Admin Dashboard — Behavioral Score in Leads Page

```
You are working on OyeChats admin dashboard at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/app/.

Read app/src/pages/Leads.jsx (~392 lines). This page shows a leads table and a slide-in detail drawer.

CHANGE 1 — Score tooltip in table (around line 203):
Find: <span className="text-[12px] font-bold text-secondary-700">{lead.score}</span>
Replace with: <span className="text-[12px] font-bold text-secondary-700" title={`BANT: ${lead.bant_score ?? lead.score}${lead.behavioral_score ? ' + Behavioral: ' + lead.behavioral_score : ''}`}>{lead.score}</span>

CHANGE 2 — Behavioral Signals section in drawer (around line 330, AFTER the Evidence Trail section which ends around line 348):
Find the closing </div> of the Evidence Trail section (the one with "max-h-48 overflow-y-auto"). After the entire BANT Qualification + Evidence Trail block, add this new section:

{(leadDetail.behavioral_score > 0 || leadDetail.behavioral?.page_url) && (
    <div className="space-y-3">
        <h3 className="text-[13px] font-bold uppercase tracking-wider text-secondary-500">Behavioral Signals</h3>
        <div className="bg-secondary-50 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-secondary-600">Engagement Score</span>
                <span className="text-[12px] font-bold">{leadDetail.behavioral_score || 0}/20</span>
            </div>
            <div className="w-full bg-secondary-200 rounded-full h-1.5">
                <div
                    className={`h-1.5 rounded-full transition-all ${
                        (leadDetail.behavioral_score || 0) >= 15
                            ? 'bg-green-500'
                            : (leadDetail.behavioral_score || 0) >= 8
                              ? 'bg-blue-500'
                              : 'bg-amber-400'
                    }`}
                    style={{ width: `${Math.min(((leadDetail.behavioral_score || 0) / 20) * 100, 100)}%` }}
                />
            </div>
            {leadDetail.behavioral?.page_url && (
                <div className="flex items-start gap-2 text-[12px]">
                    <span className="text-secondary-400 shrink-0">Page:</span>
                    <span className="text-secondary-700 break-all">
                        {leadDetail.behavioral.page_url.length > 80
                            ? leadDetail.behavioral.page_url.substring(0, 80) + '...'
                            : leadDetail.behavioral.page_url}
                    </span>
                </div>
            )}
            {leadDetail.behavioral?.referrer && (
                <div className="flex items-start gap-2 text-[12px]">
                    <span className="text-secondary-400 shrink-0">Referrer:</span>
                    <span className="text-secondary-700 break-all">
                        {leadDetail.behavioral.referrer.length > 80
                            ? leadDetail.behavioral.referrer.substring(0, 80) + '...'
                            : leadDetail.behavioral.referrer}
                    </span>
                </div>
            )}
            {leadDetail.behavioral?.utm_params && Object.keys(leadDetail.behavioral.utm_params).length > 0 && (
                <div className="text-[12px]">
                    <span className="text-secondary-400">UTM:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                        {Object.entries(leadDetail.behavioral.utm_params).map(([k, v]) => (
                            <span key={k} className="px-2 py-0.5 bg-white border border-secondary-200 rounded text-[10px] text-secondary-600">
                                {k}: {v}
                            </span>
                        ))}
                    </div>
                </div>
            )}
            {(leadDetail.behavioral?.visit_count || 0) > 1 && (
                <div className="flex items-center gap-2 text-[12px]">
                    <span className="text-secondary-400">Return visitor:</span>
                    <span className="text-secondary-700">{leadDetail.behavioral.visit_count} visits</span>
                </div>
            )}
        </div>
    </div>
)}

After changes, run: cd app && npm run lint && npm run build
Fix any lint or build errors. Light theme only — no dark mode classes.
```

---

## Step 1.7: Phase 1 Final Verification

```
Run all checks for Phase 1 changes across the OyeChats monorepo at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/:

1. Backend lint + format:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check . && uv run ruff format --check ."

2. Widget lint + build:
cd widget && npm run lint && npm run build

3. Admin dashboard lint + build:
cd app && npm run lint && npm run build

Fix ANY failures. Report results for each check.
```

---

# PHASE 2: Webhook/Event System

---

## Step 2.1: Webhook DB Migration + Models

```
You are working on OyeChats backend at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/api/.

TASK: Create the Alembic migration and SQLAlchemy models for the webhook system.

FILE 1 — Create api/alembic/versions/0017_webhook_system.py:
Follow the exact pattern of api/alembic/versions/0015_bant_v2_scoring.py (read it first for style reference). Previous migration is 0016_behavioral_scoring.

Create two tables:

Table "webhooks":
- id: Integer, PK, autoincrement
- bot_id: Integer, FK to bots.id CASCADE, nullable=False, indexed
- url: String, nullable=False
- secret: String, nullable=False (auto-generated HMAC key)
- events: JSONB, nullable=False, server_default='[]' (array of event type strings)
- is_active: Boolean, nullable=False, server_default="true"
- created_at: DateTime(timezone=True), server_default=func.now()
- updated_at: DateTime(timezone=True), server_default=func.now()

Table "webhook_deliveries":
- id: Integer, PK, autoincrement
- webhook_id: Integer, FK to webhooks.id CASCADE, nullable=False, indexed
- event_type: String, nullable=False
- payload: JSONB, nullable=False
- status_code: Integer, nullable=True
- response_body: Text, nullable=True
- attempt: Integer, nullable=False, server_default="1"
- next_retry_at: DateTime(timezone=True), nullable=True
- created_at: DateTime(timezone=True), server_default=func.now()
- delivered_at: DateTime(timezone=True), nullable=True

FILE 2 — Update api/app/db/models.py:
Add two new model classes BEFORE the Department class:

class Webhook(Base):
    __tablename__ = "webhooks"
    - All columns matching the migration above
    - Relationships: bot = relationship("Bot"), deliveries = relationship("WebhookDelivery", back_populates="webhook", cascade="all, delete-orphan")

class WebhookDelivery(Base):
    __tablename__ = "webhook_deliveries"
    - All columns matching the migration above
    - Relationship: webhook = relationship("Webhook", back_populates="deliveries")

Also add to Bot class relationships: webhooks = relationship("Webhook", back_populates="bot", cascade="all, delete-orphan")

After changes, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check app/db/models.py alembic/versions/0017_webhook_system.py && uv run ruff format app/db/models.py alembic/versions/0017_webhook_system.py"
```

---

## Step 2.2: Webhook Service — Core Logic

```
You are working on OyeChats backend at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/api/.

TASK: Create api/app/services/webhook_service.py — the core webhook dispatch and retry logic.

Read api/app/core/thread_pool.py first — it has submit_background(fn, *args, **kwargs) for fire-and-forget background work with a ThreadPoolExecutor(max_workers=3).

Read api/app/db/session.py — it has get_session() context manager for DB access.

Create api/app/services/webhook_service.py with:

IMPORTS: hashlib, hmac, json, logging, time, urllib.request, datetime (UTC), secrets, select from sqlalchemy, get_session from app.db.session, submit_background from app.core.thread_pool, Webhook, WebhookDelivery from app.db.models

CONSTANTS:
- SUPPORTED_EVENTS = ["tier_transition", "lead_captured", "handoff_requested", "chat_closed", "meeting_booked"]
- _MAX_RETRIES = 4
- _RETRY_DELAYS = [30, 120, 600, 3600]  # seconds: 30s, 2m, 10m, 1h
- _DELIVERY_TIMEOUT = 10  # seconds

FUNCTIONS:

1. generate_webhook_secret() -> str:
   Return secrets.token_hex(32)

2. sign_payload(payload_bytes: bytes, secret: str) -> str:
   Return hmac.new(secret.encode(), payload_bytes, hashlib.sha256).hexdigest()

3. fire_webhook(bot_id: int, event_type: str, data: dict) -> None:
   """Fire-and-forget: dispatch webhooks for bot_id matching event_type."""
   - Validate event_type in SUPPORTED_EVENTS
   - Open get_session(), query active Webhook records where bot_id matches and events JSONB contains event_type
   - For each matching webhook, call submit_background(_deliver_webhook, webhook.id, event_type, data)

4. _deliver_webhook(webhook_id: int, event_type: str, data: dict, attempt: int = 1) -> None:
   """Deliver a single webhook — called in background thread."""
   - Open get_session(), load Webhook by id
   - Build payload dict: {"event": event_type, "bot_id": webhook.bot_id, "timestamp": datetime.now(UTC).isoformat(), "data": data}
   - JSON encode payload, sign with sign_payload(payload_bytes, webhook.secret)
   - POST to webhook.url using urllib.request.Request with headers: Content-Type: application/json, X-OyeChats-Signature: sha256={signature}
   - Set timeout to _DELIVERY_TIMEOUT
   - Create WebhookDelivery record with: webhook_id, event_type, payload (as dict), status_code, response_body (first 1000 chars), attempt, delivered_at=now on success
   - On failure (any exception): create WebhookDelivery with status_code=0, attempt, and if attempt < _MAX_RETRIES, set next_retry_at = now + _RETRY_DELAYS[attempt-1] seconds
   - Commit the delivery record

5. process_pending_retries() -> int:
   """Process any pending webhook retries. Called on app startup."""
   - Open get_session(), query WebhookDelivery where next_retry_at <= now AND delivered_at IS NULL AND attempt < _MAX_RETRIES
   - For each pending delivery, submit_background(_deliver_webhook, delivery.webhook_id, delivery.event_type, delivery.payload, delivery.attempt + 1)
   - Set delivery.next_retry_at = None (to prevent double-processing)
   - Return count of retries queued

After creating, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check app/services/webhook_service.py && uv run ruff format app/services/webhook_service.py"
```

---

## Step 2.3: Webhook API Routes

```
You are working on OyeChats backend at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/api/.

TASK: Create api/app/api/webhook_routes.py — CRUD endpoints for webhook management.

Read api/app/api/bot_routes.py first for the auth pattern — it uses get_current_client_or_operator dependency which returns {"client_id": int, ...}. Read api/app/api/lead_routes.py for query patterns.

Create api/app/api/webhook_routes.py with:

Router: APIRouter(prefix="/webhooks", tags=["webhooks"])

Pydantic Models:
- CreateWebhookRequest: url (str), events (list[str]), is_active (bool = True)
- UpdateWebhookRequest: url (str | None), events (list[str] | None), is_active (bool | None)

Endpoints (all require auth via get_current_client_or_operator, scoped to client's bots):

1. GET /webhooks?bot_id={int}
   - List all webhooks for the bot (verify bot belongs to client)
   - Return: list of {id, bot_id, url, events, is_active, secret (masked: first 8 chars + "..."), created_at}

2. POST /webhooks?bot_id={int}
   - Create webhook with auto-generated secret via generate_webhook_secret()
   - Validate events against SUPPORTED_EVENTS
   - Return: {id, url, events, secret (FULL — only shown once), is_active, created_at}

3. PATCH /webhooks/{webhook_id}
   - Update url, events, is_active (partial update)
   - Verify webhook belongs to client's bot
   - Return: {success: True}

4. DELETE /webhooks/{webhook_id}
   - Delete webhook (verify ownership)
   - Return: {success: True}

5. GET /webhooks/{webhook_id}/deliveries?page=1&limit=50
   - Paginated delivery log for a webhook
   - Return: {deliveries: [{id, event_type, status_code, attempt, created_at, delivered_at, next_retry_at}], total, page, limit}

6. POST /webhooks/{webhook_id}/test
   - Send a test event with sample data via fire_webhook
   - Return: {success: True, message: "Test event dispatched"}

Then update api/app/main.py — find where routers are registered (look for app.include_router calls). Add:
from app.api.webhook_routes import router as webhook_router
app.include_router(webhook_router) in the same section as other routers.

Also in main.py, in the startup event handler, add a call to process_pending_retries():
from app.services.webhook_service import process_pending_retries
process_pending_retries()

After changes, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check app/api/webhook_routes.py app/main.py && uv run ruff format app/api/webhook_routes.py app/main.py"
```

---

## Step 2.4: Wire Webhooks into Tier Transitions + Lead Capture

```
You are working on OyeChats backend at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/api/.

TASK: Fire webhooks on tier transitions and lead capture events.

FILE 1 — api/app/services/rag_service.py:
Find the _background_bant_extraction function (or _background_qualification_extraction if renamed). Find where it detects tier transitions — look for code comparing old_tier and new_tier, near where send_qualified_lead_email is called (around line ~297-317).

AFTER the email notification block, add:
from app.services.webhook_service import fire_webhook
fire_webhook(bot.id, "tier_transition", {
    "session_id": session_id,
    "old_tier": old_tier,
    "new_tier": new_tier,
    "score": chat_session.bant_score,
    "behavioral_score": getattr(chat_session, "behavioral_score", 0),
})

Use a try/except around the fire_webhook call so it never breaks the extraction flow. Log warnings on failure.

FILE 2 — api/app/api/chat_routes.py:
Find the lead_capture_endpoint function (POST /chat/lead-capture). AFTER the successful commit (after logger.info("Lead captured...")), add:

try:
    from app.services.webhook_service import fire_webhook
    fire_webhook(bot.id, "lead_captured", {
        "session_id": body.session_id,
        "name": body.name,
        "email": body.email,
        "phone": body.phone,
        "company": body.company,
    })
except Exception as wh_err:
    logger.warning(f"Webhook dispatch failed (non-blocking): {wh_err}")

After changes, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check app/services/rag_service.py app/api/chat_routes.py && uv run ruff format app/services/rag_service.py app/api/chat_routes.py"
```

---

## Step 2.5: Webhook Admin UI — Page + API Client

```
You are working on OyeChats admin dashboard at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/app/.

TASK: Create the Webhooks management page and wire up API calls.

Read these files first for patterns:
- app/src/pages/Settings.jsx — toggle switches, optimistic updates, section layout
- app/src/services/api.js — API client pattern with buildApiError, axios interceptors
- app/src/components/ui/PageHeader.jsx, Tabs.jsx — reusable UI components
- app/src/App.jsx — route registration pattern
- app/src/layouts/Sidebar.jsx — navigation items

FILE 1 — app/src/services/api.js:
Add these API functions following the existing pattern (async, try/catch, buildApiError):
- getWebhooks(botId) — GET /webhooks?bot_id={botId}
- createWebhook(botId, data) — POST /webhooks?bot_id={botId} with body data
- updateWebhook(webhookId, data) — PATCH /webhooks/{webhookId}
- deleteWebhook(webhookId) — DELETE /webhooks/{webhookId}
- getWebhookDeliveries(webhookId, page=1) — GET /webhooks/{webhookId}/deliveries?page={page}&limit=50
- testWebhook(webhookId) — POST /webhooks/{webhookId}/test

FILE 2 — Create app/src/pages/Webhooks.jsx:
Build a webhook management page with two tabs: "Webhooks" and "Delivery Log"

Webhooks tab:
- List of webhooks showing: URL (truncated), active events as badges, toggle switch for is_active, Edit and Delete buttons
- "Add Webhook" button opens a modal with: URL input, event type checkboxes (tier_transition, lead_captured, handoff_requested, chat_closed, meeting_booked), Save button
- After creation, show the webhook secret in a read-only input with a Copy button and a warning "Save this secret — it won't be shown again"
- "Test" button on each webhook that calls testWebhook and shows a success/error toast

Delivery Log tab:
- Table showing: event_type, status_code (green for 2xx, red for others), attempt count, created_at, delivered_at or "Pending retry"
- Pagination at bottom
- Webhook selector dropdown to filter by webhook

Use existing UI patterns: PageHeader, Tabs from components/ui/, useBotContext() for selected bot, useToast() for notifications. Light theme only. Follow the Settings.jsx card/section pattern.

FILE 3 — app/src/App.jsx:
Add route: <Route path="/webhooks" element={<ClientOnlyPage pageName="Webhooks"><Webhooks /></ClientOnlyPage>} />
Add the import at the top: const Webhooks = lazy(() => import('./pages/Webhooks'));

FILE 4 — app/src/layouts/Sidebar.jsx:
Find the navigation items array (mainItems for non-operator). Add after the Qualification item:
{ path: '/webhooks', name: 'Webhooks', icon: Webhook }
Import Webhook icon from lucide-react. If Webhook icon doesn't exist, use Link2 or Globe instead.

After all changes, run: cd app && npm run lint && npm run build
Fix any errors.
```

---

## Step 2.6: Phase 2 Final Verification

```
Run all checks for Phase 2 webhook system at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/:

1. conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check . && uv run ruff format --check ."
2. cd widget && npm run lint && npm run build
3. cd app && npm run lint && npm run build

Fix ANY failures. Report results.
```

---

# PHASE 3: Custom Qualification Frameworks

---

## Step 3.1: Framework DB Migration + Models

```
You are working on OyeChats backend at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/api/.

Read api/alembic/versions/0015_bant_v2_scoring.py for migration style reference.
Read api/app/db/models.py for current ChatSession model.

TASK: Create migration and update models for custom qualification frameworks.

FILE 1 — Create api/alembic/versions/0018_custom_frameworks.py:
Previous migration: 0017_webhook_system

Add to chat_sessions:
- dimension_scores: JSONB, nullable=True (stores {dim_name: {score: int, value: str}})
- qualification_framework: String, nullable=False, server_default="bant"

Data migration: backfill dimension_scores from existing bant_* columns:
UPDATE chat_sessions SET dimension_scores = jsonb_build_object(
    'need', jsonb_build_object('score', bant_need_score, 'value', COALESCE(bant_need, '')),
    'budget', jsonb_build_object('score', bant_budget_score, 'value', COALESCE(bant_budget, '')),
    'authority', jsonb_build_object('score', bant_authority_score, 'value', COALESCE(bant_authority, '')),
    'timeline', jsonb_build_object('score', bant_timeline_score, 'value', COALESCE(bant_timeline, ''))
) WHERE bant_score > 0;

FILE 2 — Update api/app/db/models.py ChatSession class:
Add after bant_last_updated:
- dimension_scores = Column(JSONB, nullable=True)
- qualification_framework = Column(String, default="bant", server_default="bant", nullable=False)

After changes, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check app/db/models.py alembic/versions/0018_custom_frameworks.py && uv run ruff format app/db/models.py alembic/versions/0018_custom_frameworks.py"
```

---

## Step 3.2: Qualification Service — Framework Abstraction

```
You are working on OyeChats backend at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/api/.

Read api/app/services/lead_service.py for existing BANT config and scoring logic.

TASK: Create api/app/services/qualification_service.py — framework-agnostic qualification logic.

This service abstracts the hardcoded BANT logic to support any N-dimension framework.

PRESET_FRAMEWORKS dict with 4 presets:
- "bant": 4 dimensions (need, timeline, authority, budget) — copy existing DEFAULT_BANT_CONFIG structure from lead_service.py
- "meddic": 6 dimensions (metrics, economic_buyer, decision_criteria, decision_process, identify_pain, champion) — each with weight ~17, 5 options scored 4/8/12/17/21
- "champ": 4 dimensions (challenges, authority, money, prioritization) — each weight 25, 5 options scored 5/10/15/20/25
- "gpctba_ci": 7 dimensions (goals, plans, challenges, timeline, budget, authority, consequences) — each weight ~14, 4 options scored 4/8/11/14

Each dimension has: enabled, weight, options [{label, score}], cta_enabled, cta_prompt

Functions:
1. get_framework_config(bot) -> dict: Returns merged config. Reads bot.bant_config, determines framework from bot's qualification_framework or defaults to "bant". Merges preset with bot overrides.

2. calculate_composite_score(dimension_scores: dict, framework_config: dict) -> int: Weighted sum normalized to 0-100. For each dimension in dimension_scores, multiply score by (weight/max_weight). Sum all. Cap at 100.

3. get_tier(score: int, thresholds: dict | None = None) -> str: Same logic as existing get_lead_tier in lead_service.py.

4. build_qualification_response(session, bot) -> dict: Reads dimension_scores JSONB from session. Falls back to bant_* columns if dimension_scores is None. Returns dict with dimension data, scores, tier.

5. get_preset_frameworks() -> dict: Returns PRESET_FRAMEWORKS (for the API endpoint).

After creating, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check app/services/qualification_service.py && uv run ruff format app/services/qualification_service.py"
```

---

## Step 3.3: Generalize rag_service.py for Custom Frameworks

```
You are working on OyeChats backend at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/api/.

Read api/app/services/rag_service.py carefully. Find these sections:

1. BANTSignalExtraction pydantic model (~line 43-48): dimension field is Literal["need", "timeline", "authority", "budget"]
2. BANTExtractionResult pydantic model (~line 50-53)
3. extract_bant_from_conversation function (~line 145-213)
4. _background_bant_extraction function (~line 216-322)
5. The qualification section in build_hybrid_prompt (~line 345-400)

Make these changes:

CHANGE 1 — Rename BANTSignalExtraction to QualificationSignalExtraction. Change dimension from Literal to str (to support any framework's dimensions).

CHANGE 2 — Rename BANTExtractionResult to QualificationExtractionResult. Update the signals field type.

CHANGE 3 — In extract_bant_from_conversation: Update to use the new model names. Generalize the rubric building to iterate over the framework config's dimensions (not hardcoded BANT). Rename function to extract_qualification_signals if desired, but keep backward compat by aliasing the old name.

CHANGE 4 — In _background_bant_extraction: After updating individual bant_*_score columns, ALSO update session.dimension_scores JSONB with the new scores. This dual-write ensures both old and new columns stay in sync.

CHANGE 5 — In build_hybrid_prompt qualification section (~line 345-400): The dim_labels dict and conversation_order should come from the framework config, not be hardcoded. Read them from the config dict (which already has dimension names and conversation_order).

IMPORTANT: Keep backward compatibility. The bant_* columns must still be written for BANT framework sessions. The dimension_scores JSONB is written in addition, not instead.

After changes, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check app/services/rag_service.py && uv run ruff format app/services/rag_service.py"
```

---

## Step 3.4: Framework Presets API + Bot Config

```
You are working on OyeChats backend at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/api/.

Read api/app/api/bot_routes.py for the UpdateBotRequest schema and bot update endpoint.

CHANGE 1 — Add qualification_framework field to UpdateBotRequest:
qualification_framework: str | None = None

CHANGE 2 — In the PATCH /bots/{bot_id} endpoint, handle the new field:
if body.qualification_framework is not None:
    bot.qualification_framework = body.qualification_framework  (this column doesn't exist on Bot model yet — skip this if Bot doesn't have it. The framework is stored per-session, not per-bot. Instead, store it in bant_config as a key.)

Actually, better approach: store the selected framework name in bant_config["framework"]. No new Bot column needed. Update the bot_routes endpoint to accept it as part of bant_config.

CHANGE 3 — Add new endpoint GET /bots/{bot_id}/framework-presets:
@router.get("/bots/{bot_id}/framework-presets")
Returns the preset frameworks dict from qualification_service.get_preset_frameworks(). Auth required via get_current_client_or_operator. Verify bot belongs to client.

After changes, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check app/api/bot_routes.py && uv run ruff format app/api/bot_routes.py"
```

---

## Step 3.5: Framework Configuration UI

```
You are working on OyeChats admin dashboard at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/app/.

Read app/src/pages/Qualification.jsx. This has two tabs: ScorecardTab and ConfigurationTab.
Read app/src/services/api.js for the API call pattern.

CHANGE 1 — app/src/services/api.js:
Add: getFrameworkPresets(botId) — GET /bots/{botId}/framework-presets

CHANGE 2 — app/src/pages/Qualification.jsx ConfigurationTab:
Add a framework selector at the TOP of the configuration tab, before the dimension sections:

- Dropdown/select with options: "BANT (Default)", "MEDDIC", "CHAMP", "GPCTBA/CI", "Custom"
- On selecting a preset, fetch presets via getFrameworkPresets, populate the config state with that preset's dimensions
- "Custom" enables an "Add Dimension" button that lets users add new named dimensions
- Each dimension section should show the dimension NAME (editable for custom), not hardcoded "Need", "Timeline" etc.
- Weight field: number input (sum should equal 100, show a validation warning if not)

Follow the existing UI pattern in ConfigurationTab: bg-white rounded-xl border border-secondary-200 p-5 for each section, toggle switches, option editors with score inputs.

After changes, run: cd app && npm run lint && npm run build
Fix any errors.
```

---

## Step 3.6: Phase 3 Final Verification

```
Run all checks for Phase 3 at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/:

1. conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check . && uv run ruff format --check ."
2. cd app && npm run lint && npm run build

Fix ANY failures. Report results.
```

---

# PHASE 4: Meeting Booking

---

## Step 4.1: Meeting Booking Backend

```
You are working on OyeChats backend at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/api/.

Read api/app/db/models.py, api/app/api/bot_routes.py, api/app/api/chat_routes.py for patterns.

TASK: Add meeting booking support.

FILE 1 — Create api/alembic/versions/0019_meeting_booking.py:
Previous migration: 0018_custom_frameworks

Add to bots table:
- calendly_url: String, nullable=True
- meeting_booking_enabled: Boolean, nullable=False, server_default="false"

Create meeting_bookings table:
- id: Integer, PK, autoincrement
- session_id: String, FK to chat_sessions.id CASCADE, nullable=False, indexed
- bot_id: Integer, FK to bots.id CASCADE, nullable=False
- booking_url: String, nullable=True
- meeting_time: DateTime(timezone=True), nullable=True
- attendee_email: String, nullable=True
- status: String, nullable=False, server_default="scheduled" (scheduled|completed|cancelled)
- created_at: DateTime(timezone=True), server_default=func.now()

FILE 2 — Update api/app/db/models.py:
Add to Bot class: calendly_url, meeting_booking_enabled columns
Add MeetingBooking model class (before Department)
Add relationship on Bot: meeting_bookings = relationship(...)

FILE 3 — Update api/app/api/bot_routes.py:
Add calendly_url and meeting_booking_enabled to UpdateBotRequest

FILE 4 — Update api/app/api/chat_routes.py:
Add MeetingBookedRequest pydantic model: session_id (str), booking_url (str|None), meeting_time (str|None), attendee_email (str|None)
Add POST /chat/meeting-booked endpoint: creates MeetingBooking record, fires webhook("meeting_booked", {...})

FILE 5 — Update api/app/services/rag_service.py:
In the FINAL_METADATA section of rag_pipeline_stream, add logic: if bot.meeting_booking_enabled and bot.calendly_url and session tier is "sql", include show_booking: True and calendly_url in the final metadata. Check that no existing MeetingBooking exists for this session.

After changes, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check . && uv run ruff format ."
```

---

## Step 4.2: Meeting Booking Widget Component

```
You are working on OyeChats widget at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/widget/.

Read widget/src/components/ChatWindow.jsx and widget/src/services/api.js for patterns.

FILE 1 — Create widget/src/components/MeetingBooking.jsx:
A compact, collapsible component that embeds Calendly inline when triggered.

Props: { calendlyUrl, sessionId, onBooked, onDismiss }

Component structure:
- A card with header "Book a Meeting" and a collapse/dismiss button (X icon)
- Calendly iframe: <iframe src={calendlyUrl} width="100%" height="350" frameBorder="0" />
- Listen for Calendly postMessage events: window.addEventListener('message', handler)
  - Calendly sends events with data.event === "calendly.event_scheduled"
  - On booking confirmed: call onBooked() callback
- Clean up listener on unmount
- Styling: bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden

FILE 2 — widget/src/services/api.js:
Add: submitMeetingBooked(sessionId, data) — POST /chat/meeting-booked with session_id, booking_url, meeting_time, attendee_email

FILE 3 — widget/src/components/ChatWindow.jsx:
- Import MeetingBooking
- Add state: const [showBooking, setShowBooking] = useState(false); const [calendlyUrl, setCalendlyUrl] = useState(null); const [meetingBooked, setMeetingBooked] = useState(false);
- In onFinalMetadata callback: if (finalMeta.show_booking && finalMeta.calendly_url && !meetingBooked) { setCalendlyUrl(finalMeta.calendly_url); setShowBooking(true); }
- Render MeetingBooking component above the QualificationCTA, only when showBooking is true
- On booking confirmed: call submitMeetingBooked, setMeetingBooked(true), setShowBooking(false), show a success message

After changes, run: cd widget && npm run lint && npm run build
```

---

## Step 4.3: Meeting Booking Admin Settings

```
You are working on OyeChats admin dashboard at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/app/.

Read app/src/pages/Settings.jsx for the toggle + input pattern.

Add a "Meeting Booking" section to Settings.jsx (or to a new Integrations subsection):

Section structure:
- Card with title "Meeting Booking" and subtitle "Show a Calendly booking widget when leads qualify as SQL"
- Toggle switch for meeting_booking_enabled (same pattern as existing feature_flags toggles)
- When enabled, show a text input for calendly_url with placeholder "https://calendly.com/your-name/30min"
- Save button that calls updateBot(botId, { meeting_booking_enabled, calendly_url })

Follow the existing Settings.jsx card pattern: bg-white rounded-2xl border border-secondary-200 shadow-sm p-6

After changes, run: cd app && npm run lint && npm run build
```

---

# PHASE 5: CRM Push via Webhooks

---

## Step 5.1: CRM Templates + Documentation UI

```
You are working on OyeChats admin dashboard at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/app/.

Read app/src/pages/Webhooks.jsx (created in Phase 2).

Add a new tab "CRM Integration" to the Webhooks page with:

1. Header: "Connect to Your CRM" with subtitle "Use webhooks to push qualified leads to HubSpot, Salesforce, or any CRM via Zapier/Make"

2. Three template cards in a grid:
   a. "HubSpot via Zapier" — description: "Automatically create HubSpot contacts when leads qualify", button: "Copy Zapier Setup Guide"
   b. "Salesforce via Make" — description: "Push qualified leads to Salesforce as new leads", button: "Copy Make Setup Guide"
   c. "Custom Webhook" — description: "Send webhook events to any URL", button: "Create Webhook" (navigates to Webhooks tab)

3. Each template card shows a collapsible "Payload Schema" section with example JSON:
{
  "event": "tier_transition",
  "bot_id": 1,
  "timestamp": "2026-04-06T12:00:00Z",
  "data": {
    "session_id": "session_abc123",
    "old_tier": "mql",
    "new_tier": "sql",
    "score": 80,
    "behavioral_score": 15,
    "contact": { "name": "Jane", "email": "jane@acme.com", "phone": "+1234", "company": "Acme" },
    "dimensions": { "need": 25, "budget": 20, "authority": 15, "timeline": 20 }
  }
}

4. Setup guide text for each template (collapsed by default, expand on click):
   - HubSpot: "1. Create a Zap in Zapier. 2. Trigger: Webhooks by Zapier > Catch Hook. 3. Copy the Zapier webhook URL. 4. Create a webhook in OyeChats with event 'tier_transition'. 5. Action: HubSpot > Create Contact. 6. Map fields: email → data.contact.email, etc."
   - Salesforce: Similar steps but with Make.com

After changes, run: cd app && npm run lint && npm run build
```

---

# PHASE 6: Qualification Funnel Analytics

---

## Step 6.1: Funnel Analytics Backend

```
You are working on OyeChats backend at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/api/.

Read api/app/api/analytics_routes.py for existing analytics endpoint patterns.

Add a new endpoint GET /analytics/qualification-funnel:

Query params: bot_id (int, required), period (str, default "30d" — options: "7d", "30d", "90d", "all")

Logic:
- Query chat_sessions for the given bot_id within the time period
- Count sessions at each funnel stage:
  - total_visitors: all sessions
  - engaged: sessions with behavioral_score > 0 OR message count > 1
  - mql: sessions with bant_tier in ("mql", "sal", "sql")
  - sal: sessions with bant_tier in ("sal", "sql")
  - sql: sessions with bant_tier = "sql"
  - meetings_booked: count from meeting_bookings table for this bot
- Return: { funnel: [{stage, count, conversion_rate_from_previous}], period, bot_id }

After changes, run:
conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check app/api/analytics_routes.py && uv run ruff format app/api/analytics_routes.py"
```

---

## Step 6.2: Funnel Analytics UI

```
You are working on OyeChats admin dashboard at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/app/.

Read app/src/pages/Qualification.jsx for existing tab structure.
The project uses recharts (already installed) for charts.

Add a third tab "Funnel" to the Qualification page:

1. app/src/services/api.js — Add: getQualificationFunnel(botId, period) — GET /analytics/qualification-funnel?bot_id={botId}&period={period}

2. app/src/pages/Qualification.jsx — Add FunnelTab component:
   - Period selector: buttons for "7 days", "30 days", "90 days", "All time"
   - Funnel visualization using Recharts BarChart (horizontal bars showing count at each stage):
     - Stages: Visitors → Engaged → MQL → SAL → SQL → Meetings
     - Each bar shows count and conversion % from previous stage
     - Color gradient: gray → blue → indigo → purple → green
   - Below the chart: StatCard grid showing key metrics (total visitors, SQL conversion rate, avg time to qualify)
   - Use existing PageHeader, Tabs, StatCard, SkeletonLoader components
   - Show SkeletonChart while loading

After changes, run: cd app && npm run lint && npm run build
```

---

## Step 6.3: Phase 6 Final Verification

```
Run all checks for Phase 6 at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/:

1. conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check . && uv run ruff format --check ."
2. cd app && npm run lint && npm run build

Fix ANY failures. Report results.
```

---

# FULL BUILD VERIFICATION

---

## Final Step: Complete Build Check

```
Run ALL checks across the entire OyeChats platform at /Users/siddiqueahmed/Desktop/AI/oye-chats/platform/:

1. Backend: conda run -n oye --no-capture-output bash -c "cd api && uv run ruff check . && uv run ruff format --check ."
2. Widget: cd widget && npm run lint && npm run build
3. Admin: cd app && npm run lint && npm run build

Fix ALL failures until every check passes. Report final status for each.
```

---

# Summary — All Steps

| Step | Phase | What | Key Files |
|------|-------|------|-----------|
| 1.1 | 1A | Verify backend behavioral scoring | api/ (5 files) |
| 1.2 | 1A | Widget API behavioral functions | widget/src/services/api.js |
| 1.3 | 1A | Widget ChatWindow behavioral integration | widget/src/components/ChatWindow.jsx |
| 1.4 | 1B | Multi-CTA backend prompt change | api/app/services/rag_service.py |
| 1.5 | 1B | Multi-CTA widget gate change | widget/src/components/ChatWindow.jsx |
| 1.6 | 1A | Admin leads behavioral display | app/src/pages/Leads.jsx |
| 1.7 | 1 | Phase 1 final verification | all 3 projects |
| 2.1 | 2A | Webhook DB migration + models | api/ migration + models |
| 2.2 | 2A | Webhook service core logic | api/app/services/webhook_service.py |
| 2.3 | 2A | Webhook API routes | api/app/api/webhook_routes.py + main.py |
| 2.4 | 2A | Wire webhooks into events | api/ rag_service + chat_routes |
| 2.5 | 2B | Webhook admin UI | app/src/pages/Webhooks.jsx + api.js + routes |
| 2.6 | 2 | Phase 2 final verification | all projects |
| 3.1 | 3A | Framework migration + models | api/ migration + models |
| 3.2 | 3A | Qualification service | api/app/services/qualification_service.py |
| 3.3 | 3A | Generalize rag_service | api/app/services/rag_service.py |
| 3.4 | 3A | Framework presets API | api/app/api/bot_routes.py |
| 3.5 | 3B | Framework config UI | app/src/pages/Qualification.jsx |
| 3.6 | 3 | Phase 3 final verification | api + app |
| 4.1 | 4 | Meeting booking backend | api/ migration + models + routes |
| 4.2 | 4 | Meeting booking widget | widget/ MeetingBooking + ChatWindow |
| 4.3 | 4 | Meeting booking admin settings | app/src/pages/Settings.jsx |
| 5.1 | 5 | CRM templates UI | app/src/pages/Webhooks.jsx |
| 6.1 | 6 | Funnel analytics backend | api/app/api/analytics_routes.py |
| 6.2 | 6 | Funnel analytics UI | app/src/pages/Qualification.jsx |
| 6.3 | 6 | Phase 6 final verification | api + app |
| Final | All | Complete build check | all 3 projects |
