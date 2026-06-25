import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getBots } from '../services/api';
import { getAuthItem } from '../utils/authStorage';

const BotContext = createContext(null);

export function BotProvider({ children }) {
    const [bots, setBots] = useState([]);
    const [selectedBot, setSelectedBot] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const refreshBots = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const data = await getBots();
            setBots(data);

            if (data.length === 0) {
                // No bots exist — clear selection
                setSelectedBot(null);
                localStorage.removeItem('selected_bot_id');
            } else {
                setSelectedBot((currentSelectedBot) => {
                    if (currentSelectedBot) {
                        const stillSelected = data.find((bot) => bot.id === currentSelectedBot.id);
                        return stillSelected || data[0];
                    }

                    // Check localStorage for last selected bot
                    const savedId = localStorage.getItem('selected_bot_id');
                    const saved = savedId ? data.find((bot) => bot.id === Number(savedId)) : null;
                    return saved || data[0];
                });
            }
        } catch (err) {
            console.error('Failed to fetch bots:', err);
            setBots([]);
            setSelectedBot(null);
            setError({
                message: err?.message || 'Failed to load bots',
                status: err?.status || null,
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const token = getAuthItem('admin_token');
        if (token) {
            refreshBots();
        } else {
            setLoading(false);
        }
    }, [refreshBots]);

    const selectBot = useCallback((bot) => {
        setSelectedBot(bot);
        if (bot?.id) {
            localStorage.setItem('selected_bot_id', bot.id.toString());
        }
    }, []);

    return (
        <BotContext.Provider value={{
            bots,
            selectedBot,
            selectBot,
            refreshBots,
            loading,
            error,
        }}>
            {children}
        </BotContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBotContext() {
    const ctx = useContext(BotContext);
    if (!ctx) {
        throw new Error('useBotContext must be used within a BotProvider');
    }
    return ctx;
}
