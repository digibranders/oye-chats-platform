/* eslint-disable react-refresh/only-export-components */
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

import {
    cancelCrawl as cancelCrawlApi,
    crawlWebsite,
    getCrawlProgress,
} from '../services/api';

/**
 * Global crawl context.
 *
 * Why this exists: the crawl runs in the ARQ worker, so the UI just polls
 * /crawl/progress. Without a global context, every route that wants to show
 * crawl status (Knowledge page, dashboard, anywhere) would have to spin up
 * its own poll loop — and the moment the user navigates away from the
 * Knowledge page, the local polling state is gone and the user loses sight
 * of an in-flight crawl entirely.
 *
 * This context:
 *   1. Polls /crawl/progress every 2s while a crawl is active.
 *   2. Surfaces the current state to any component via useCrawl().
 *   3. Auto-detects in-progress crawls on mount (and on auth changes) so a
 *      refresh or a fresh tab still picks up an existing crawl.
 *   4. Exposes startCrawl / cancelCrawl / dismissCrawl actions that work the
 *      same from any route.
 *   5. Holds onto terminal state (done / cancelled / failed) until the user
 *      dismisses it — so a brief navigation doesn't make the success toast
 *      disappear before they see it.
 */

const POLL_INTERVAL_MS = 2000;
const CANCELLING_POLL_INTERVAL_MS = 500; // poll aggressively while waiting for cancel confirmation
// Backoff for the "are there any leftover crawls?" probe when nothing is
// running locally — avoids hammering the API every 2s for a no-op. Long
// enough that a stale ``done`` from the server can't keep re-triggering UI
// effects, short enough that a crawl started in another tab still surfaces.
const IDLE_PROBE_INTERVAL_MS = 30000;
// After a terminal state, hold the result locally for this long so the
// notification toast can fire exactly once and then we hard-reset to idle.
// Without this, the next poll keeps echoing ``status="done"`` and any
// component that mounts during that window would re-fire its "completed"
// toast — that's the "toast every 30s" bug.
const TERMINAL_HOLD_MS = 4000;

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'failed']);
const ACTIVE_STATUSES = new Set(['running', 'cancelling']);

const CrawlContext = createContext(null);

const initialState = {
    status: 'idle', // 'idle' | 'running' | 'cancelling' | 'cancelled' | 'done' | 'failed'
    urls: [],
    pagesCrawled: 0,
    maxPages: null,
    // Client-side hint: actual page count from the pre-crawl discovery step.
    // When set, the UI uses this as the progress-bar denominator instead of
    // maxPages (the plan ceiling) so "3/47" is shown rather than "3/1200".
    discoveredTotal: null,
    currentUrl: null,
    startedAt: null, // epoch seconds (server-side)
    rootUrl: null, // domain we asked to crawl, kept across polls so the UI label is stable
    botId: null, // bot ownership for cancel calls
    botName: null, // display name of the owning bot (set client-side, never from server)
    result: null, // populated on 'done' / 'cancelled'
    error: null, // populated on 'failed'
    cancellable: true,
    isStarting: false, // local state — true between startCrawl() and the first poll seeing 'running'
    cancelInFlight: false, // local state — true between cancelCrawl() and the server flip
};

function normalizeProgress(raw, prev) {
    const status = raw?.status ?? 'idle';
    const urls = Array.isArray(raw?.urls) ? raw.urls : [];
    return {
        status,
        urls,
        pagesCrawled: raw?.pages_crawled ?? urls.length,
        maxPages: raw?.max_pages ?? prev.maxPages,
        // discoveredTotal is client-side only — preserve it across every server poll
        discoveredTotal: prev.discoveredTotal,
        currentUrl: raw?.current_url ?? (urls.length ? urls[urls.length - 1] : prev.currentUrl),
        startedAt: raw?.started_at ?? prev.startedAt,
        rootUrl: prev.rootUrl, // set client-side on startCrawl; server doesn't echo
        botId: prev.botId,
        botName: prev.botName, // client-side only — preserved across polls
        result: raw?.result ?? null,
        error: raw?.error ?? null,
        cancellable: raw?.cancellable ?? (status === 'running'),
        isStarting: false, // first server payload means we're past the optimistic-starting phase
        cancelInFlight: status === 'cancelling' ? prev.cancelInFlight : false,
    };
}

