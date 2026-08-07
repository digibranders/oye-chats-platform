// Streaming sentinel stripper — extracted to its own module so the
// split-chunk correctness logic is unit-tested independently.
// See sentinelStripper.test.js for regression coverage.
import { createSentinelStripper } from './sentinelStripper.js';
import { readSessionId } from './storage-keys.js';

const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

const getHeaders = () => {
    const headers = {
        'Content-Type': 'application/json',
    };
    // Priority: X-Bot-Key (new multi-bot) > X-API-Key (legacy backward compat)
    if (window.OYECHATS_BOT_KEY) {
        headers['X-Bot-Key'] = window.OYECHATS_BOT_KEY;
    } else if (window.OYECHATS_API_KEY) {
        headers['X-API-Key'] = window.OYECHATS_API_KEY;
    } else {
        console.warn('[OyeChats] No Bot Key or API Key found! Chatbot requests may be blocked.');
    }
    return headers;
};

export const sendMessage = async (message, sessionId = null) => {
    try {
        const response = await fetch(`${API_URL}/chat`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                question: message,
                session_id: sessionId
            }),
        });

        if (!response.ok) {
            throw new Error('Network response was not ok');
        }

        const data = await response.json();
        return data; // returns { answer, sources, session_id, message_id }
    } catch (error) {
        console.error("Error sending message:", error);
        throw error;
    }
};

// Wrap reader.read() in a race against a timeout so a stalled stream
// (backend hung, TCP open but no bytes flowing) never freezes the UI forever.
// 65s = 60s server-side chunk timeout + 5s network RTT buffer.
const _STREAM_READ_TIMEOUT_MS = 65_000;

const _readWithTimeout = (reader) =>
    new Promise((resolve, reject) => {
        const tid = setTimeout(
            () => reject(new Error(`Stream read timed out after ${_STREAM_READ_TIMEOUT_MS / 1000}s`)),
            _STREAM_READ_TIMEOUT_MS,
        );
        reader.read().then(
            (result) => { clearTimeout(tid); resolve(result); },
            (err) => { clearTimeout(tid); reject(err); },
        );
    });

