# Zcal + Calendly Meeting Integration — Implementation Plan

> **For AI agent workers:** Required sub-skill: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax to track progress.

**Goal:** Add Zcal as a second meeting provider alongside Calendly, with provider selection (one active at a time), inline iframe modal in the widget, visitor-initiated + bot-triggered booking.

**Architecture:** Add `zcal_url` and `meeting_provider` columns to Bot model. Rename admin "Calendly" tab to "Meetings" with radio provider selector. Update MeetingBooking widget component to support both providers. Bot proactively suggests booking via `[MEETING_CARD]` system prompt token + visitor can manually trigger via calendar icon.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic (backend), React 19 + Vite (widget + admin)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `api/app/db/models.py:125-126` | Add `zcal_url`, `meeting_provider` columns to Bot |
| Create | `api/alembic/versions/d4e5f6a7b8c9_add_zcal_meeting_provider.py` | Migration for new columns |
| Modify | `api/app/api/bot_routes.py:60-107,110-158` | Add fields to UpdateBotRequest + BotResponse |
| Modify | `api/app/services/rag_service.py:577-584` | Add `[MEETING_CARD]` token to system prompt |
| Modify | `api/app/services/rag_service.py:1256-1272` | Use `meeting_provider` to resolve active URL |
| Modify | `widget/src/components/MeetingBooking.jsx` | Support both Calendly + Zcal URLs in iframe |
| Modify | `widget/src/components/ChatWindow.jsx:116-118,676-680,1327-1364` | Calendar icon button, `[MEETING_CARD]` parsing, pass meeting_provider |
| Modify | `widget/src/components/ChatInput.jsx:12-40,178-205` | Add calendar icon button prop |
| Modify | `app/src/pages/Integrations.jsx:402-534` | Rename to Meetings, add provider selector + Zcal field |

---

### Task 1: Database Migration — Add `zcal_url` and `meeting_provider` to Bot

**Files:**
- Modify: `api/app/db/models.py:125-126`
- Create: `api/alembic/versions/d4e5f6a7b8c9_add_zcal_meeting_provider.py`

- [ ] **Step 1: Add columns to Bot model**

In `api/app/db/models.py`, after line 126 (`meeting_booking_enabled`), add:

```python
    meeting_provider = Column(String, nullable=True)  # "calendly" | "zcal" | null
    zcal_url = Column(String, nullable=True)
```

- [ ] **Step 2: Create Alembic migration**

Run:
```bash
cd platform/api && conda run -n oye --no-capture-output uv run alembic revision --autogenerate -m "add_zcal_url_and_meeting_provider_to_bots"
```

- [ ] **Step 3: Review the auto-generated migration**

Verify the generated migration contains:
```python
def upgrade():
    op.add_column('bots', sa.Column('meeting_provider', sa.String(), nullable=True))
    op.add_column('bots', sa.Column('zcal_url', sa.String(), nullable=True))

def downgrade():
    op.drop_column('bots', 'zcal_url')
    op.drop_column('bots', 'meeting_provider')
```

- [ ] **Step 4: Run the migration**

```bash
cd platform/api && conda run -n oye --no-capture-output uv run alembic upgrade head
```

- [ ] **Step 5: Commit**

```bash
git add api/app/db/models.py api/alembic/versions/
git commit -m "feat: add zcal_url and meeting_provider columns to Bot model"
```

---

### Task 2: Backend API — Expose new fields in bot CRUD

**Files:**
- Modify: `api/app/api/bot_routes.py:56-158` (UpdateBotRequest, BotResponse)
- Modify: `api/app/api/bot_routes.py` (all BotResponse construction sites)

- [ ] **Step 1: Add fields to UpdateBotRequest**

In `api/app/api/bot_routes.py`, after line 107 (`meeting_booking_enabled`), add:

```python
    meeting_provider: str | None = Field(None, pattern="^(calendly|zcal)$")
    zcal_url: str | None = None
```

- [ ] **Step 2: Add fields to BotResponse**

