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
        const botKey = window.OYECHATS_BOT_KEY || '';
        const response = await fetch(`${API_URL}/operators/departments/public?bot_key=${botKey}`);
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