export const sendMessageStream = async (message, sessionId, { onMetadata, onChunk, onFinalMetadata, onError, ctaDimension }) => {
    try {
        const response = await fetch(`${API_URL}/chat/stream`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                question: message,
                session_id: sessionId,
                // BR-02: tags this message as the visitor's tap on an active
                // qualification CTA pill so the backend can score it
                // deterministically from the rubric instead of re-interpreting
                // it as free text (see rag_service._score_cta_answer).
                ...(ctaDimension ? { cta_dimension: ctaDimension } : {}),
            }),
        });

        if (!response.ok) {
            // 402 = bot operator out of credits. Surface a friendly message
            // (visitors must NEVER see internal billing terms like "credits").
            if (response.status === 402) {
                const err = new Error(
                    "We're temporarily over capacity for this chatbot. Please try again later or reach us by email."
                );
                err.status = 402;
                err.code = 'over_capacity';
                throw err;
            }
            // 503 = global kill switch / billing paused.
            if (response.status === 503) {
                const err = new Error(
                    "We're briefly offline for maintenance. Please try again in a few minutes."
                );
                err.status = 503;
                err.code = 'maintenance';
                throw err;
            }
            throw new Error('Network response was not ok');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let metadataReceived = false;

        // All visible text funnels through this stripper so inline-card
        // sentinels (e.g. [LEAVE_MESSAGE_CARD]) never reach the UI — even
        // when they straddle chunk boundaries.
        const stripper = createSentinelStripper();
        const emitClean = (text) => {
            const clean = stripper.push(text);
            if (clean) onChunk?.(clean);
        };

        while (true) {
            let done, value;
            try {
                ({ done, value } = await _readWithTimeout(reader));
            } catch (readErr) {
                // Timed out or aborted — cancel the stream and surface the error
                reader.cancel().catch(() => { });
                throw readErr;
            }
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Extract and process any complete lines (needed for METADATA parsing)
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete last segment in buffer

            for (const line of lines) {
                if (!line.trim()) continue;

                if (line.startsWith('METADATA:')) {
                    try {
                        const metadata = JSON.parse(line.slice(9));
                        onMetadata?.(metadata);
                        metadataReceived = true;
                    } catch { /* ignore parse errors */ }
                } else if (line.startsWith('FINAL_METADATA:')) {
                    // Flush any pending partial buffer BEFORE triggering final metadata
                    // so all streamed text is delivered before handoff can fire.
                    if (buffer && !buffer.startsWith('METADATA:') && !buffer.startsWith('FINAL_METADATA:')) {
                        emitClean(buffer);
                        buffer = '';
                    }
                    // Release any sentinel-prefix tail the stripper was holding
                    // so no trailing text is silently swallowed by cleanup.
                    const tail = stripper.flush();
                    if (tail) onChunk?.(tail);
                    try {
                        const finalMeta = JSON.parse(line.slice(15));
                        onFinalMetadata?.(finalMeta);
                    } catch { /* ignore parse errors */ }
                } else {
                    emitClean(line + '\n');
                }
            }

            // Flush partial content immediately — don't wait for a newline.
            // LLM tokens arrive without \n delimiters, so without this flush the
            // entire response would accumulate in buffer and appear all at once
            // at stream end. Guard against flushing a partial METADATA line.
            if (metadataReceived && buffer &&
                !buffer.startsWith('METADATA:') &&
                !buffer.startsWith('FINAL_METADATA:')) {
                emitClean(buffer);
                buffer = '';
            }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
            if (buffer.startsWith('FINAL_METADATA:')) {
                // Flush stripper before final metadata so no text is lost.
                const tail = stripper.flush();
                if (tail) onChunk?.(tail);
                try {
                    const finalMeta = JSON.parse(buffer.slice(15));
                    onFinalMetadata?.(finalMeta);
                } catch { /* ignore */ }
            } else if (!buffer.startsWith('METADATA:')) {
                emitClean(buffer);
            }
        }

        // Final safety flush — releases any stripper-held tail in the
        // (rare) case the stream ended without FINAL_METADATA.
        const tail = stripper.flush();
        if (tail) onChunk?.(tail);
    } catch (error) {
        console.error("[OyeChats] Streaming error:", error);
        onError?.(error);
        throw error;
    }
};

export const getChatHistory = async (sessionId, { before, limit = 50 } = {}) => {
    try {
        const params = new URLSearchParams({ limit });
        if (before != null) params.set('before', before);
        const response = await fetch(`${API_URL}/chat/history/${sessionId}?${params}`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            throw new Error('Failed to fetch chat history');
        }
        return await response.json();
    } catch (error) {
        console.error("Error fetching chat history:", error);
        throw error;
    }
};

export const submitFeedback = async (messageId, feedbackValue) => {
    try {
        const response = await fetch(`${API_URL}/chat/feedback/${messageId}`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                feedback: feedbackValue
            }),
        });
        if (!response.ok) {
            throw new Error('Failed to submit feedback');
        }
        return await response.json();
    } catch (error) {
        console.error("Error submitting feedback:", error);
        throw error;
    }
};

export const submitLeadCapture = async (sessionId, formData) => {
    try {
        const response = await fetch(`${API_URL}/chat/lead-capture`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                session_id: sessionId,
                ...formData,
            }),
        });
        if (!response.ok) {
            throw new Error('Failed to submit lead capture');
        }
        return await response.json();
    } catch (error) {
        console.error("Error submitting lead capture:", error);
        throw error;
    }
};