In `api/app/api/bot_routes.py`, after line 153 (`meeting_booking_enabled`), add:

```python
    meeting_provider: str | None = None
    zcal_url: str | None = None
```

- [ ] **Step 3: Update all BotResponse construction sites**

There are 3 places where BotResponse is built (search for `calendly_url=b.calendly_url` or `calendly_url=bot.calendly_url`). In each, add after the `meeting_booking_enabled` line:

```python
    meeting_provider=b.meeting_provider,  # (or bot.meeting_provider)
    zcal_url=b.zcal_url,                 # (or bot.zcal_url)
```

The 3 locations are approximately:
1. `get_bot_config()` — the widget config endpoint (~line 198-210)
2. `list_bots()` — the bot list endpoint (~line 765-770)  
3. `get_bot()` — the single bot endpoint (~line 897-902)

- [ ] **Step 4: Verify lint passes**

```bash
cd platform/api && conda run -n oye --no-capture-output uv run ruff check .
```

- [ ] **Step 5: Commit**

```bash
git add api/app/api/bot_routes.py
git commit -m "feat: expose zcal_url and meeting_provider in bot API"
```

---

### Task 3: RAG Pipeline — Add meeting booking to system prompt + resolve active URL

**Files:**
- Modify: `api/app/services/rag_service.py:577-584` (system prompt)
- Modify: `api/app/services/rag_service.py:1256-1272` (FINAL_METADATA meeting check)

- [ ] **Step 1: Add meeting booking instruction to system prompt**

In `rag_service.py`, in `build_hybrid_prompt()`, add a new parameter `meeting_booking_enabled: bool = False` and inject a section after the `handoff_section`:

```python
    meeting_section = ""
    if meeting_booking_enabled:
        meeting_section = """
MEETING BOOKING: When the visitor expresses interest in scheduling a meeting, demo, call, or appointment, include the token [MEETING_CARD] on its own line at the end of your response. This will trigger an inline booking calendar in the chat. Only include [MEETING_CARD] once per conversation — do not repeat it if a booking was already offered."""
```

Then append `meeting_section` to the hybrid system prompt string, after the handoff section.

Add the `meeting_booking_enabled` parameter to both call sites of `build_hybrid_prompt()`:
- In `rag_pipeline()` (~line 875-890)
- In `rag_pipeline_stream()` (~line 1154-1168)

Pass: `meeting_booking_enabled=getattr(bot, "meeting_booking_enabled", False) if bot else False`

- [ ] **Step 2: Resolve active meeting URL using meeting_provider**

In `rag_pipeline_stream()`, update the FINAL_METADATA meeting booking check (~line 1258-1272).

Replace:
```python
                if (
                    bot
                    and getattr(bot, "meeting_booking_enabled", False)
                    and getattr(bot, "calendly_url", None)
                    and (chat_session.bant_tier or "unqualified") == "sql"
                ):
                    has_booking = (
                        session.query(MeetingBooking)
                        .filter(MeetingBooking.session_id == session_id, MeetingBooking.bot_id == bid)
                        .first()
                        is not None
                    )
                    if not has_booking:
                        final_meta["show_booking"] = True
                        final_meta["calendly_url"] = bot.calendly_url
```

With:
```python
                if bot and getattr(bot, "meeting_booking_enabled", False):
                    provider = getattr(bot, "meeting_provider", None) or "calendly"
                    active_url = (
                        getattr(bot, "zcal_url", None)
                        if provider == "zcal"
                        else getattr(bot, "calendly_url", None)
                    )
                    if active_url:
                        show_for_sql = (chat_session.bant_tier or "unqualified") == "sql"
                        has_booking = (
                            session.query(MeetingBooking)
                            .filter(MeetingBooking.session_id == session_id, MeetingBooking.bot_id == bid)
                            .first()
                            is not None
                        )
                        if show_for_sql and not has_booking:
                            final_meta["show_booking"] = True
                            final_meta["calendly_url"] = active_url
                            final_meta["meeting_provider"] = provider
```

