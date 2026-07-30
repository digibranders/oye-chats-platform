import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getBots } from '../services/api';
import { getAuthItem } from '../utils/authStorage';

const BotContext = createContext(null);

/**
 * localStorage sentinel meaning "All agents" - the workspace-aggregated scope
 * a multi-bot user picks from the shell BotSwitcher. Stored explicitly (rather
 * than as an absent key) so we can tell "user chose All" apart from "user has
 * never picked anything, default to All" if we ever need to.
 */
const ALL_BOTS_SENTINEL = 'all';
const STORAGE_KEY = 'selected_bot_id';

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
                // No bots exist - clear selection.
                setSelectedBot(null);
                localStorage.removeItem(STORAGE_KEY);
            } else {
                setSelectedBot((currentSelectedBot) => {
                    // Explicit "All agents" selection - preserve it across
                    // refreshes and workspace switches; only collapse to a
                    // single bot when the workspace has exactly one bot (in
                    // which case "All" and "that bot" are the same thing).
                    const savedRaw = localStorage.getItem(STORAGE_KEY);
                    if (currentSelectedBot === null && savedRaw === ALL_BOTS_SENTINEL) {
                        return data.length === 1 ? data[0] : null;
                    }
                    if (currentSelectedBot) {
                        const stillSelected = data.find((bot) => bot.id === currentSelectedBot.id);
                        // If the previously-selected bot is gone (deleted /
                        // workspace switch), fall back to All-agents when the
                        // user has more than one; otherwise to their only bot.
                        return stillSelected || (data.length === 1 ? data[0] : null);
                    }

                    // No in-memory selection yet - restore from localStorage.
                    if (savedRaw === ALL_BOTS_SENTINEL) return data.length === 1 ? data[0] : null;
                    if (savedRaw) {
                        const saved = data.find((bot) => bot.id === Number(savedRaw));
                        if (saved) return saved;
                    }
                    // Fresh session with no persisted choice - single-bot
                    // workspaces auto-pick their only bot; multi-bot ones
                    // default to All agents so the shell reads as
                    // workspace-wide until the user narrows it.
                    return data.length === 1 ? data[0] : null;
                });
            }
            // Return the freshly-loaded list so callers (e.g. the create flow)
            // can resolve a just-created bot without re-reading stale state.
            return data;
        } catch (err) {
            console.error('Failed to fetch bots:', err);
            setBots([]);
            setSelectedBot(null);
            setError({
                message: err?.message || 'Failed to load bots',
                status: err?.status || null,
            });
            return [];
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

    // Refetch the bot list whenever the workspace switcher changes context.
    // Bots are workspace-scoped (``Bot.client_id`` = the workspace owner id),
    // so a switch from workspace A to workspace B needs to pull B's bots or
    // the sidebar bot dropdown, ``selectedBot``, and every downstream page
    // stay pointed at A's data. The switcher already fires the abort
    // controller to cancel any A-scoped requests in flight; this listener
    // fires the fresh fetch under B.
    //
    // Listens for the ``oyechats:workspace-switched`` window event dispatched
    // by ``WorkspaceContext.switchWorkspace``. Guarded so it only fires when
    // there's still a valid token - if the switch was actually a logout
    // (rare edge case) the response interceptor will handle the auth clear.
    useEffect(() => {
        function onWorkspaceSwitched() {
            if (getAuthItem('admin_token')) {
                refreshBots();
            }
        }
        window.addEventListener('oyechats:workspace-switched', onWorkspaceSwitched);
        return () => window.removeEventListener('oyechats:workspace-switched', onWorkspaceSwitched);
    }, [refreshBots]);

    /**
     * Set the active bot scope. Pass a bot to scope every downstream page to
     * that agent; pass `null` for the workspace-aggregated "All agents" mode
     * (the shell BotSwitcher's default when the workspace has 2+ bots). The
     * choice is persisted so it survives reloads.
     */
    const selectBot = useCallback((bot) => {
        setSelectedBot(bot);
        if (bot?.id) {
            localStorage.setItem(STORAGE_KEY, bot.id.toString());
        } else {
            localStorage.setItem(STORAGE_KEY, ALL_BOTS_SENTINEL);
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
            // True when the user has explicitly chosen (or defaulted to) the
            // workspace-aggregated view. Semantic sugar so pages don't have to
            // remember that `selectedBot === null` carries this meaning.
            isAllAgents: selectedBot === null && bots.length > 0,
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