export const submitMeetingBooked = async (sessionId, data = {}) => {
    try {
        const response = await fetch(`${API_URL}/chat/meeting-booked`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                session_id: sessionId,
                booking_url: data.booking_url || null,
                meeting_time: data.meeting_time || null,
                attendee_email: data.attendee_email || null,
            }),
        });
        if (!response.ok) throw new Error('Failed to submit meeting booking');
        return await response.json();
    } catch (error) {
        console.error('[OyeChats] Error submitting meeting booking:', error);
        throw error;
    }
};

export const requestHandoff = async (sessionId, formData) => {
    try {
        const response = await fetch(`${API_URL}/operators/handoff`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                session_id: sessionId,
                reason: formData.reason || null,
                department_id: formData.department_id || null,
            }),
        });
        if (!response.ok) throw new Error('Handoff request failed');

        // Save lead info fire-and-forget — handoff success should not
        // depend on lead capture success.
        if (formData.name || formData.email) {
            submitLeadCapture(sessionId, {
                name: formData.name,
                email: formData.email,
            }).catch(err => console.warn('[OyeChats] Lead capture failed (non-fatal):', err));
        }

        return await response.json();
    } catch (error) {
        console.error("Error requesting handoff:", error);
        throw error;
    }
};

/**
 * Poll for a pending operator connect-request while in bot mode. Returns
 * ``{ pending: false }`` when none is active, otherwise the request payload.
 */
export const getPendingConnectRequest = async (sessionId) => {
    try {
        const response = await fetch(`${API_URL}/chat/connect-request/${sessionId}`, {
            headers: getHeaders(),
        });
        if (!response.ok) return { pending: false };
        return await response.json();
    } catch {
        return { pending: false };
    }
};

/** Visitor accepts (``accepted=true``) or declines an operator connect-request. */
export const respondToConnectRequest = async (sessionId, accepted, requestId = null) => {
    try {
        const response = await fetch(`${API_URL}/chat/connect-request/${sessionId}/respond`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ accepted, request_id: requestId }),
        });
        if (!response.ok) throw new Error('Connect-request response failed');
        return await response.json();
    } catch (error) {
        console.warn('[OyeChats] Connect-request response failed:', error);
        return { ok: false };
    }
};

export const cancelHandoff = async (sessionId) => {
    try {
        const response = await fetch(`${API_URL}/operators/cancel-handoff/${sessionId}`, {
            method: 'POST',
            headers: getHeaders(),
        });
        if (!response.ok) throw new Error('Cancel handoff failed');
        return await response.json();
    } catch (error) {
        console.warn('[OyeChats] Cancel handoff failed (non-fatal):', error);
    }
};

export const getSessionStatus = async (sessionId) => {
    try {
        const response = await fetch(`${API_URL}/operators/session-status/${sessionId}`, {
            headers: getHeaders(),
        });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
};

export const getDepartments = async () => {
    try {
        const response = await fetch(`${API_URL}/operators/departments/public`, {
            headers: getHeaders(),
        });
        if (!response.ok) return { departments: [] };
        return await response.json();
    } catch (error) {
        console.error("Error fetching departments:", error);
        return { departments: [] };
    }
};

export const getLeadInfo = async (sessionId) => {
    try {
        const response = await fetch(`${API_URL}/chat/lead-info/${sessionId}`, {
            headers: getHeaders(),
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.lead_info || null;
    } catch (error) {
        console.error('[OyeChats] Error fetching lead info:', error);
        return null;
    }
};

export const submitOfflineMessage = async (formData) => {
    try {
        const botKey = window.OYECHATS_BOT_KEY || '';
        const response = await fetch(`${API_URL}/offline-messages`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                bot_key: botKey,
                name: formData.name,
                email: formData.email,
                phone: formData.phone || null,
                message: formData.message,
                session_id: formData.session_id || null,
                department_id: formData.department_id || null,
                // Why visitor fell back to the form — the resolver state at the
                // time of fallback (no_operators, out_of_hours, queue_timeout,
                // etc.). Lets admin filter offline messages by cause and powers
                // the "why am I getting so many of these?" analytics.
                reason: formData.reason || 'manual',
                // Up to 200 turns of the bot conversation that preceded the
                // fallback. Operator who replies has full context instead of
                // a cold inbound from someone who already wrote three pages
                // worth of questions to our bot.
                transcript: Array.isArray(formData.transcript) ? formData.transcript.slice(-200) : null,
            }),
        });
        if (!response.ok) throw new Error('Failed to submit offline message');
        return await response.json();
    } catch (error) {
        console.error("Error submitting offline message:", error);
        throw error;
    }
};