Also add the same logic for the `[MEETING_CARD]` token detection. After the `_strip_cta_marker` call in the stream path (~line 1194), add:

```python
        # Detect [MEETING_CARD] token from the LLM response
        _meeting_card_pattern = re.compile(r"\[MEETING_CARD\]")
        if _meeting_card_pattern.search(full_answer):
            full_answer = _meeting_card_pattern.sub("", full_answer).rstrip()
            if bot and getattr(bot, "meeting_booking_enabled", False):
                provider = getattr(bot, "meeting_provider", None) or "calendly"
                active_url = (
                    getattr(bot, "zcal_url", None)
                    if provider == "zcal"
                    else getattr(bot, "calendly_url", None)
                )
                if active_url:
                    has_booking = (
                        session.query(MeetingBooking)
                        .filter(MeetingBooking.session_id == session_id, MeetingBooking.bot_id == bid)
                        .first()
                        is not None
                    )
                    if not has_booking:
                        final_meta["show_booking"] = True
                        final_meta["calendly_url"] = active_url
                        final_meta["meeting_provider"] = provider
```

- [ ] **Step 3: Verify lint + format**

```bash
cd platform/api && conda run -n oye --no-capture-output uv run ruff check . && conda run -n oye --no-capture-output uv run ruff format .
```

- [ ] **Step 4: Commit**

```bash
git add api/app/services/rag_service.py
git commit -m "feat: add meeting booking system prompt + multi-provider URL resolution"
```

---

### Task 4: Widget — Update MeetingBooking to support both Calendly and Zcal

**Files:**
- Modify: `widget/src/components/MeetingBooking.jsx`

- [ ] **Step 1: Update URL validation to support both providers**

Replace the existing `validateCalendlyUrl` function with a multi-provider validator:

```jsx
const ALLOWED_HOSTS = {
    calendly: (host) => host === 'calendly.com' || host.endsWith('.calendly.com'),
    zcal: (host) => host === 'zcal.co' || host.endsWith('.zcal.co'),
};

const validateMeetingUrl = (url, provider = 'calendly') => {
    if (!url || typeof url !== 'string') return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return null;
        const host = parsed.hostname.toLowerCase();
        const checker = ALLOWED_HOSTS[provider] || ALLOWED_HOSTS.calendly;
        if (!checker(host)) return null;
        return url;
    } catch {
        return null;
    }
};
```

- [ ] **Step 2: Update component to accept `provider` prop**

Update the component signature and internal logic:

```jsx
const MeetingBooking = ({ calendlyUrl, sessionId, onBooked, onDismiss, provider = 'calendly' }) => {
    const [collapsed, setCollapsed] = useState(false);
    const safeUrl = validateMeetingUrl(calendlyUrl, provider);

    useEffect(() => {
        const handleMessage = (event) => {
            if (provider === 'calendly') {
                if (event.origin !== 'https://calendly.com') return;
                const data = event?.data;
                if (!data || typeof data !== 'object') return;
                if (data.event === 'calendly.event_scheduled') {
                    onBooked?.({
                        session_id: sessionId,
                        booking_url: data.payload?.event?.uri || calendlyUrl,
                        attendee_email: data.payload?.invitee?.email || null,
                        meeting_time: data.payload?.event?.start_time || null,
                    });
                }
            } else if (provider === 'zcal') {
                if (event.origin !== 'https://zcal.co') return;
                const data = event?.data;
                if (!data || typeof data !== 'object') return;
                // Zcal sends a postMessage on booking completion
                if (data.type === 'zcal:booking_confirmed' || data.event === 'zcal.booking_confirmed') {
                    onBooked?.({
                        session_id: sessionId,
                        booking_url: data.payload?.booking_url || calendlyUrl,
                        attendee_email: data.payload?.email || null,
                        meeting_time: data.payload?.start_time || null,
                    });
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [calendlyUrl, onBooked, sessionId, provider]);

    if (!safeUrl) return null;

    return (
        <div
            className="absolute inset-0 z-40 flex flex-col"
            style={{ animation: 'fadeUp 0.3s ease-out' }}
        >
            {/* Backdrop */}
            <div className="flex-[0.15]" onClick={onDismiss} />

            {/* Modal panel — slides up from bottom, ~85% of widget */}
            <div className="flex-[0.85] bg-white rounded-t-2xl border-t border-gray-200 shadow-xl flex flex-col overflow-hidden">
                <div className="px-4 py-3 flex items-center justify-between border-b border-gray-100">
                    <h3 className="text-sm font-semibold text-gray-800">Book a Meeting</h3>
                    <button
                        onClick={onDismiss}
                        className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500"
                        aria-label="Close booking widget"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <div className="flex-1 overflow-hidden">
                    <iframe
                        title={`${provider === 'zcal' ? 'Zcal' : 'Calendly'} Booking`}
                        src={safeUrl}
                        width="100%"
                        height="100%"
                        frameBorder="0"
                        sandbox="allow-scripts allow-popups allow-forms allow-top-navigation-by-user-activation allow-same-origin"
                    />
                </div>
            </div>
        </div>
    );
};
```

