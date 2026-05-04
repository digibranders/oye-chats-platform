import axios from 'axios';
import { AUTH_STORAGE_KEYS } from '../utils/auth';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

const api = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        'Content-Type': 'application/json',
    },
    timeout: 30000,
});

const buildApiError = (error, fallbackMessage = 'Request failed') => {
    const status = error.response?.status;
    const data = error.response?.data;
    let detail = data?.detail;

    // Handle Pydantic 422 validation errors (detail is an array of error objects)
    if (status === 422 && Array.isArray(detail) && detail.length > 0) {
        const msg = detail[0]?.msg || detail[0]?.message || 'Validation error';
        detail = msg.replace('Value error, ', '');
    }

    // Structured FastAPI errors (e.g. 402 insufficient_credits) put a
    // human-readable string under detail.message — surface that instead of
    // letting axios's "Request failed with status code 402" leak through.
    let message;
    if (typeof detail === 'string') {
        message = detail;
    } else if (detail && typeof detail === 'object' && typeof detail.message === 'string') {
        message = detail.message;
    } else {
        message = error.message || fallbackMessage;
    }

    const apiError = new Error(message);
    apiError.status = status;
    apiError.data = data;
    return apiError;
};

// Request interceptor: inject API key (supports both Client and Operator auth)
api.interceptors.request.use(
    (config) => {
        const token = localStorage.getItem('admin_token');
        const authType = localStorage.getItem('auth_type'); // 'client' or 'operator'
        if (token) {
            if (authType === 'operator') {
                config.headers['X-Operator-Key'] = token;
            } else {
                config.headers['X-API-Key'] = token;
            }
        }
        return config;
    },
    (error) => Promise.reject(error)
);

// Response interceptor: handle auth errors globally
api.interceptors.response.use(
    (response) => response,
    (error) => {
        const status = error.response?.status;
        const authType = localStorage.getItem('auth_type');
        const detail = (error.response?.data?.detail || '').toString().toLowerCase();
        const requestUrl = (error.config?.url || '').toString();

        const isLoginAttempt = requestUrl.includes('/auth/login') || requestUrl.includes('/auth/operator-login');
        const isOperatorOnClientOnlyEndpoint = authType === 'operator' && detail.includes('api key');

        if (status === 401 && !isLoginAttempt && !isOperatorOnClientOnlyEndpoint) {
            AUTH_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
            if (window.location.pathname !== '/login') {
                window.location.href = '/login';
            }
        }
        return Promise.reject(error);
    }
);

/**
 * Authenticate admin and receive API Key
 * @param {string} email 
 * @param {string} password 
 * @returns {Promise<Object>} The API response with access_token and name
 */
export const loginAdmin = async (email, password) => {
    try {
        const response = await api.post('/auth/login', { email, password });
        return response.data;
    } catch (error) {
        console.error('API Error during login:', error);
        throw buildApiError(error, 'Login failed');
    }
};

/**
 * Self-service client registration.
 * @param {string} name - Full name
 * @param {string} email - Email address
 * @param {string} password - Password (min 8 chars, letter + number)
 * @param {string|null} companyName - Optional company name
 * @returns {Promise<Object>} The API response with access_token, client_id, name
 */
export const registerClient = async (name, email, password, companyName = null, website = null) => {
    try {
        const response = await api.post('/auth/register', { name, email, password, company_name: companyName, website });
        return response.data;
    } catch (error) {
        console.error('API Error during registration:', error);
        throw buildApiError(error, 'Registration failed');
    }
};

/**
 * Request a password reset OTP
 * @param {string} email
 * @returns {Promise<Object>} API response
 */
export const requestPasswordReset = async (email) => {
    try {
        const response = await api.post('/auth/request-password-reset', { email });
        return response.data;
    } catch (error) {
        console.error('API Error requesting password reset:', error);
        throw buildApiError(error, 'Failed to request reset');
    }
};

/**
 * Verify OTP and reset password
 * @param {string} email
 * @param {string} otp
 * @param {string} new_password
 * @returns {Promise<Object>} API response
 */