/**
 * Send a chat transcript to the visitor's email via the backend.
 * @param {string} sessionId - The chat session ID.
 * @param {string} recipientEmail - The email address to send the transcript to.
 */
export const sendTranscriptEmail = async (sessionId, recipientEmail) => {
    const response = await fetch(`${API_URL}/chat/transcript`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
            session_id: sessionId,
            recipient_email: recipientEmail,
        }),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || 'Failed to send transcript');
    }
    return response.json();
};

/**
 * Journey capture — records the ordered list of page paths the visitor
 * touches on the host site before, during, and after chatting. Powers
 * the "before chat" attribution on the Leads page AND the Journeys view
 * under Analytics (top pages / paths that convert / post-chat activity).
 *
 * Stored in sessionStorage (namespaced per bot) so it clears when the tab
 * closes — matches GDPR expectations and mirrors how UTM capture works.
 * Uses a small in-memory dedupe against the last entry so a SPA that
 * fires history.pushState multiple times for the same route doesn't
 * balloon the array.
 *
 * Every entry carries a ``phase`` tag — ``pre`` before chat opens, ``chat``
 * for event markers, ``post`` for pages the visitor sees after chat has
 * been opened at least once. The transition is a one-way flip stored in
 * sessionStorage under ``oyechats_chat_phase_<botKey>``; once flipped,
 * every subsequent auto-appended pathname is tagged ``post``.
 */
const JOURNEY_MAX_ENTRIES = 200;
const JOURNEY_PATH_MAX_LEN = 500;
// Throttle window before a coalesced journey POST fires. 3s keeps
// the widget from spamming the backend when a visitor click-clicks
// through a nav, while still surfacing new pages in the admin
// dashboard within a few seconds instead of the old 10s wait.
const JOURNEY_FLUSH_THROTTLE_MS = 3_000;

const _journeyKey = () => {
    const botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || 'default';
    return `oyechats_journey_${botKey}`;
};

const _journeyPhaseKey = () => {
    const botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || 'default';
    return `oyechats_chat_phase_${botKey}`;
};

