import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getBots } from '../services/api';

const BotContext = createContext(null);

export function BotProvider({ children }) {
    const [bots, setBots] = useState([]);
    const [selectedBot, setSelectedBot] = useState(null);
    const [loading, setLoading] = useState(true);

    const refreshBots = useCallback(async () => {
        try {
            setLoading(true);
            const data = await getBots();
            setBots(data);

            if (data.length === 0) {
                // No bots exist — clear selection
                setSelectedBot(null);
                localStorage.removeItem('selected_bot_id');
            } else if (selectedBot) {
                // If we already have a selected bot, try to keep it
                const still = data.find(b => b.id === selectedBot.id);
                if (still) {
                    setSelectedBot(still);
                } else {
                    setSelectedBot(data[0]);
                }
            } else {
                // Check localStorage for last selected bot
                const savedId = localStorage.getItem('selected_bot_id');
                const saved = savedId ? data.find(b => b.id === Number(savedId)) : null;
                setSelectedBot(saved || data[0]);
            }
        } catch (err) {
            console.error('Failed to fetch bots:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const token = localStorage.getItem('admin_token');
        const authType = localStorage.getItem('auth_type');
        if (token && authType !== 'agent') {
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
