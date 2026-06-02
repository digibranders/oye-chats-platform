import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    ChevronDown,
    ChevronUp,
    Globe,
    Loader2,
    StopCircle,
} from 'lucide-react';

import { useCrawl } from '../context/CrawlContext';
import { useToast } from '../context/ToastContext';
import { cn } from '../lib/utils';

/**
 * Floating, persistent crawl progress indicator.
 *
 * Lives outside <Routes> so it stays visible as the user navigates around the
 * admin app. Renders nothing when there's no crawl to show.
 *
 * States:
 *   running    — animated progress bar + cancel button + minimize
 *   cancelling — disabled cancel button, "Stopping…" label
 *   done       — success burst, dismiss button, links to Knowledge page
 *   cancelled  — informational, dismiss button, "X pages saved" note
 *   failed     — error chip, dismiss button, error message
 *
 * Mobile: full-width sticky bar at the bottom. Desktop: 360px card pinned to
 * the bottom-right with a glass-morphism + gradient-border treatment so it
 * reads as "important system state" without screaming.
 */

const DOMAIN_RE = /^https?:\/\/(?:www\.)?([^/]+)/i;
const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'failed']);

function deriveDomain(url) {
    if (!url) return null;
    const m = DOMAIN_RE.exec(url);
    return m ? m[1] : url;
}

function formatElapsed(seconds) {
    if (!seconds || seconds < 0) return null;
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
}

function estimateEta({ pagesCrawled, maxPages, startedAt }) {
    if (!pagesCrawled || !maxPages || !startedAt) return null;
    const remaining = maxPages - pagesCrawled;
    if (remaining <= 0) return null;
    const elapsed = Date.now() / 1000 - startedAt;
    if (elapsed < 3) return null; // too early to be meaningful
    const rate = pagesCrawled / elapsed;
    if (rate <= 0) return null;
    const etaSec = remaining / rate;
    if (!Number.isFinite(etaSec)) return null;
    if (etaSec < 60) return `~${Math.max(1, Math.ceil(etaSec))}s left`;
    return `~${Math.ceil(etaSec / 60)}m left`;
}