const _readJourney = () => {
    try {
        const raw = sessionStorage.getItem(_journeyKey());
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const _writeJourney = (entries) => {
    try {
        sessionStorage.setItem(_journeyKey(), JSON.stringify(entries));
    } catch {
        /* quota / private mode — safe to swallow */
    }
};

const _currentPhase = () => {
    try {
        return sessionStorage.getItem(_journeyPhaseKey()) === 'post' ? 'post' : 'pre';
    } catch {
        return 'pre';
    }
};

const _flipToPostPhase = () => {
    try {
        sessionStorage.setItem(_journeyPhaseKey(), 'post');
    } catch {
        /* private mode — accept the loss of phase distinction */
    }
};

// Append a journey entry. ``options.phase`` overrides the current phase
// (used for chat-phase markers); ``options.event`` attaches a whitelisted
// event name (chat_opened, handoff_requested, meeting_booked,
// offline_message_sent, chat_closed, lead_captured). Dedupes against the
// tail using the (path, phase, event) triple so a marker fired twice by
// racy UI code doesn't double-write.
const _appendJourneyEntry = (path, options = {}) => {
    if (typeof path !== 'string' || !path) return null;
    const trimmed = path.slice(0, JOURNEY_PATH_MAX_LEN);
    const phase = options.phase || _currentPhase();
    const event = typeof options.event === 'string' ? options.event : undefined;
    const entries = _readJourney();
    const last = entries[entries.length - 1];
    if (
        last &&
        last.path === trimmed &&
        last.phase === phase &&
        last.event === event
    ) {
        return null; // same-tail dedupe
    }
    const entry = { path: trimmed, ts: new Date().toISOString(), phase };
    if (event) entry.event = event;
    entries.push(entry);
    if (entries.length > JOURNEY_MAX_ENTRIES) {
        entries.splice(0, entries.length - JOURNEY_MAX_ENTRIES);
    }
    _writeJourney(entries);
    return entry;
};

// Throttled per-session flush of the full current journey to the
// backend. Multiple appends in a 10-second window coalesce into one
// POST (the pending timer sees the freshest journey since sessionStorage
// is the source of truth). Uses sendBeacon on pagehide so the last
// post-chat navigation still lands even if the tab is being torn down.
const _lastJourneyFlushAt = new Map(); // sessionId -> ms timestamp
const _pendingJourneyFlush = new Map(); // sessionId -> timeout id
let _pagehideHookInstalled = false;

const _flushJourneyNow = (sessionId, { beacon = false } = {}) => {
    if (!sessionId) return;
    _lastJourneyFlushAt.set(sessionId, Date.now());
    const pending = _pendingJourneyFlush.get(sessionId);
    if (pending) {
        clearTimeout(pending);
        _pendingJourneyFlush.delete(sessionId);
    }
    const journey = _readJourney();
    if (!journey.length) return;
    const payload = JSON.stringify({
        session_id: sessionId,
        journey,
    });
    if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        try {
            const blob = new Blob([payload], { type: 'application/json' });
            navigator.sendBeacon(`${API_URL}/chat/behavioral-signals`, blob);
            return;
        } catch {
            /* fall through to fetch */
        }
    }
    fetch(`${API_URL}/chat/behavioral-signals`, {
        method: 'POST',
        headers: getHeaders(),
        body: payload,
        keepalive: true,
    }).catch(() => {
        /* non-critical — dropped update just means the next tick catches up */
    });
};

const _installPagehideHook = (sessionIdRef) => {
    if (_pagehideHookInstalled || typeof window === 'undefined') return;
    _pagehideHookInstalled = true;
    const flush = () => {
        const id = typeof sessionIdRef === 'function' ? sessionIdRef() : sessionIdRef;
        if (id) _flushJourneyNow(id, { beacon: true });
    };
    try {
        window.addEventListener('pagehide', flush);
        window.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush();
        });
    } catch {
        /* very old browser — accept the loss of a final beacon */
    }
};

/**
 * Fire-and-forget throttled journey sync. Callers append entries via
 * ``_appendJourneyEntry`` (directly or through ``markChatEvent``) and
 * then invoke this to flush; multiple calls inside a 10-second window
 * coalesce into a single POST.
 */
export const sendJourneyUpdate = (sessionId) => {
    if (!sessionId) return;
    _installPagehideHook(() => sessionId);
    const now = Date.now();
    const last = _lastJourneyFlushAt.get(sessionId) || 0;
    const wait = Math.max(0, JOURNEY_FLUSH_THROTTLE_MS - (now - last));
    if (wait === 0) {
        _flushJourneyNow(sessionId);
        return;
    }
    if (_pendingJourneyFlush.has(sessionId)) return; // already scheduled
    const timer = setTimeout(() => _flushJourneyNow(sessionId), wait);
    _pendingJourneyFlush.set(sessionId, timer);
};

// Remembered by markChatEvent + collectPageContext so the SPA history
// hooks can flush post-phase page changes to the backend without every
// caller having to thread sessionId through history.pushState.
let _activeJourneySessionId = null;

