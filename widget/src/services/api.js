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

        while (true) {
            const { done, value } = await reader.read();
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
                    try {
                        const finalMeta = JSON.parse(line.slice(15));
                        onFinalMetadata?.(finalMeta);
                    } catch { /* ignore parse errors */ }
                } else {
                    onChunk?.(line + '\n');
                }
            }

            // Flush partial content immediately — don't wait for a newline.
            // LLM tokens arrive without \n delimiters, so without this flush the
            // entire response would accumulate in buffer and appear all at once
            // at stream end. Guard against flushing a partial METADATA line.
            if (metadataReceived && buffer &&
                !buffer.startsWith('METADATA:') &&
                !buffer.startsWith('FINAL_METADATA:')) {
                onChunk?.(buffer);
                buffer = '';
            }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
            if (buffer.startsWith('FINAL_METADATA:')) {
                try {
                    const finalMeta = JSON.parse(buffer.slice(15));
                    onFinalMetadata?.(finalMeta);
                } catch { /* ignore */ }
            } else if (!buffer.startsWith('METADATA:')) {
                onChunk?.(buffer);
            }
        }
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

        // Also save lead info if provided
        if (formData.name || formData.email) {
            await submitLeadCapture(sessionId, {
                name: formData.name,
                email: formData.email,
            });
        }

        return await response.json();
    } catch (error) {
        console.error("Error requesting handoff:", error);
        throw error;
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
        const response = await fetch(`${API_URL}/offline-messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bot_key: window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || '',
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