export const resetPassword = async (email, otp, new_password) => {
    try {
        const response = await api.post('/auth/reset-password', { email, otp, new_password });
        return response.data;
    } catch (error) {
        console.error('API Error resetting password:', error);
        throw buildApiError(error, 'Failed to reset password');
    }
};

/**
 * Uploads multiple PDF documents to the ingestion endpoint.
 * @param {File[]} files - An array of File objects (must be PDFs)
 * @returns {Promise<Object>} The API response with upload results
 */
export const uploadDocuments = async (files, botId) => {
    const formData = new FormData();

    files.forEach((file) => {
        formData.append('files', file);
    });

    try {
        const url = botId ? `/ingest?bot_id=${botId}` : '/ingest';
        const response = await api.post(url, formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        });
        return response.data;
    } catch (error) {
        console.error('API Error during document upload:', error);
        throw buildApiError(error, 'Document upload failed');
    }
};

/**
 * Poll the current crawl progress (URLs discovered so far).
 * Lightweight — just a temp-file read on the server, no DB.
 * @returns {Promise<{urls: string[]}>}
 */
export const getCrawlProgress = async () => {
    try {
        const response = await api.get('/crawl/progress');
        return response.data;
    } catch {
        return { urls: [] };
    }
};

/**
 * Submits a URL to be crawled and ingested.
 * @param {string} url - The root URL to start crawling
 * @param {number|undefined} botId - Optional bot ID to scope the crawl
 * @param {boolean} useJs - Enable JavaScript mode for Next.js / React / SPA sites
 * @returns {Promise<Object>} The API response with crawling results
 */
export const crawlWebsite = async (url, botId, useJs = false, replaceSource = null) => {
    try {
        const endpoint = botId ? `/crawl?bot_id=${botId}` : '/crawl';
        const body = { url, use_js: useJs };
        if (replaceSource) body.replace_source = replaceSource;
        const response = await api.post(endpoint, body, { timeout: 300000 });
        return response.data;
    } catch (error) {
        console.error('API Error during website crawl:', error);
        throw buildApiError(error, 'Website crawl failed');
    }
};

/**
 * Fetches the list of ingested documents and their chunk counts.
 * @returns {Promise<Array>} List of document objects
 */
export const getDocuments = async (botId) => {
    try {
        const url = botId ? `/documents?bot_id=${botId}` : '/documents';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching documents:', error);
        throw buildApiError(error, 'Failed to load documents');
    }
};

/**
 * Deletes a document and all its vector chunks by name.
 * @param {string} documentName - The document name (filename or URL)
 * @returns {Promise<Object>} Deletion result
 */
export const deleteDocument = async (documentName, botId) => {
    try {
        const url = botId
            ? `/documents/${encodeURIComponent(documentName)}?bot_id=${botId}`
            : `/documents/${encodeURIComponent(documentName)}`;
        const response = await api.delete(url);
        return response.data;
    } catch (error) {
        console.error('API Error deleting document:', error);
        throw buildApiError(error, 'Failed to delete document');
    }
};


/**
 * Fetches all crawled page URLs for a website source.
 * @param {string} source - Normalized root domain (e.g. "fynix.digital")
 * @param {number|null} botId - Optional bot ID
 * @returns {Promise<Object>} { domain, total_pages, total_chunks, pages: [...] }
 */