const GlobalCrawlIndicator = () => {
    const { crawl, cancelCrawl, isActive } = useCrawl();
    const { showToast } = useToast();
    const navigate = useNavigate();
    const [minimized, setMinimized] = useState(false);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    // One-shot guard: fire a single toast per terminal transition, even if
    // the underlying state object gets replaced by an idle poll re-render
    // before we tear down. The status string is captured once and we refuse
    // to re-toast for the same string until startCrawl resets it.
    const lastToastedStatusRef = useRef(null);

    // Tick a 1s timer while active so the elapsed label updates live without
    // depending on the slower progress poll.
    useEffect(() => {
        if (!isActive || !crawl.startedAt) {
            setElapsedSeconds(0);
            return undefined;
        }
        const update = () => {
            setElapsedSeconds(Math.max(0, Date.now() / 1000 - crawl.startedAt));
        };
        update();
        const t = setInterval(update, 1000);
        return () => clearInterval(t);
    }, [isActive, crawl.startedAt]);

    // Reset the toast guard whenever a new crawl begins. The 'running' status
    // marks the start of a fresh transition window.
    useEffect(() => {
        if (crawl.status === 'running') {
            lastToastedStatusRef.current = null;
        }
    }, [crawl.status]);

    // Auto-fire a SINGLE toast on terminal transitions so even users who
    // already navigated away get a clear signal. The ref guard makes this
    // safe against re-renders, spurious effect re-runs, and stale poll
    // echoes — the toast fires exactly once per `running → terminal` cycle.
    useEffect(() => {
        if (!TERMINAL_STATUSES.has(crawl.status)) return;
        if (lastToastedStatusRef.current === crawl.status) return;
        lastToastedStatusRef.current = crawl.status;
        if (crawl.status === 'done') {
            const pages = crawl.result?.pages_processed ?? crawl.urls.length;
            showToast('success', `Crawl complete: ${pages} ${pages === 1 ? 'page' : 'pages'} ingested.`);
        } else if (crawl.status === 'cancelled') {
            showToast('info', 'Crawl cancelled.');
        } else if (crawl.status === 'failed') {
            showToast('error', crawl.error || 'Crawl failed.');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [crawl.status, crawl.result]);

    const domain = useMemo(() => deriveDomain(crawl.rootUrl || crawl.currentUrl), [crawl.rootUrl, crawl.currentUrl]);

    // Render the floating card ONLY while a crawl is actually running or
    // being cancelled. The terminal-state communication (success / cancelled
    // / failed) is delivered via a single one-shot toast above — the card
    // itself disappears the instant the crawl ends, which is what the user
    // wants when they're moving around the admin app.
    if (!isActive) {
        return null;
    }

    const pages = crawl.pagesCrawled ?? crawl.urls.length;
    const max = crawl.maxPages;
    const pct = max ? Math.min(100, Math.round((pages / max) * 100)) : null;
    const eta = estimateEta({ pagesCrawled: pages, maxPages: max, startedAt: crawl.startedAt });
    const elapsed = formatElapsed(elapsedSeconds);

    const handleCancel = async () => {
        try {
            await cancelCrawl();
        } catch (err) {
            showToast('error', err?.message || 'Failed to cancel crawl.');
        }
    };

    const handleViewDetails = () => {
        setMinimized(false);
        // Deep-link straight to the Website Scan tab — that's where the live
        // URL list + Cancel button live. Without the query param the user
        // lands on All Sources and has to click around to see the crawl.
        navigate('/knowledge?tab=urls');
    };

    // ── Visual treatment per state ─────────────────────────────────────────
    // Only two states surface here now: 'running' (active) and 'cancelling'
    // (warn). Terminal states never reach this point — they're handled by
    // the one-shot toast above and the indicator returns null.
    const isCancelling = crawl.status === 'cancelling';
    const accent = isCancelling ? 'from-amber-400 to-orange-500' : 'from-primary-500 to-violet-500';
    const icon = isCancelling
        ? <Loader2 size={18} className="text-amber-500 animate-spin" />
        : <Globe size={18} className="text-primary-500" />;
    const headerLabel = isCancelling ? 'Stopping crawl…' : 'Crawling website';

    return (
        <div
            className={cn(
                'fixed z-[60] pointer-events-none',
                'bottom-4 right-4 left-4 sm:left-auto sm:bottom-6 sm:right-6',
                'sm:w-[380px]',
            )}
            role="status"
            aria-live="polite"
        >
            {/* Gradient border wrapper for premium "system surface" feel */}
            <div
                className={cn(
                    'pointer-events-auto rounded-2xl p-[1.5px] shadow-2xl',
                    'bg-gradient-to-br',
                    accent,
                    'animate-fade-in',
                )}
            >
                <div
                    className={cn(
                        'rounded-2xl backdrop-blur-xl',
                        'bg-white/95 dark:bg-slate-900/95',
                        'border border-white/40 dark:border-white/5',
                    )}
                >
                    {/* Header */}
                    <button
                        type="button"
                        onClick={() => setMinimized((m) => !m)}
                        className={cn(
                            'w-full flex items-center gap-3 px-4 py-3 text-left',
                            'rounded-t-2xl transition-colors',
                            'hover:bg-slate-50/60 dark:hover:bg-white/5',
                        )}
                        aria-expanded={!minimized}
                    >
                        <div
                            className={cn(
                                'flex items-center justify-center w-9 h-9 rounded-xl shrink-0',
                                'bg-gradient-to-br',
                                accent,
                                'shadow-md',
                            )}
                        >
                            <span className="bg-white dark:bg-slate-900 rounded-[10px] w-7 h-7 flex items-center justify-center">
                                {icon}
                            </span>
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                                    {headerLabel}
                                </span>
                                {pct !== null && (
                                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400 tabular-nums">
                                        {pct}%
                                    </span>
                                )}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                                {domain ?? 'Website'}
                                {pages > 0 && (
                                    <>
                                        {' '}
                                        · {pages}
                                        {max ? `/${max}` : ''} page{pages === 1 ? '' : 's'}
                                    </>
                                )}
                            </div>
                        </div>
                        <span
                            aria-hidden
                            className="shrink-0 text-slate-400 dark:text-slate-500"
                        >
                            {minimized ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </span>
                    </button>

                    {/* Progress bar — always rendered so collapsed view still
                        shows motion */}
                    <div className="px-4 pb-2">
                        <div className="h-1.5 rounded-full bg-slate-200/70 dark:bg-white/10 overflow-hidden">
                            <div
                                className={cn(
                                    'h-full rounded-full transition-all duration-500 ease-out',
                                    'bg-gradient-to-r',
                                    accent,
                                )}
                                style={{
                                    width: pct !== null ? `${Math.max(4, pct)}%` : '30%',
                                    // Indeterminate shimmer when we don't have a known max
                                    ...(pct === null
                                        ? { animation: 'fadeIn 1.5s ease-in-out infinite alternate' }
                                        : {}),
                                }}
                            />
                        </div>
                    </div>

                    {/* Expanded body */}
                    {!minimized && (
                        <div className="px-4 pb-4 pt-1 space-y-3">
                            {/* Meta line */}
                            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                                <span>{elapsed ? `Elapsed ${elapsed}` : 'Starting…'}</span>
                                {eta && <span>{eta}</span>}
                            </div>

                            {/* Current URL — falls back to a "discovering"
                                line while we're between the start and the
                                first page write, so the user always sees
                                what we're actively doing. */}
                            <div
                                className={cn(
                                    'text-[11px] truncate font-mono',
                                    crawl.currentUrl
                                        ? 'text-slate-500 dark:text-slate-400'
                                        : 'text-slate-400 dark:text-slate-500 italic',
                                )}
                                title={crawl.currentUrl ?? undefined}
                            >
                                {crawl.currentUrl ?? 'Discovering URLs…'}
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-2 pt-1">
                                <button
                                    type="button"
                                    onClick={handleViewDetails}
                                    className={cn(
                                        'flex-1 text-xs font-medium px-3 py-2 rounded-lg',
                                        'bg-slate-100 hover:bg-slate-200 text-slate-700',
                                        'dark:bg-white/5 dark:hover:bg-white/10 dark:text-slate-200',
                                        'transition-colors',
                                    )}
                                >
                                    View details
                                </button>
                                <button
                                    type="button"
                                    onClick={handleCancel}
                                    disabled={isCancelling || crawl.cancelInFlight}
                                    className={cn(
                                        'flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg',
                                        'bg-rose-50 hover:bg-rose-100 text-rose-700',
                                        'dark:bg-rose-500/15 dark:hover:bg-rose-500/25 dark:text-rose-300',
                                        'transition-colors',
                                        'disabled:opacity-50 disabled:cursor-not-allowed',
                                    )}
                                >
                                    {isCancelling ? (
                                        <>
                                            <Loader2 size={12} className="animate-spin" />
                                            Stopping…
                                        </>
                                    ) : (
                                        <>
                                            <StopCircle size={12} />
                                            Cancel
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default GlobalCrawlIndicator;