const _appendAndMaybeFlush = (path) => {
    const before = _currentPhase();
    const entry = _appendJourneyEntry(path);
    if (!entry) return;
    // Once chat has been opened, SPA route changes are the interesting
    // "post-chat behavior" signal — flush them (throttled) to the
    // backend. Pre-chat navigations rely on the init POST + subsequent
    // markChatEvent flushes.
    if (before === 'post' && _activeJourneySessionId) {
        sendJourneyUpdate(_activeJourneySessionId);
    }
};

/**
 * Record a chat lifecycle marker (chat_opened / chat_closed) or a
 * conversion event (handoff_requested / meeting_booked /
 * offline_message_sent / lead_captured) anchored to the current page,
 * and trigger a flush. ``chat_opened`` also flips the phase flag so
 * every subsequent auto-appended pathname is tagged ``post``.
 */
export const markChatEvent = (sessionId, eventName) => {
    if (!eventName || typeof window === 'undefined') return;
    if (sessionId) _activeJourneySessionId = sessionId;
    const path = window.location?.pathname || '/';
    const entry = _appendJourneyEntry(path, { phase: 'chat', event: eventName });
    if (eventName === 'chat_opened') _flipToPostPhase();
    if (entry && _activeJourneySessionId) sendJourneyUpdate(_activeJourneySessionId);
};

let _journeyHooksInstalled = false;

/**
 * Install history listeners so SPA route changes append to the journey
 * without a full page reload. Idempotent — safe to call from every
 * collectPageContext invocation.
 */
const _installJourneyHooks = () => {
    if (_journeyHooksInstalled || typeof window === 'undefined') return;
    _journeyHooksInstalled = true;
    try {
        const origPush = window.history.pushState;
        const origReplace = window.history.replaceState;
        window.history.pushState = function (...args) {
            const ret = origPush.apply(this, args);
            _appendAndMaybeFlush(window.location.pathname);
            return ret;
        };
        window.history.replaceState = function (...args) {
            const ret = origReplace.apply(this, args);
            _appendAndMaybeFlush(window.location.pathname);
            return ret;
        };
        window.addEventListener('popstate', () => _appendAndMaybeFlush(window.location.pathname));
    } catch {
        /* host page may freeze history — accept the loss of SPA journey entries */
    }
};

/**
 * Record the visitor's current page in the journey and wire up SPA route hooks
 * — independent of whether the chat panel is mounted.
 *
 * Called on widget LOAD (the launcher renders on every page, chat open or not)
 * so "journey before chat" captures the pages a visitor browses BEFORE opening
 * the chat, not just the page where they happened to open it. Idempotent: the
 * history hooks install once, and same-path bursts dedupe.
 *
 * Also rehydrates ``_activeJourneySessionId`` from persisted chat state so
 * mid-chat page reloads keep flushing post-phase navigations to the
 * backend without waiting for the next markChatEvent to re-seed it.
 */
export const recordPageVisit = () => {
    if (typeof window === 'undefined') return;
    _appendAndMaybeFlush(window.location.pathname);
    _installJourneyHooks();
    if (!_activeJourneySessionId && _currentPhase() === 'post') {
        try {
            const botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || undefined;
            const persisted = readSessionId(botKey);
            if (persisted) {
                _activeJourneySessionId = persisted;
                _installPagehideHook(() => _activeJourneySessionId);
            }
        } catch {
            /* storage-keys unavailable — skip rehydration */
        }
    }
};

/**
 * Collect page context from the host page (URL, referrer, UTM params, journey).
 * Called on widget load and again when a session is created — reads from
 * window.location and document.referrer, and appends the current path to
 * the journey.
 */
