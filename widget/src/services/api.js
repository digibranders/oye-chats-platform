const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

const getHeaders = () => {
    const headers = {
        'Content-Type': 'application/json',
    };
    // Priority: X-Bot-Key (new multi-bot) > X-API-Key (legacy backward compat)
    if (window.OYECHAT_BOT_KEY) {
        headers['X-Bot-Key'] = window.OYECHAT_BOT_KEY;
    } else if (window.OYECHAT_API_KEY) {
        headers['X-API-Key'] = window.OYECHAT_API_KEY;
    } else {
        console.warn('[OyeChat] No Bot Key or API Key found! Chatbot requests may be blocked.');
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

export const getChatHistory = async (sessionId) => {
    try {
        const response = await fetch(`${API_URL}/chat/history/${sessionId}`, {
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
        const response = await fetch(`${API_URL}/agents/handoff`, {
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
        const botKey = window.OYECHAT_BOT_KEY || '';
        const response = await fetch(`${API_URL}/agents/departments/public?bot_key=${botKey}`);
        if (!response.ok) return { departments: [] };
        return await response.json();
    } catch (error) {
        console.error("Error fetching departments:", error);
        return { departments: [] };
    }
};

export const submitOfflineMessage = async (formData) => {
    try {
        const response = await fetch(`${API_URL}/offline-messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bot_key: window.OYECHAT_BOT_KEY || window.OYECHAT_API_KEY || '',
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