export const getDocumentPages = async (source, botId) => {
    try {
        const params = new URLSearchParams({ source });
        if (botId) params.set('bot_id', botId);
        const response = await api.get(`/documents/pages?${params.toString()}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching document pages:', error);
        throw buildApiError(error, 'Failed to load source pages');
    }
};

/**
 * Fetches aggregate statistics for the admin dashboard.
 * @returns {Promise<Object>} Object containing total counts
 */
export const getDashboardStats = async (botId, days = null) => {
    try {
        const params = new URLSearchParams();
        if (botId) params.set('bot_id', botId);
        if (days) params.set('days', days);
        const query = params.toString();
        const url = query ? `/analytics/dashboard?${query}` : '/analytics/dashboard';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching dashboard stats:', error);
        throw buildApiError(error, 'Failed to load dashboard stats');
    }
};

/**
 * Fetches message activity grouped by date for charts.
 * @param {number} days - Number of days to fetch (optional, handled by backend)
 * @returns {Promise<Array>} Array of { date, messages }
 */
export const getActivityStats = async (botId) => {
    try {
        const url = botId ? `/analytics/activity?bot_id=${botId}` : '/analytics/activity';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching activity stats:', error);
        throw buildApiError(error, 'Failed to load activity data');
    }
};

export const getRatingsSummary = async (botId) => {
    try {
        const url = botId ? `/analytics/ratings-summary?bot_id=${botId}` : '/analytics/ratings-summary';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching ratings summary:', error);
        throw buildApiError(error, 'Failed to load ratings summary');
    }
};

export const getResolutionSummary = async (botId) => {
    try {
        const url = botId ? `/analytics/resolution-summary?bot_id=${botId}` : '/analytics/resolution-summary';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching resolution summary:', error);
        throw buildApiError(error, 'Failed to load resolution summary');
    }
};

/**
 * Fetches the list of visitors/sessions for the admin dashboard.
 * @returns {Promise<Array>} List of visitor session objects
 */
export const getVisitorsData = async (botId) => {
    try {
        const url = botId ? `/analytics/visitors?bot_id=${botId}` : '/analytics/visitors';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching visitors data:', error);
        throw buildApiError(error, 'Failed to load visitor data');
    }
};

/**
 * Fetches the raw chat history for a specific session ID.
 * @param {string} sessionId
 * @param {{ beforeId?: number, limit?: number }} options - Pagination options
 * @returns {Promise<Array>} Array of chat message objects
 */
export const getChatHistory = async (sessionId, { beforeId, limit = 50 } = {}) => {
    try {
        const params = { limit };
        if (beforeId != null) params.before = beforeId;
        const response = await api.get(`/chat/history/${sessionId}`, { params });
        return response.data;
    } catch (error) {
        console.error('API Error fetching chat history:', error);
        throw buildApiError(error, 'Failed to load chat history');
    }
};

/**
 * Fetches all feedback data for the admin dashboard.
 * @returns {Promise<Array>} Array of feedback objects
 */
export const getFeedbackData = async (botId) => {
    try {
        const url = botId ? `/analytics/feedback?bot_id=${botId}` : '/analytics/feedback';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching feedback data:', error);
        throw buildApiError(error, 'Failed to load feedback');
    }
};

/**
 * Fetches the most common user queries.
 * @returns {Promise<Array>} Array of { question, count }
 */
export const getTopQuestions = async (botId) => {
    try {
        const url = botId ? `/analytics/top-questions?bot_id=${botId}` : '/analytics/top-questions';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching top questions:', error);
        throw buildApiError(error, 'Failed to load top questions');
    }
};

/**
 * Fetches chatbot customization settings.
 * Uses bot-scoped endpoint if botId provided, otherwise legacy /client/settings.
 * @param {number} [botId] - Optional bot ID
 * @returns {Promise<Object>} Settings object
 */
export const getClientSettings = async (botId) => {
    try {
        if (botId) {
            const response = await api.get(`/bots/${botId}`);
            // Map bot response fields to match the legacy settings format
            const bot = response.data;
            return {
                bot_name: bot.name,
                bot_logo: bot.bot_logo,
                launcher_name: bot.launcher_name,
                launcher_logo: bot.launcher_logo,
                primary_color: bot.primary_color,
                background_color: bot.background_color,
                header_color: bot.header_color,
                recommended_colors: bot.recommended_colors || [],
                bant_enabled: bot.bant_enabled,
                avatar_type: bot.avatar_type,
                orb_color: bot.orb_color,
                lead_form_enabled: bot.lead_form_enabled,
                lead_form_fields: bot.lead_form_fields,
                notification_email: bot.notification_email,
                email_on_qualified: bot.email_on_qualified,
                email_on_handoff: bot.email_on_handoff,
                operator_timeout_seconds: bot.operator_timeout_seconds
            };
        }
        const response = await api.get('/client/settings');
        return response.data;
    } catch (error) {
        console.error('API Error fetching settings:', error);
        throw buildApiError(error, 'Failed to load settings');
    }
};

/**
 * Updates chatbot customization settings.
 * Uses bot-scoped endpoint if botId provided.
 * @param {Object} settings - Object containing settings to update
 * @param {number} [botId] - Optional bot ID
 * @returns {Promise<Object>} Result message
 */
export const updateClientSettings = async (settings, botId) => {
    try {
        if (botId) {
            // Map legacy field names to bot model fields
            const botSettings = { ...settings };
            if ('bot_name' in botSettings) {
                botSettings.name = botSettings.bot_name;
                delete botSettings.bot_name;
            }
            const response = await api.patch(`/bots/${botId}`, botSettings);
            return response.data;
        }
        const response = await api.patch('/client/settings', settings);
        return response.data;
    } catch (error) {
        console.error('API Error updating settings:', error);
        throw buildApiError(error, 'Failed to update settings');
    }
};

/**
 * Uploads a logo file to Backblaze B2 via the backend.
 * @param {File} file - The image file to upload
 * @returns {Promise<Object>} The API response with the public URL
 */
export const uploadLogo = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
        const response = await api.post('/client/upload-logo', formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        });
        return response.data;
    } catch (error) {
        console.error('API Error uploading logo:', error);
        throw buildApiError(error, 'Failed to upload logo');
    }
};

// --- SUPERADMIN ENDPOINTS ---

/**
 * Superadmin: Fetches global system statistics.
 * @returns {Promise<Object>} Aggregated metrics object
 */
export const getGlobalStats = async () => {
    try {
        const response = await api.get('/superadmin/stats');
        return response.data;
    } catch (error) {
        console.error('API Error fetching global stats:', error);
        throw buildApiError(error, 'Failed to load stats');
    }
};

/**
 * Superadmin: Fetches all clients on the platform.
 * @returns {Promise<Array>} List of client objects
 */
export const getClients = async () => {
    try {
        const response = await api.get('/superadmin/clients');
        return response.data;
    } catch (error) {
        console.error('API Error fetching clients:', error);
        throw buildApiError(error, 'Failed to load clients');
    }
};

/**
 * Superadmin: Creates a new client.
 * @param {string} name 
 * @param {string} email 
 * @param {string} password 
 * @returns {Promise<Object>} The API response with new client API key
 */
export const createClient = async (name, email, password, website = '') => {
    try {
        const response = await api.post('/superadmin/clients', { name, email, password, website });
        return response.data;
    } catch (error) {
        console.error('API Error creating client:', error);
        throw buildApiError(error, 'Failed to create client');
    }
};

/**
 * Superadmin: Deletes a client and all their data (bots, documents, sessions).
 * @param {number} clientId - The client ID to delete
 * @returns {Promise<Object>} Deletion confirmation
 */
export const deleteClient = async (clientId) => {
    try {
        const response = await api.delete(`/superadmin/clients/${clientId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting client:', error);
        throw buildApiError(error, 'Failed to delete client');
    }
};

/**
 * Superadmin: Fetches all feedback across the platform.
 * @returns {Promise<Array>} List of global feedback objects
 */
export const getGlobalFeedbackData = async () => {
    try {
        const response = await api.get('/superadmin/feedback');
        return response.data;
    } catch (error) {
        console.error('API Error fetching global feedback:', error);
        throw buildApiError(error, 'Failed to load feedback');
    }
};

// --- BOT CRUD ENDPOINTS ---

/**
 * Fetches all bots for the authenticated client.
 * @returns {Promise<Array>} List of bot objects
 */
export const getBots = async () => {
    try {
        const response = await api.get('/bots');
        return response.data;
    } catch (error) {
        console.error('API Error fetching bots:', error);
        throw buildApiError(error, 'Failed to load bots');
    }
};

/**
 * Creates a new bot.
 * @param {Object} data - { name, website?, system_prompt? }
 * @returns {Promise<Object>} Created bot info
 */
export const createBot = async (data) => {
    try {
        const response = await api.post('/bots', data);
        return response.data;
    } catch (error) {
        console.error('API Error creating bot:', error);
        throw buildApiError(error, 'Failed to create bot');
    }
};

/**
 * Gets details of a specific bot.
 * @param {number} botId
 * @returns {Promise<Object>} Bot details
 */
export const getBot = async (botId) => {
    try {
        const response = await api.get(`/bots/${botId}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching bot:', error);
        throw buildApiError(error, 'Failed to load bot');
    }
};

export const getFrameworkPresets = async (botId) => {
    try {
        const response = await api.get(`/bots/${botId}/framework-presets`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching framework presets:', error);
        throw buildApiError(error, 'Failed to load framework presets');
    }
};

/**
 * Updates a bot's settings.
 * @param {number} botId
 * @param {Object} data - Settings to update
 * @returns {Promise<Object>} Result message
 */
export const updateBot = async (botId, data) => {
    try {
        const response = await api.patch(`/bots/${botId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating bot:', error);
        throw buildApiError(error, 'Failed to update bot');
    }
};

/**
 * Deletes a bot and all its data.
 * @param {number} botId
 * @returns {Promise<Object>} Result message
 */
export const deleteBot = async (botId) => {
    try {
        const response = await api.delete(`/bots/${botId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting bot:', error);
        throw buildApiError(error, 'Failed to delete bot');
    }
};

export const getBotDemoUrl = (botKey) => `${API_BASE_URL}/demo/${botKey}`;

export const getBotPreviewUrl = (botKey, websiteUrl, { edit = false } = {}) => {
    const base = `${API_BASE_URL}/demo/${botKey}`;
    const params = new URLSearchParams();
    if (websiteUrl) {
        const normalized = /^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`;
        params.set('url', normalized);
    }
    if (edit) params.set('edit', '1');
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
};

export const getBotDemoOrigin = () => {
    try {
        return new URL(API_BASE_URL).origin;
    } catch {
        return API_BASE_URL;
    }
};

export const trackDemoShareClick = async (botId) => {
    try {
        const response = await api.post(`/bots/${botId}/demo-share-click`);
        return response.data;
    } catch (error) {
        console.error('API Error tracking demo share click:', error);
        throw buildApiError(error, 'Failed to track demo share');
    }
};

// ── Lead Management ──

export const getLeads = async (botId, params = {}) => {
    try {
        const query = new URLSearchParams();
        if (botId) query.set('bot_id', botId);
        if (params.status) query.set('status', params.status);
        if (params.min_score != null) query.set('min_score', params.min_score);
        if (params.page) query.set('page', params.page);
        if (params.limit) query.set('limit', params.limit);
        const response = await api.get(`/leads?${query.toString()}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching leads:', error);
        throw buildApiError(error, 'Failed to load leads');
    }
};

export const getLeadDetail = async (sessionId) => {
    try {
        const response = await api.get(`/leads/${sessionId}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching lead detail:', error);
        throw buildApiError(error, 'Failed to load lead detail');
    }
};

export const getLeadStats = async (botId) => {
    try {
        const query = botId ? `?bot_id=${botId}` : '';
        const response = await api.get(`/leads/stats${query}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching lead stats:', error);
        throw buildApiError(error, 'Failed to load lead stats');
    }
};

export const getQualificationFunnel = async (botId, period = '30d') => {
    try {
        const response = await api.get(`/analytics/qualification-funnel?bot_id=${botId}&period=${period}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching qualification funnel:', error);
        throw buildApiError(error, 'Failed to load qualification funnel');
    }
};

export const exportLeadsCsv = async (botId) => {
    try {
        const query = botId ? `?bot_id=${botId}` : '';
        const response = await api.get(`/leads/export${query}`, { responseType: 'blob' });
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', 'oyechats-leads.csv');
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
    } catch (error) {
        console.error('API Error exporting leads:', error);
        throw buildApiError(error, 'Failed to export leads');
    }
};

// Mark a single lead as viewed (idempotent, 204 no body). Fire-and-forget on drawer open.
export const markLeadViewed = async (sessionId) => {
    try {
        await api.post(`/leads/${sessionId}/view`);
    } catch (error) {
        console.error('API Error marking lead viewed:', error);
        throw buildApiError(error, 'Failed to mark lead as read');
    }
};

// Bulk-clear unread leads for a bot (or all of the caller's bots).
export const markAllLeadsViewed = async (botId) => {
    try {
        const query = botId ? `?bot_id=${botId}` : '';
        await api.post(`/leads/mark-all-viewed${query}`);
    } catch (error) {
        console.error('API Error marking all leads viewed:', error);
        throw buildApiError(error, 'Failed to mark all leads as read');
    }
};

// ── Webhooks ──

export const getWebhooks = async (botId) => {
    try {
        const response = await api.get(`/webhooks?bot_id=${botId}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching webhooks:', error);
        throw buildApiError(error, 'Failed to load webhooks');
    }
};

export const createWebhook = async (botId, data) => {
    try {
        const response = await api.post(`/webhooks?bot_id=${botId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error creating webhook:', error);
        throw buildApiError(error, 'Failed to create webhook');
    }
};

export const updateWebhook = async (webhookId, data) => {
    try {
        const response = await api.patch(`/webhooks/${webhookId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating webhook:', error);
        throw buildApiError(error, 'Failed to update webhook');
    }
};

export const deleteWebhook = async (webhookId) => {
    try {
        const response = await api.delete(`/webhooks/${webhookId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting webhook:', error);
        throw buildApiError(error, 'Failed to delete webhook');
    }
};

export const getWebhookDeliveries = async (webhookId, page = 1) => {
    try {
        const response = await api.get(`/webhooks/${webhookId}/deliveries?page=${page}&limit=50`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching webhook deliveries:', error);
        throw buildApiError(error, 'Failed to load webhook deliveries');
    }
};

export const testWebhook = async (webhookId) => {
    try {
        const response = await api.post(`/webhooks/${webhookId}/test`);
        return response.data;
    } catch (error) {
        console.error('API Error sending test webhook:', error);
        throw buildApiError(error, 'Failed to send test event');
    }
};

// ── Live Chat / Operator ──

export const getOperatorQueue = async () => {
    try {
        const response = await api.get('/operators/queue');
        return response.data;
    } catch (error) {
        console.error('API Error fetching queue:', error);
        throw buildApiError(error, 'Failed to load queue');
    }
};

export const acceptChat = async (sessionId, operatorId = null) => {
    try {
        // Pass operatorId in the body so the backend uses the exact operator record
        // rather than the fragile `.limit(1)` fallback (critical for owner accounts).
        const body = operatorId ? { operator_id: operatorId } : {};
        const response = await api.post(`/operators/accept/${sessionId}`, body);
        return response.data;
    } catch (error) {
        console.error('API Error accepting chat:', error);
        throw buildApiError(error, 'Failed to accept chat');
    }
};

export const closeOperatorChat = async (sessionId) => {
    try {
        const response = await api.post(`/operators/close/${sessionId}`);
        return response.data;
    } catch (error) {
        console.error('API Error closing chat:', error);
        throw buildApiError(error, 'Failed to close chat');
    }
};

export const transferChat = async (sessionId, data) => {
    try {
        const response = await api.post(`/operators/transfer/${sessionId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error transferring chat:', error);
        throw buildApiError(error, 'Failed to transfer chat');
    }
};

export const toggleOperatorStatus = async () => {
    try {
        const response = await api.post('/operators/status');
        return response.data;
    } catch (error) {
        console.error('API Error toggling status:', error);
        throw buildApiError(error, 'Failed to toggle status');
    }
};

export const getMyOperatorStatus = async () => {
    try {
        const response = await api.get('/operators/me/status');
        return response.data;
    } catch (error) {
        console.error('API Error getting operator status:', error);
        return null;
    }
};

export const getSessionDetails = async (sessionId) => {
    try {
        const response = await api.get(`/operators/session/${sessionId}/details`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching session details:', error);
        throw buildApiError(error, 'Failed to load session details');
    }
};

// ── Operator Login ──

export const loginOperator = async (email, password) => {
    try {
        const response = await api.post('/auth/operator-login', { email, password });
        return response.data;
    } catch (error) {
        console.error('API Error operator login:', error);
        throw buildApiError(error, 'Login failed');
    }
};

export const operatorChangePassword = async (currentPassword, newPassword) => {
    try {
        const response = await api.post('/auth/operator-change-password', {
            current_password: currentPassword,
            new_password: newPassword,
        });
        return response.data;
    } catch (error) {
        console.error('API Error operator change password:', error);
        throw buildApiError(error, 'Failed to change password');
    }
};

// ── Operator Management ──

export const getOperators = async () => {
    try {
        const response = await api.get('/operators');
        return response.data;
    } catch (error) {
        console.error('API Error fetching operators:', error);
        throw buildApiError(error, 'Failed to load operators');
    }
};

export const createOperator = async (data) => {
    try {
        const response = await api.post('/operators/create', data);
        return response.data;
    } catch (error) {
        console.error('API Error creating operator:', error);
        throw buildApiError(error, 'Failed to create operator');
    }
};

export const updateOperator = async (operatorId, data) => {
    try {
        const response = await api.patch(`/operators/${operatorId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating operator:', error);
        throw buildApiError(error, 'Failed to update operator');
    }
};

export const deleteOperator = async (operatorId) => {
    try {
        const response = await api.delete(`/operators/${operatorId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting operator:', error);
        throw buildApiError(error, 'Failed to delete operator');
    }
};

// ── Department Management ──

export const getDepartments = async () => {
    try {
        const response = await api.get('/operators/departments');
        return response.data;
    } catch (error) {
        console.error('API Error fetching departments:', error);
        throw buildApiError(error, 'Failed to load departments');
    }
};

export const createDepartment = async (data) => {
    try {
        const response = await api.post('/operators/departments', data);
        return response.data;
    } catch (error) {
        console.error('API Error creating department:', error);
        throw buildApiError(error, 'Failed to create department');
    }
};

export const updateDepartment = async (departmentId, data) => {
    try {
        const response = await api.patch(`/operators/departments/${departmentId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating department:', error);
        throw buildApiError(error, 'Failed to update department');
    }
};

export const deleteDepartment = async (departmentId) => {
    try {
        const response = await api.delete(`/operators/departments/${departmentId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting department:', error);
        throw buildApiError(error, 'Failed to delete department');
    }
};

// ── Offline Messages ──

export const getOfflineMessages = async (params = {}) => {
    try {
        const response = await api.get('/offline-messages', { params });
        return response.data;
    } catch (error) {
        console.error('API Error fetching offline messages:', error);
        throw buildApiError(error, 'Failed to load messages');
    }
};

export const updateOfflineMessage = async (messageId, data) => {
    try {
        const response = await api.patch(`/offline-messages/${messageId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating offline message:', error);
        throw buildApiError(error, 'Failed to update message');
    }
};

export const deleteOfflineMessage = async (messageId) => {
    try {
        const response = await api.delete(`/offline-messages/${messageId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting offline message:', error);
        throw buildApiError(error, 'Failed to delete message');
    }
};

// ── Canned Responses ──

export const getCannedResponses = async (category = null) => {
    try {
        const params = category ? { category } : {};
        const response = await api.get('/canned-responses', { params });
        return response.data;
    } catch (error) {
        console.error('API Error fetching canned responses:', error);
        throw buildApiError(error, 'Failed to load responses');
    }
};

export const createCannedResponse = async (data) => {
    try {
        const response = await api.post('/canned-responses', data);
        return response.data;
    } catch (error) {
        console.error('API Error creating canned response:', error);
        throw buildApiError(error, 'Failed to create response');
    }
};

export const updateCannedResponse = async (responseId, data) => {
    try {
        const response = await api.patch(`/canned-responses/${responseId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating canned response:', error);
        throw buildApiError(error, 'Failed to update response');
    }
};

export const deleteCannedResponse = async (responseId) => {
    try {
        const response = await api.delete(`/canned-responses/${responseId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting canned response:', error);
        throw buildApiError(error, 'Failed to delete response');
    }
};

/**
 * Uploads a file during a live chat session (operator side).
 * Uses multipart/form-data. Returns { file_url, filename, content_type }.
 * @param {File} file
 * @param {string} sessionId
 * @returns {Promise<{ file_url: string, filename: string, content_type: string }>}
 */
export const uploadOperatorChatFile = async (file, sessionId) => {
    try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await api.post(
            `/operators/upload-chat-file?session_id=${sessionId}`,
            formData,
            { headers: { 'Content-Type': 'multipart/form-data' } }
        );
        return response.data;
    } catch (error) {
        console.error('API Error uploading operator chat file:', error);
        throw buildApiError(error, 'Failed to upload file');
    }
};

// --- SUBSCRIPTION & BILLING ENDPOINTS ---

export const getSubscriptionPlans = async () => {
    try {
        const response = await api.get('/subscriptions/plans');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load plans');
    }
};

export const getCurrentSubscription = async () => {
    try {
        const response = await api.get('/subscriptions/current');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load subscription');
    }
};

export const getSubscriptionUsage = async () => {
    try {
        const response = await api.get('/subscriptions/usage');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load usage data');
    }
};

export const getInvoices = async () => {
    try {
        const response = await api.get('/subscriptions/invoices');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load invoices');
    }
};

export const createCheckoutSession = async (planId, billingCycle = 'monthly') => {
    try {
        const response = await api.post('/subscriptions/checkout', {
            plan_id: planId,
            billing_cycle: billingCycle,
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to create checkout session');
    }
};

export const changePlan = async (planId, billingCycle = null) => {
    try {
        const response = await api.post('/subscriptions/change-plan', {
            plan_id: planId,
            billing_cycle: billingCycle,
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to change plan');
    }
};

export const cancelSubscription = async (reason = null) => {
    try {
        const response = await api.post('/subscriptions/cancel', { reason });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to cancel subscription');
    }
};

export const resumeSubscription = async () => {
    try {
        const response = await api.post('/subscriptions/resume');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to resume subscription');
    }
};

export const getBillingPortalUrl = async () => {
    try {
        const response = await api.post('/subscriptions/portal');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to open billing portal');
    }
};

// --- CREDITS & TOP-UPS ---

export const getCreditBalance = async () => {
    try {
        const response = await api.get('/credits/balance');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load credit balance');
    }
};

export const getCreditHistory = async ({ page = 1, limit = 50 } = {}) => {
    try {
        const response = await api.get('/credits/history', { params: { page, limit } });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load credit history');
    }
};

export const getTopupPacks = async () => {
    try {
        const response = await api.get('/credits/packs');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load top-up packs');
    }
};

/**
 * Initiate a top-up purchase.
 *
 * Returns provider-specific payload:
 *   - Razorpay: { provider:'razorpay', order_id, amount, currency, key_id, name,
 *                 description, prefill, theme, credits, bonus_pct, receipt }
 *   - Stripe:   { provider:'stripe', checkout_url, session_id }
 *
 * The caller passes `amount` in the configured currency's major unit (rupees
 * for INR, dollars for USD). `pack_usd` is accepted as a legacy alias.
 */
export const initiateTopup = async (amount, { provider } = {}) => {
    try {
        const response = await api.post('/credits/topup', { amount, provider });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to start top-up checkout');
    }
};

/**
 * Server-verify the Razorpay Checkout success callback.
 * Required for defence-in-depth — never trust the modal-only success path.
 */
export const verifyTopupPayment = async ({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) => {
    try {
        const response = await api.post('/credits/topup/verify', {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Could not verify payment');
    }
};

export const changeOperatorSeats = async (delta) => {
    try {
        const response = await api.post('/subscriptions/seats', { delta });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to update operator seats');
    }
};