export const collectPageContext = () => {
    const url = window.location.href;
    const referrer = document.referrer || '';
    const params = new URLSearchParams(window.location.search);

    const utm_params = {};
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
        const val = params.get(key);
        if (val) utm_params[key] = val;
    }

    // Detect return visit via localStorage fingerprint
    const botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || 'default';
    const visitorKey = `oyechats_visitor_${botKey}`;
    const existingVisitor = localStorage.getItem(visitorKey);
    const is_return_visit = !!existingVisitor;
    if (!existingVisitor) {
        localStorage.setItem(visitorKey, Date.now().toString());
    }

    // Track page view count in sessionStorage
    const pageCountKey = `oyechats_pages_${botKey}`;
    const currentCount = parseInt(sessionStorage.getItem(pageCountKey) || '0', 10) + 1;
    sessionStorage.setItem(pageCountKey, currentCount.toString());

    // Record this page in the journey and wire up SPA route hooks so any
    // subsequent history.pushState / popstate before the chat opens is
    // captured too.
    _appendJourneyEntry(window.location.pathname);
    _installJourneyHooks();

    return {
        page_url: url,
        referrer,
        utm_params: Object.keys(utm_params).length > 0 ? utm_params : null,
        is_return_visit,
        pages_viewed: currentCount,
        journey: _readJourney(),
        _load_time: performance.now(),
    };
};

/**
 * Send behavioral signals to the backend. Non-blocking, fire-and-forget.
 */
export const sendBehavioralSignals = async (sessionId, signals) => {
    try {
        const response = await fetch(`${API_URL}/chat/behavioral-signals`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                session_id: sessionId,
                page_url: signals.page_url || null,
                referrer: signals.referrer || null,
                utm_params: signals.utm_params || null,
                time_on_page: signals.time_on_page || null,
                pages_viewed: signals.pages_viewed || null,
                is_return_visit: signals.is_return_visit || false,
                journey: Array.isArray(signals.journey) && signals.journey.length > 0 ? signals.journey : null,
            }),
        });
        if (!response.ok) {
            console.warn('[OyeChats] Behavioral signals request failed:', response.status);
        }
    } catch (error) {
        // Non-critical — never block the chat experience
        console.warn('[OyeChats] Behavioral signals error:', error);
    }
};

/**
 * Send time-on-page via sendBeacon on page unload. Fire-and-forget, non-blocking.
 */
export const sendTimeOnPage = (sessionId, loadTime) => {
    if (!sessionId || !loadTime) return;
    const timeOnPage = (performance.now() - loadTime) / 1000; // Convert to seconds
    if (timeOnPage < 1) return; // Ignore sub-second visits

    const botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || 'default';
    const pageCountKey = `oyechats_pages_${botKey}`;
    const pagesViewed = parseInt(sessionStorage.getItem(pageCountKey) || '1', 10);

    const payload = JSON.stringify({
        session_id: sessionId,
        time_on_page: Math.round(timeOnPage),
        pages_viewed: pagesViewed,
    });

    const headers = getHeaders();
    const blob = new Blob([payload], { type: 'application/json' });

    // sendBeacon doesn't support custom headers, so fall back to fetch with keepalive
    try {
        fetch(`${API_URL}/chat/behavioral-signals`, {
            method: 'POST',
            headers,
            body: payload,
            keepalive: true,
        });
    } catch {
        // Last resort: sendBeacon (no auth headers, but backend may handle gracefully)
        navigator.sendBeacon?.(`${API_URL}/chat/behavioral-signals`, blob);
    }
};

export const getChatbotSettings = async () => {
    try {
        // Use the new bot-scoped public settings endpoint
        // Falls back gracefully — backend resolves bot from X-Bot-Key or X-API-Key
        const response = await fetch(`${API_URL}/bots/settings/public`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            // Fallback to legacy endpoint for old backends
            const fallback = await fetch(`${API_URL}/client/settings`, {
                headers: getHeaders()
            });
            if (!fallback.ok) throw new Error('Failed to fetch chatbot settings');
            return await fallback.json();
        }
        return await response.json();
    } catch (error) {
        console.error("Error fetching chatbot settings:", error);
        throw error;
    }
};