**Key changes:**
- Changed from inline card to modal overlay (slides up from bottom, covers ~85%)
- Added `provider` prop to switch between Calendly and Zcal postMessage handling
- Added `allow-same-origin` to sandbox for Zcal's iframe requirements
- URL validation accepts both `calendly.com` and `zcal.co`

- [ ] **Step 3: Verify widget lint passes**

```bash
cd platform/widget && npm run lint
```

- [ ] **Step 4: Commit**

```bash
git add widget/src/components/MeetingBooking.jsx
git commit -m "feat: update MeetingBooking to support Zcal + modal overlay"
```

---

### Task 5: Widget — Add calendar icon button to ChatInput + MEETING_CARD parsing

**Files:**
- Modify: `widget/src/components/ChatInput.jsx:12-40,178-205`
- Modify: `widget/src/components/ChatWindow.jsx:116-118,676-680,1327-1364,1693-1716`

- [ ] **Step 1: Add calendar icon button to ChatInput**

In `ChatInput.jsx`, add `CalendarDays` to the lucide import (line 2):

```jsx
import { Headphones, Paperclip, CalendarDays } from 'lucide-react';
```

Add new props to the component:

```jsx
    onBookMeeting,
    meetingBookingEnabled = false,
```

In the action bar section (after the onHandoff button, ~line 204), add:

```jsx
                        {meetingBookingEnabled && onBookMeeting && (
                            <button
                                type="button"
                                onClick={onBookMeeting}
                                title="Book a meeting"
                                aria-label="Book a meeting"
                                className="flex items-center gap-1 text-[11px] transition-colors cursor-pointer text-gray-400 hover:text-gray-600"
                            >
                                <CalendarDays size={12} />
                                <span>Book meeting</span>
                            </button>
                        )}
```

- [ ] **Step 2: Parse [MEETING_CARD] token in ChatWindow stream handler**

In `ChatWindow.jsx`, in the `onFinalMetadata` handler (~line 677), the `show_booking` + `calendly_url` handling already exists. Add `meeting_provider` to the state:

Update the state declaration (after `calendlyUrl` state, ~line 117):

```jsx
    const [meetingProvider, setMeetingProvider] = useState(null);
```

Update `onFinalMetadata` (~line 677-680):

```jsx
                    if (finalMeta.show_booking && finalMeta.calendly_url && !meetingBooked) {
                        setCalendlyUrl(finalMeta.calendly_url);
                        setMeetingProvider(finalMeta.meeting_provider || 'calendly');
                        setShowBooking(true);
                    }
```

Also parse `[MEETING_CARD]` from the streamed text. In `onFinalMetadata`, before the `if (finalMeta.show_booking)` check, add:

