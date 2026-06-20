import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { CircleDot, AlertTriangle, UserPlus, Loader2 } from 'lucide-react';
import { getOperators } from '../services/api';

/**
 * LiveChatStatusPill — at-a-glance live chat readiness for the Support page.
 *
 * The pill answers "what would a visitor see right now if they clicked Talk
 * to Human?" without requiring the admin to dig into Settings. Three states:
 *
 *   🟢 ACTIVE          — operators exist + at least one online
 *   🟡 NO ONE ONLINE   — operators exist but all offline (likely after-hours
 *                        or staff away from desk). Visitor sees offline form.
 *   🔴 NOT CONFIGURED  — zero operators added. Big nudge to add the first
 *                        one with a direct link to /team. This is the
 *                        empty-state moment that converts "I bought live
 *                        chat" into "I'm using live chat".
 *
 * ## Update strategy (three layers, in order of how fast they fire)
 *
 * 1. **WebSocket event** — the operator console (``LiveChat.jsx``) receives
 *    ``operators_update`` broadcasts whenever any operator in the workspace
 *    flips online/offline. It re-dispatches that as the custom DOM event
 *    ``oyechats:operators-changed`` which this component listens for —
 *    near-instant updates (~50ms).
 * 2. **Tab visibility** — when the admin tab regains focus we refetch
 *    immediately. Handles the "switched away for 10 min, came back" case
 *    without waiting for the next poll tick.
 * 3. **Polling fallback** — every 5s while visible. Catches edge cases
 *    where the WS broadcast was missed (cross-tab, dropped connection).
 *    5s is a deliberate tradeoff: cheap query (≤10 rows), small workspace.
 *    Don't go below 5s without checking the backend cost first.
 */
const POLL_INTERVAL_MS = 5_000;

export default function LiveChatStatusPill() {
    const [operators, setOperators] = useState(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;

        const fetchOps = async () => {
            try {
                const data = await getOperators();
                if (cancelled) return;
                const list = data?.operators || data || [];
                setOperators(Array.isArray(list) ? list : []);
                setError(false);
            } catch {
                if (!cancelled) setError(true);
            }
        };

        fetchOps();

        // Layer 1: WebSocket-driven instant update. LiveChat.jsx dispatches
        // this custom event whenever an `operators_update` message arrives
        // on the operator WS. Latency from "operator clicked Go Offline"
        // to "this pill reflects it" is ~50ms instead of 5s.
        const handleRosterChange = () => fetchOps();
        window.addEventListener('oyechats:operators-changed', handleRosterChange);

        // Layer 2: refetch when tab regains focus. Without this an admin
        // switching back after a break sees stale data until the next
        // poll tick (and might miss it entirely if they switch away again).
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') fetchOps();
        };
        document.addEventListener('visibilitychange', handleVisibility);

        // Layer 3: polling fallback (see file header for the rationale).
        const interval = setInterval(fetchOps, POLL_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearInterval(interval);
            window.removeEventListener('oyechats:operators-changed', handleRosterChange);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, []);

    if (operators === null && !error) {
        return (
            <span className="inline-flex items-center gap-1.5 text-xs text-surface-400 dark:text-surface-500">
                <Loader2 size={12} className="animate-spin" />
                Checking status…
            </span>
        );
    }

    if (error) {
        return null; // Fail silent — don't break the page header on an API blip
    }

    const total = operators.length;
    const onlineCount = operators.filter((o) => o.is_online).length;

    // Empty state — no operators at all. This is the high-impact prompt:
    // the customer is paying for live chat but it literally cannot work.
    if (total === 0) {
        return (
            <Link
                to="/team"
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors group"
            >
                <UserPlus size={14} className="text-amber-600 dark:text-amber-400" />
                <span className="text-xs font-medium text-amber-800 dark:text-amber-300">
                    Add your first operator to enable live chat
                </span>
                <span className="text-[10px] text-amber-600 dark:text-amber-400 group-hover:underline">
                    Go to team →
                </span>
            </Link>
        );
    }

    if (onlineCount > 0) {
        return (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30">
                <CircleDot size={12} className="text-emerald-600 dark:text-emerald-400" />
                <span className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
                    Live chat active
                </span>
                <span className="text-[11px] text-emerald-600/80 dark:text-emerald-400/80">
                    · {onlineCount} of {total} online
                </span>
            </span>
        );
    }

    // Has operators but none online — visitors see the offline form.
    return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-100 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
            <AlertTriangle size={12} className="text-surface-500 dark:text-surface-400" />
            <span className="text-xs font-medium text-surface-700 dark:text-surface-300">
                No operators online
            </span>
            <span className="text-[11px] text-surface-500 dark:text-surface-500">
                · visitors see offline form
            </span>
        </span>
    );
}
