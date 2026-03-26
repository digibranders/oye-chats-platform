import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

const api = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        'Content-Type': 'application/json',
    },
    timeout: 30000,
});

// Request interceptor: inject API key
api.interceptors.request.use(
    (config) => {
        const token = localStorage.getItem('admin_token');
        if (token) {
            config.headers['X-API-Key'] = token;
        }
        return config;
    },
    (error) => Promise.reject(error)
);

// Response interceptor: handle auth errors globally
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            localStorage.removeItem('admin_token');
            localStorage.removeItem('admin_name');
            localStorage.removeItem('client_id');
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
        throw error.response?.data?.detail || error.message || 'Login failed';
    }
};

/**
 * Self-service client registration.
 * @param {string} name - Full name
 * @param {string} email - Email address
 * @param {string} password - Password (min 8 chars, letter + number)
 * @returns {Promise<Object>} The API response with access_token, client_id, name
 */
export const registerClient = async (name, email, password) => {
    try {
        const response = await api.post('/auth/register', { name, email, password });
        return response.data;
    } catch (error) {
        console.error('API Error during registration:', error);
        // Handle Pydantic validation errors (422) which come as array
        if (error.response?.status === 422) {
            const detail = error.response?.data?.detail;
            if (Array.isArray(detail) && detail.length > 0) {
                // Extract the readable message from Pydantic's error format
                const msg = detail[0]?.msg || detail[0]?.message || 'Validation error';
                throw msg.replace('Value error, ', '');
            }
        }
        throw error.response?.data?.detail || error.message || 'Registration failed';
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
        throw error.response?.data || error.message;
    }
};

/**
 * Submits a URL to be crawled and ingested.
 * @param {string} url - The root URL to start crawling
 * @returns {Promise<Object>} The API response with crawling results
 */
export const crawlWebsite = async (url, botId) => {
    try {
        const endpoint = botId ? `/crawl?bot_id=${botId}` : '/crawl';
        const response = await api.post(endpoint, { url });
        return response.data;
    } catch (error) {
        console.error('API Error during website crawl:', error);
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
    }
};


/**
 * Fetches aggregate statistics for the admin dashboard.
 * @returns {Promise<Object>} Object containing total counts
 */
export const getDashboardStats = async (botId) => {
    try {
        const url = botId ? `/analytics/dashboard?bot_id=${botId}` : '/analytics/dashboard';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching dashboard stats:', error);
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
    }
};

/**
 * Fetches the raw chat history for a specific session ID.
 * @param {string} sessionId
 * @returns {Promise<Array>} Array of chat message objects
 */
export const getChatHistory = async (sessionId) => {
    try {
        const response = await api.get(`/chat/history/${sessionId}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching chat history:', error);
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
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
                bant_enabled: bot.bant_enabled
            };
        }
        const response = await api.get('/client/settings');
        return response.data;
    } catch (error) {
        console.error('API Error fetching settings:', error);
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
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
        throw error.response?.data?.detail || error.message || 'Failed to create client';
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
        throw error.response?.data?.detail || error.message || 'Failed to delete client';
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
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
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
        throw error.response?.data?.detail || error.message || 'Failed to create bot';
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
        throw error.response?.data || error.message;
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
        throw error.response?.data || error.message;
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
        throw error.response?.data?.detail || error.message || 'Failed to delete bot';
    }
};