```jsx
                    // Check for [MEETING_CARD] in the final metadata
                    if (finalMeta.show_booking && finalMeta.calendly_url && !meetingBooked) {
                        setCalendlyUrl(finalMeta.calendly_url);
                        setMeetingProvider(finalMeta.meeting_provider || 'calendly');
                        setShowBooking(true);
                    }
```

(This is already handled — the `[MEETING_CARD]` token is stripped by the backend and converted to `show_booking` in FINAL_METADATA. No frontend parsing needed.)

- [ ] **Step 3: Pass provider to MeetingBooking component**

In ChatWindow.jsx, update the MeetingBooking render (~line 1328-1364):

```jsx
                {showBooking && calendlyUrl && (
                    <MeetingBooking
                        calendlyUrl={calendlyUrl}
                        sessionId={sessionId}
                        provider={meetingProvider || 'calendly'}
                        onDismiss={() => setShowBooking(false)}
                        onBooked={async (bookingData) => { /* existing handler */ }}
                    />
                )}
```

- [ ] **Step 4: Pass meeting props to ChatInput**

In `ChatWindow.jsx`, update the ChatInput render (~line 1693-1716). Add:

```jsx
                    meetingBookingEnabled={!!settings.meeting_booking_enabled && !meetingBooked}
                    onBookMeeting={() => {
                        if (settings.meeting_booking_enabled && !meetingBooked) {
                            const provider = settings.meeting_provider || 'calendly';
                            const url = provider === 'zcal' ? settings.zcal_url : settings.calendly_url;
                            if (url) {
                                setCalendlyUrl(url);
                                setMeetingProvider(provider);
                                setShowBooking(true);
                            }
                        }
                    }}
```

- [ ] **Step 5: Reset meetingProvider in handleNewChat**

In `handleNewChat()` (~line 548), add:

```jsx
        setMeetingProvider(null);
```

- [ ] **Step 6: Verify widget lint + build**

```bash
cd platform/widget && npm run lint && npm run build
```

- [ ] **Step 7: Commit**

```bash
git add widget/src/components/ChatInput.jsx widget/src/components/ChatWindow.jsx
git commit -m "feat: add calendar icon button + meeting provider support in widget"
```

---

### Task 6: Admin Dashboard — Rename Calendly tab to Meetings, add provider selector

**Files:**
- Modify: `app/src/pages/Integrations.jsx:402-534`

- [ ] **Step 1: Rename tab and update CalendlySettings to MeetingsSettings**

In `Integrations.jsx`, rename the tab (~line 533):

```jsx
    { id: 'meetings', label: 'Meetings', icon: Calendar },
```

Update the tab render (~line 551):

```jsx
            {activeTab === 'meetings' && <MeetingsSettings />}
```

- [ ] **Step 2: Rewrite CalendlySettings as MeetingsSettings**

Replace the `CalendlySettings` function (lines 404-526) with `MeetingsSettings`:

