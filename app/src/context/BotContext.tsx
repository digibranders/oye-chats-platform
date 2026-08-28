import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { Bot } from '../types/domain';
import { getBots } from '../services/api';
import { getAuthItem } from '../utils/authStorage';
import { isImpersonating } from '../utils/impersonation';
import { t as translateNow } from '../i18n/i18n';

export interface BotContextValue {
  bots: Bot[];
  /** The active bot scope. `null` means "All agents" (workspace-aggregated). */
  selectedBot: Bot | null;
  /** Set the active bot scope. Pass `null` to select the All-agents view. */
  selectBot: (bot: Bot | null) => void;
  refreshBots: () => Promise<Bot[]>;
  loading: boolean;
  error: { message: string; status: number | null } | null;
  /** True when the user is viewing the workspace-aggregated scope. */
  isAllAgents: boolean;
}

const BotContext = createContext<BotContextValue | null>(null);

/**
 * localStorage sentinel meaning "All agents" - the workspace-aggregated scope
 * a multi-bot user picks from the shell BotSwitcher. Stored explicitly (rather
 * than as an absent key) so we can tell "user chose All" apart from "user has
 * never picked anything, default to All" if we ever need to.
 */
const ALL_BOTS_SENTINEL = 'all';
const STORAGE_KEY = 'selected_bot_id';

/**
 * ``selected_bot_id`` lives in the localStorage bundle every tab shares. A
 * super-admin impersonation session is tab-scoped on purpose, so its agent
 * choice stays in React state only - persisting it would silently retarget the
 * super-admin's own dashboard in every other tab. Reads are skipped for the
 * same reason: the persisted id belongs to a different Account.
 */
function readPersistedBotId(): string | null {
    return isImpersonating() ? null : localStorage.getItem(STORAGE_KEY);
}

function persistBotId(value: string | null): void {
    if (isImpersonating()) return;
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
}

export function BotProvider({ children }: { children: ReactNode }) {
    const [bots, setBots] = useState<Bot[]>([]);
    const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<BotContextValue['error']>(null);

    const refreshBots = useCallback(async (): Promise<Bot[]> => {
        try {
            setLoading(true);
            setError(null);
            const data = await getBots();
            setBots(data);

            if (data.length === 0) {
                // No bots exist - clear selection.
                setSelectedBot(null);
                persistBotId(null);
            } else {
                setSelectedBot((currentSelectedBot) => {
                    // The dashboard is always scoped to exactly one agent - the
                    // "All agents" aggregate scope was removed - so resolve to a
                    // concrete bot whenever any exist, never null.

                    // Keep the current in-memory selection if that bot survives
                    // the refresh (avoids a needless rescope on a plain reload).
                    if (currentSelectedBot) {
                        const stillSelected = data.find((bot) => bot.id === currentSelectedBot.id);
                        if (stillSelected) return stillSelected;
                    }

                    // Restore a persisted per-bot choice when it's still valid.
                    const savedRaw = readPersistedBotId();
                    if (savedRaw && savedRaw !== ALL_BOTS_SENTINEL) {
                        const saved = data.find((bot) => bot.id === Number(savedRaw));
                        if (saved) return saved;
                    }

                    // Fresh session, a deleted selection, a workspace switch, or a
                    // legacy "all" sentinel from before the aggregate scope was
                    // removed - default to the first agent.
                    return data[0];
                });
            }
            // Return the freshly-loaded list so callers (e.g. the create flow)
            // can resolve a just-created bot without re-reading stale state.
            return data;
        } catch (err) {
            console.error('Failed to fetch bots:', err);
            setBots([]);
            setSelectedBot(null);
            // `catch` binds `unknown` under strict. The API client's rejections
            // do carry `message` and `status`, but nothing proves it to the
            // compiler while services/api is still JS, so read them defensively.
            const apiErr = err as { message?: string; status?: number | null } | null;
            setError({
                message: apiErr?.message || translateNow('app.failedToLoadBots') || 'Failed to load bots',
                status: apiErr?.status || null,
            });
            return [];
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // A super-admin impersonation session carries its own credential and no
        // ``admin_token`` - without it the support tab would render an empty
        // agent list for an Account that has agents.
        if (getAuthItem('admin_token') || isImpersonating()) {
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
    const selectBot = useCallback((bot: Bot | null) => {
        setSelectedBot(bot);
        persistBotId(bot?.id ? bot.id.toString() : ALL_BOTS_SENTINEL);
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
export function useBotContext(): BotContextValue {
    const ctx = useContext(BotContext);
    if (!ctx) {
        throw new Error('useBotContext must be used within a BotProvider');
    }
    return ctx;
}