export const CrawlProvider = ({ children }) => {
    const [crawl, setCrawl] = useState(initialState);
    // Refs let the polling effect read the latest values without being part
    // of the effect's dep array (which would restart the poll every tick).
    const crawlRef = useRef(crawl);
    crawlRef.current = crawl;

    const pollTimerRef = useRef(null);
    const cancelledByUserRef = useRef(false); // suppresses the failure toast when *we* triggered the cancel
    // The status string of the most-recent transition we've already "handled"
    // (i.e. consumers fired their one-shot toast for it). Used to suppress the
    // "Crawl complete" toast looping every poll tick — without this guard,
    // any component that re-mounts or any spurious re-render with the same
    // terminal status would re-fire its useEffect. See TERMINAL_HOLD_MS.
    const handledTerminalRef = useRef(null);
    const terminalResetTimerRef = useRef(null);
    // True once we've observed a running/cancelling poll in this browser
    // session. Used to suppress the "Crawl complete" toast on page reload —
    // the server's progress key has a 1h TTL, so a reload right after a
    // crawl finishes would otherwise re-fire the success toast every time.
    // We only fire the toast for transitions we actually witnessed.
    const hasSeenActiveRef = useRef(false);

    const clearPoll = useCallback(() => {
        if (pollTimerRef.current) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    }, []);

    /**
     * Force the local state back to ``idle`` and drop the cached terminal
     * result. Called after the indicator's grace period expires so the next
     * poll can't keep echoing a stale ``done`` and re-firing toasts. The
     * server's progress key has a 1h TTL — if a new crawl shows up between
     * now and then, the poll will surface it; meanwhile the UI stays quiet.
     */
    const resetToIdle = useCallback(() => {
        if (terminalResetTimerRef.current) {
            clearTimeout(terminalResetTimerRef.current);
            terminalResetTimerRef.current = null;
        }
        setCrawl((prev) => {
            if (!TERMINAL_STATUSES.has(prev.status)) return prev;
            return { ...initialState };
        });
    }, []);

    const poll = useCallback(async () => {
        try {
            const data = await getCrawlProgress();
            const serverStatus = data?.status;

            // Track whether we've ever seen an active poll in this session.
            // This must run BEFORE the state setter below, since the setter
            // may bail out early for stale terminal echoes.
            if (ACTIVE_STATUSES.has(serverStatus)) {
                hasSeenActiveRef.current = true;
            }

            // Stale terminal on mount: the server is echoing a crawl that
            // finished BEFORE this session loaded (1h Redis TTL). We never
            // witnessed it run, so skip the toast + indicator entirely and
            // mark it as already-handled so subsequent polls don't fire either.
            if (
                TERMINAL_STATUSES.has(serverStatus) &&
                !hasSeenActiveRef.current &&
                handledTerminalRef.current === null
            ) {
                handledTerminalRef.current = serverStatus;
                return; // keep local state idle; user sees nothing
            }

            setCrawl((prev) => {
                // Suppress stale terminal echoes: once we've shown the
                // result for THIS crawl run and moved on, ignore any poll
                // that just keeps saying "yep, still done" — that's how
                // the "Crawl complete every 30s" loop was being created.
                if (
                    handledTerminalRef.current &&
                    serverStatus === handledTerminalRef.current &&
                    TERMINAL_STATUSES.has(serverStatus)
                ) {
                    return prev;
                }
                const next = normalizeProgress(data, prev);
                // If user just clicked cancel, force-show 'cancelling' until
                // the server flips even if a stale poll snuck through.
                if (cancelledByUserRef.current && next.status === 'running') {
                    next.status = 'cancelling';
                    next.cancelInFlight = true;
                }
                return next;
            });
        } catch {
            // Network blip — keep last known state. The next poll tick retries.
        }
    }, []);

    // Drive the polling loop. We use a recursive setTimeout (not setInterval)
    // so a slow API response can't queue up overlapping requests.
    useEffect(() => {
        const tick = async () => {
            await poll();
            const current = crawlRef.current;
            const interval =
                current.status === 'cancelling'
                    ? CANCELLING_POLL_INTERVAL_MS
                    : ACTIVE_STATUSES.has(current.status) || current.isStarting
                      ? POLL_INTERVAL_MS
                      : IDLE_PROBE_INTERVAL_MS;
            pollTimerRef.current = setTimeout(tick, interval);
        };
        // Fire the first poll immediately on mount so a returning user sees
        // any in-flight crawl right away (no 2s blank-state flash).
        tick();
        return () => {
            clearPoll();
            if (terminalResetTimerRef.current) {
                clearTimeout(terminalResetTimerRef.current);
                terminalResetTimerRef.current = null;
            }
        };
    }, [poll, clearPoll]);

    // When a crawl reaches a terminal state for the first time:
    //   1. Stamp it on handledTerminalRef so any future stale "still done"
    //      poll is ignored (kills the toast loop bug).
    //   2. If the result payload hasn't arrived yet, kick a one-shot poll in
    //      500ms to grab it before the local hold timer fires.
    //   3. Auto-reset to ``idle`` after TERMINAL_HOLD_MS so the floating
    //      indicator vanishes — user only wants to see it during the crawl.
    // The handledTerminalRef is cleared on the next startCrawl so a brand-new
    // crawl gets its toast fired again.
    useEffect(() => {
        if (!TERMINAL_STATUSES.has(crawl.status)) return undefined;
        const firstTimeHere = handledTerminalRef.current !== crawl.status;
        if (firstTimeHere) {
            handledTerminalRef.current = crawl.status;
        }
        const timers = [];
        if (firstTimeHere && !crawl.result && !crawl.error) {
            timers.push(setTimeout(poll, 500));
        }
        if (terminalResetTimerRef.current) clearTimeout(terminalResetTimerRef.current);
        terminalResetTimerRef.current = setTimeout(resetToIdle, TERMINAL_HOLD_MS);
        return () => {
            timers.forEach(clearTimeout);
        };
    }, [crawl.status, crawl.result, crawl.error, poll, resetToIdle]);

    // ── Actions ──────────────────────────────────────────────────────────────

    const startCrawl = useCallback(
        async ({
            url,
            botId,
            botName = null,
            useJs = false,
            replaceSource = null,
            discoveredTotal = null,
            expectedNewPages = null,
        } = {}) => {
            cancelledByUserRef.current = false;
            // Brand-new crawl → forget which terminal we already handled so
            // the next "Crawl complete" toast fires once for THIS run. Also
            // mark this as an actively-witnessed run so the success toast
            // isn't suppressed by the stale-terminal-on-mount guard.
            handledTerminalRef.current = null;
            hasSeenActiveRef.current = true;
            if (terminalResetTimerRef.current) {
                clearTimeout(terminalResetTimerRef.current);
                terminalResetTimerRef.current = null;
            }
            // Optimistic UI: flip to 'running' immediately so the global toast
            // shows up before the first poll lands.
            setCrawl((prev) => ({
                ...prev,
                status: 'running',
                urls: [],
                pagesCrawled: 0,
                maxPages: prev.maxPages,
                // Store the pre-crawl discovered page count so both the
                // KnowledgeBase page and the GlobalCrawlIndicator can show
                // "3/47" instead of "3/1200" during the crawl.
                discoveredTotal: discoveredTotal && discoveredTotal > 0 ? discoveredTotal : null,
                currentUrl: null,
                startedAt: Date.now() / 1000,
                rootUrl: url,
                botId: botId ?? null,
                botName: botName ?? null,
                result: null,
                error: null,
                cancellable: true,
                isStarting: true,
                cancelInFlight: false,
            }));
            try {
                const response = await crawlWebsite(url, botId, useJs, replaceSource, expectedNewPages);
                // Kick a poll immediately so the bar advances faster than the
                // background tick.
                poll();
                return response;
            } catch (error) {
                setCrawl((prev) => ({
                    ...prev,
                    status: 'failed',
                    isStarting: false,
                    error: error?.message || 'Failed to start crawl.',
                }));
                throw error;
            }
        },
        [poll],
    );

    const cancelCrawl = useCallback(async () => {
        const current = crawlRef.current;
        if (!ACTIVE_STATUSES.has(current.status)) {
            return { status: current.status, message: 'No crawl in progress.' };
        }
        cancelledByUserRef.current = true;
        // Optimistic flip so the toast shows "Cancelling…" within one frame.
        setCrawl((prev) => ({
            ...prev,
            status: 'cancelling',
            cancellable: false,
            cancelInFlight: true,
        }));
        try {
            const response = await cancelCrawlApi(current.botId ?? undefined);
            // Speed-up: poll once now instead of waiting for the next tick.
            poll();
            return response;
        } catch (error) {
            setCrawl((prev) => ({ ...prev, cancelInFlight: false }));
            throw error;
        }
    }, [poll]);

    /** Dismiss a terminal-state crawl so the toast hides. */
    const dismissCrawl = useCallback(() => {
        setCrawl((prev) => {
            if (!TERMINAL_STATUSES.has(prev.status)) return prev;
            return { ...initialState };
        });
    }, []);

    const value = useMemo(
        () => ({
            crawl,
            startCrawl,
            cancelCrawl,
            dismissCrawl,
            isActive: ACTIVE_STATUSES.has(crawl.status) || crawl.isStarting,
            isTerminal: TERMINAL_STATUSES.has(crawl.status),
        }),
        [crawl, startCrawl, cancelCrawl, dismissCrawl],
    );

    return <CrawlContext.Provider value={value}>{children}</CrawlContext.Provider>;
};

/** Subscribe to global crawl state from any component. */
export const useCrawl = () => {
    const ctx = useContext(CrawlContext);
    if (!ctx) {
        throw new Error('useCrawl must be used inside <CrawlProvider>');
    }
    return ctx;
};