```jsx
function MeetingsSettings() {
    const { showToast } = useToast();
    const [bot, setBot] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [meetingBookingEnabled, setMeetingBookingEnabled] = useState(false);
    const [meetingProvider, setMeetingProvider] = useState('calendly');
    const [calendlyUrl, setCalendlyUrl] = useState('');
    const [zcalUrl, setZcalUrl] = useState('');
    const [justSaved, setJustSaved] = useState(false);

    const fetchBot = useCallback(async () => {
        setLoading(true);
        try {
            const bots = await getBots();
            if (bots?.length > 0) {
                const b = bots[0];
                setBot(b);
                setMeetingBookingEnabled(!!b.meeting_booking_enabled);
                setMeetingProvider(b.meeting_provider || 'calendly');
                setCalendlyUrl(b.calendly_url || '');
                setZcalUrl(b.zcal_url || '');
            }
        } catch {
            showToast('error', 'Failed to load meeting settings');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => { fetchBot(); }, [fetchBot]);

    const activeUrl = meetingProvider === 'zcal' ? zcalUrl : calendlyUrl;

    const handleSave = async () => {
        if (!bot) return;
        setSaving(true);
        try {
            await updateBot(bot.id, {
                meeting_booking_enabled: meetingBookingEnabled,
                meeting_provider: meetingBookingEnabled ? meetingProvider : null,
                calendly_url: calendlyUrl || null,
                zcal_url: zcalUrl || null,
            });
            showToast('success', 'Meeting settings saved');
            setJustSaved(true);
            await fetchBot();
            setTimeout(() => setJustSaved(false), 3000);
        } catch (error) {
            showToast('error', error.message || 'Failed to save meeting settings');
        } finally {
            setSaving(false);
        }
    };

    const inputClass = "w-full px-3.5 py-2.5 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl text-sm text-surface-900 dark:text-surface-100 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all placeholder:text-surface-400 dark:placeholder:text-surface-500";

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-6 h-6 animate-spin text-surface-400 dark:text-surface-500" />
            </div>
        );
    }

    return (
        <div className="space-y-6 max-w-3xl">
            {/* Meeting Configuration */}
            <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm p-6">
                <div className="flex items-center gap-3 mb-5">
                    <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-900/30 flex items-center justify-center">
                        <Calendar size={20} className="text-primary-600 dark:text-primary-400" />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Meeting Booking</h3>
                        <p className="text-xs text-surface-500 dark:text-surface-400">Let visitors book meetings directly in the chat widget</p>
                    </div>
                </div>

                <div className="space-y-4">
                    <div className="flex items-start gap-2 px-3.5 py-3 bg-surface-50 dark:bg-surface-800 rounded-xl">
                        <Info size={14} className="text-surface-400 dark:text-surface-500 mt-0.5 shrink-0" />
                        <p className="text-xs text-surface-600 dark:text-surface-400 leading-relaxed">
                            When enabled, visitors can book meetings inline in the chat. The bot will also suggest booking when it detects scheduling intent. Only one provider can be active at a time.
                        </p>
                    </div>

                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-surface-800 dark:text-surface-200">Enable meeting booking</p>
                            <p className="text-xs text-surface-500 dark:text-surface-400">Show booking option in the chat widget</p>
                        </div>
                        <Toggle checked={meetingBookingEnabled} onChange={setMeetingBookingEnabled} />
                    </div>

                    {meetingBookingEnabled && (
                        <>
                            {/* Provider Selector */}
                            <div>
                                <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">Meeting Provider</label>
                                <div className="flex gap-3">
                                    <button
                                        type="button"
                                        onClick={() => setMeetingProvider('calendly')}
                                        className={cn(
                                            'flex-1 flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all',
                                            meetingProvider === 'calendly'
                                                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 dark:border-primary-400'
                                                : 'border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600'
                                        )}
                                    >
                                        <div className="w-8 h-8 rounded-lg bg-[#006BFF] flex items-center justify-center flex-shrink-0">
                                            <span className="text-white text-xs font-bold">C</span>
                                        </div>
                                        <div className="text-left">
                                            <p className="text-sm font-medium text-surface-900 dark:text-surface-100">Calendly</p>
                                            <p className="text-xs text-surface-500 dark:text-surface-400">calendly.com</p>
                                        </div>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setMeetingProvider('zcal')}
                                        className={cn(
                                            'flex-1 flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all',
                                            meetingProvider === 'zcal'
                                                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 dark:border-primary-400'
                                                : 'border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600'
                                        )}
                                    >
                                        <div className="w-8 h-8 rounded-lg bg-[#000000] flex items-center justify-center flex-shrink-0">
                                            <span className="text-white text-xs font-bold">Z</span>
                                        </div>
                                        <div className="text-left">
                                            <p className="text-sm font-medium text-surface-900 dark:text-surface-100">Zcal</p>
                                            <p className="text-xs text-surface-500 dark:text-surface-400">zcal.co</p>
                                        </div>
                                    </button>
                                </div>
                            </div>

                            {/* URL Input — shows field for selected provider */}
                            <div>
                                <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                                    {meetingProvider === 'zcal' ? 'Zcal URL' : 'Calendly URL'}
                                </label>
                                <input
                                    type="url"
                                    value={meetingProvider === 'zcal' ? zcalUrl : calendlyUrl}
                                    onChange={(e) => meetingProvider === 'zcal' ? setZcalUrl(e.target.value) : setCalendlyUrl(e.target.value)}
                                    placeholder={meetingProvider === 'zcal' ? 'https://zcal.co/your-name/30min' : 'https://calendly.com/your-name/30min'}
                                    className={inputClass}
                                />
                                <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
                                    Paste your {meetingProvider === 'zcal' ? 'Zcal' : 'Calendly'} scheduling link
                                </p>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* Save Button */}
            <div className="flex justify-end">
                <button
                    onClick={handleSave}
                    disabled={saving || (meetingBookingEnabled && !activeUrl.trim())}
                    className={cn(
                        'flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium shadow-sm transition-all disabled:opacity-50',
                        justSaved
                            ? 'bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white'
                            : 'bg-primary-600 hover:bg-primary-700 dark:bg-primary-600 dark:hover:bg-primary-500 text-white',
                    )}
                >
                    {saving && <Loader2 size={14} className="animate-spin" />}
                    {justSaved && <Check size={14} />}
                    {saving ? 'Saving...' : justSaved ? 'Saved' : 'Save Meeting Settings'}
                </button>
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Update the initial tab param validation**

In the `Integrations` component (~line 539), update to support the new tab id:

```jsx
    const initialTab = params.get('tab') || 'email';
