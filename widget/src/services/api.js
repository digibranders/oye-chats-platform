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
// 35s = 30s server-side chunk timeout + 5s network RTT buffer.
const _STREAM_READ_TIMEOUT_MS = 35_000;

// ── Inline-card sentinel tokens ──
//
// The RAG prompt instructs the LLM to emit sentinels like [MEETING_CARD]
// or [LEAVE_MESSAGE_CARD] on their own line to trigger inline UI cards.
// The backend strips these from the PERSISTED ChatMessage and sets flags
// in FINAL_METADATA, but during streaming the raw chunks are yielded as
// they arrive — so without client-side scrubbing the token visibly
// flashes in the chat bubble. This helper sits between the stream reader
// and onChunk so the visitor never sees a stray token.
//
// Split-chunk correctness: LLM token boundaries can land inside a
// sentinel (e.g. chunk 1 ends with "[LEAVE_ME", chunk 2 starts with
// "SSAGE_CARD]"). The stripper holds back any trailing substring that
// could be the prefix of a known sentinel and releases it on the next
// push() or on flush() at stream end.
const _STREAM_SENTINELS = ['[LEAVE_MESSAGE_CARD]', '[MEETING_CARD]'];
const _MAX_SENTINEL_LEN = _STREAM_SENTINELS.reduce((m, s) => Math.max(m, s.length), 0);

const _stripAllSentinels = (text) => {
    let out = text;
    for (const s of _STREAM_SENTINELS) {
        // Use split+join for a literal (non-regex) global replace.
        if (out.includes(s)) out = out.split(s).join('');
    }
    return out;
};

const _createSentinelStripper = () => {
    let pending = '';
    return {
        /** Absorb a new chunk; return only the text safe to render. */
        push(chunk) {
            if (!chunk) return '';
            pending = _stripAllSentinels(pending + chunk);
            // Identify the longest trailing substring that could still be
            // the prefix of a sentinel — hold it back until more arrives.
            const maxHold = Math.min(_MAX_SENTINEL_LEN - 1, pending.length);
            let holdFrom = pending.length;
            for (let k = maxHold; k > 0; k--) {
                const tail = pending.slice(pending.length - k);
                if (_STREAM_SENTINELS.some((s) => s.startsWith(tail))) {
                    holdFrom = pending.length - k;
                    break;
                }
            }
            const emit = pending.slice(0, holdFrom);
            pending = pending.slice(holdFrom);
            return emit;
        },
        /** Stream is done — release anything still held, minus any late-completed sentinel. */
        flush() {
            const out = _stripAllSentinels(pending);
            pending = '';
            return out;
        },
    };
};

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

export const sendMessageStream = async (message, sessionId, { onMetadata, onChunk, onFinalMetadata, onError }) => {
    try {
        const response = await fetch(`${API_URL}/chat/stream`, {
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

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let metadataReceived = false;

        // All visible text funnels through this stripper so inline-card
        // sentinels (e.g. [LEAVE_MESSAGE_CARD]) never reach the UI — even
        // when they straddle chunk boundaries.
        const stripper = _createSentinelStripper();
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
 * Collect page context from the host page (URL, referrer, UTM params).
 * Called once on widget load — reads from window.location and document.referrer.
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

    return {
        page_url: url,
        referrer,
        utm_params: Object.keys(utm_params).length > 0 ? utm_params : null,
        is_return_visit,
        pages_viewed: currentCount,
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