```

The `integrationTabs.some(t => t.id === initialTab)` check on line 541 will automatically handle this since we changed the tab id to 'meetings'.

- [ ] **Step 4: Verify admin lint + build**

```bash
cd platform/app && npm run lint && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add app/src/pages/Integrations.jsx
git commit -m "feat: add Zcal provider selection alongside Calendly in Meetings tab"
```

---

### Task 7: Bot config endpoint — pass meeting settings to widget

**Files:**
- Modify: `api/app/api/bot_routes.py` (get_bot_config function)

- [ ] **Step 1: Add meeting_provider and zcal_url to widget config response**

Find the `get_bot_config()` function (search for `def get_bot_config` or the `/config` route). Ensure the response includes:

```python
        "meeting_provider": bot.meeting_provider,
        "zcal_url": bot.zcal_url,
```

alongside the existing `calendly_url` and `meeting_booking_enabled` fields.

- [ ] **Step 2: Verify lint**

```bash
cd platform/api && conda run -n oye --no-capture-output uv run ruff check .
```

- [ ] **Step 3: Commit**

```bash
git add api/app/api/bot_routes.py
git commit -m "feat: expose meeting_provider and zcal_url in widget config endpoint"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run all backend checks**

```bash
cd platform/api && conda run -n oye --no-capture-output uv run ruff check . && conda run -n oye --no-capture-output uv run ruff format --check .
```

- [ ] **Step 2: Run widget lint + build**

```bash
cd platform/widget && npm run lint && npm run build
```

- [ ] **Step 3: Run admin lint + build**

```bash
cd platform/app && npm run lint && npm run build
```

- [ ] **Step 4: Manual browser test**

1. Start API: `conda run -n oye --no-capture-output bash -c "cd platform/api && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"`
2. Start admin: `cd platform/app && npm run dev`
3. Login at localhost:5174 with test credentials
4. Go to Integrations → Meetings tab
5. Verify: toggle + provider selector (Calendly / Zcal) + URL field works
6. Save with a test Calendly URL → verify it persists on reload
7. Switch to Zcal → enter Zcal URL → save → verify it persists
8. Start widget preview: `cd platform/widget && npm run build && npx vite preview --port 4173`
9. Verify calendar icon appears in chat input action bar
10. Click calendar icon → verify modal overlay appears with iframe
