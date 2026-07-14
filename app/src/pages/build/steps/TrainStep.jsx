import { useState, useEffect, useRef } from 'react';
import { Loader2, Check, Globe, RefreshCw, ArrowRight } from 'lucide-react';
import { useCrawl } from '../../../context/CrawlContext';
import { useBotContext } from '../../../context/BotContext';
import { useToast } from '../../../context/ToastContext';
import { discoverCrawlUrls, recordActivationEvent } from '../../../services/api';

function normalizeUrl(url) {
    const t = (url || '').trim();
    if (!t) return '';
    return t.startsWith('http') ? t : `https://${t}`;
}
function hostOf(url) {
    try {
        return new URL(normalizeUrl(url)).host;
    } catch {
        return url;
    }
}
function pathOf(url) {
    try {
        return new URL(url).pathname || '/';
    } catch {
        return url;
    }
}

/**
 * Train milestone — discover-first (ADR-7): scan the agent's website for pages,
 * show the count, let the user deselect pages to skip, then crawl the chosen
 * ones and show live progress via CrawlContext. Never auto-crawls a site.
 */
export default function TrainStep({ onDone }) {
    const { selectedBot } = useBotContext();
    const { crawl, startCrawl } = useCrawl();
    const { showToast } = useToast();
    const website = selectedBot?.website || '';
    const host = hostOf(website);
    const botId = selectedBot?.id;

    const [discovering, setDiscovering] = useState(true);
    const [discoverError, setDiscoverError] = useState(null);
    const [urls, setUrls] = useState([]);
    const [total, setTotal] = useState(0);
    const [selected, setSelected] = useState(() => new Set());
    const [reloadKey, setReloadKey] = useState(0);
    const [started, setStarted] = useState(false);
    const doneFiredRef = useRef(false);

    // Discover pages when we arrive (and on retry). All setState happens after
    // the await, so no synchronous state update inside the effect body.
    useEffect(() => {
        if (!website) {
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const res = await discoverCrawlUrls(normalizeUrl(website), botId);
                if (cancelled) return;
                const found = Array.isArray(res?.urls) ? res.urls : [];
                const totalFound = typeof res?.total_found === 'number' ? res.total_found : found.length;
                setUrls(found);
                setTotal(totalFound);
                setSelected(new Set(found));
                setDiscovering(false);
            } catch (err) {
                if (cancelled) return;
                setDiscoverError(err?.message || 'Could not scan your website. Check the URL and try again.');
                setDiscovering(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [website, botId, reloadKey]);

    // Record completion once, when the crawl we started finishes (no setState).
    useEffect(() => {
        if (started && crawl.status === 'done' && !doneFiredRef.current) {
            doneFiredRef.current = true;
            recordActivationEvent('crawl_completed', {
                botId,
                eventData: { pages: crawl.result?.pages_processed ?? null },
            });
        }
    }, [started, crawl.status, crawl.result, botId]);

    const retry = () => {
        setDiscovering(true);
        setDiscoverError(null);
        setReloadKey((k) => k + 1);
    };

    const toggle = (u) =>
        setSelected((prev) => {
            const n = new Set(prev);
            if (n.has(u)) n.delete(u);
            else n.add(u);
            return n;
        });

    const startTraining = async () => {
        const orderedUrls = urls.filter((u) => selected.has(u));
        if (orderedUrls.length === 0) {
            showToast('error', 'Select at least one page to train on.');
            return;
        }
        setStarted(true);
        doneFiredRef.current = false;
        recordActivationEvent('crawl_started', { botId, eventData: { pages: orderedUrls.length } });
        try {
            await startCrawl({
                url: normalizeUrl(website),
                botId,
                botName: selectedBot?.name,
                discoveredTotal: total,
                orderedUrls,
                maxPages: orderedUrls.length,
                mode: 'full',
            });
        } catch (err) {
            showToast('error', err?.message || 'Could not start training.');
            setStarted(false);
        }
    };

    // ---- No website (defensive) ----
    if (!website) {
        return <p className="text-sm text-rose-500">This agent has no website to train on.</p>;
    }

    // ---- Started: live crawl progress / done / failed ----
    if (started) {
        if (crawl.status === 'done') {
            const trained = crawl.result?.pages_processed ?? crawl.pagesCrawled ?? 0;
            return (
                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
                        <Check size={18} className="text-emerald-500" />
                        <p className="text-sm font-medium text-surface-800 dark:text-surface-100">
                            Trained on {trained} page{trained === 1 ? '' : 's'} from {host}.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => onDone?.()}
                        className="self-start inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600"
                    >
                        Continue to testing <ArrowRight size={16} />
                    </button>
                </div>
            );
        }
        if (crawl.status === 'failed' || crawl.status === 'cancelled') {
            return (
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-rose-500">{crawl.error || 'Training did not finish. You can try again.'}</p>
                    <button
                        type="button"
                        onClick={() => setStarted(false)}
                        className="self-start inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-surface-300 dark:border-surface-700"
                    >
                        <RefreshCw size={15} /> Back to pages
                    </button>
                </div>
            );
        }
        const denom = crawl.discoveredTotal || total || 0;
        const pages = crawl.pagesCrawled || 0;
        const pct = denom ? Math.min(100, Math.round((pages / denom) * 100)) : null;
        return (
            <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                    <Loader2 size={18} className="animate-spin text-primary-500" />
                    <p className="text-sm font-medium text-surface-800 dark:text-surface-100">
                        {crawl.phase || 'Training your agent…'}
                    </p>
                </div>
                {pct !== null && (
                    <div className="h-2 rounded-full bg-surface-200 dark:bg-surface-800 overflow-hidden">
                        <div
                            className="h-full bg-primary-500 transition-[width] duration-500 motion-reduce:transition-none"
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                )}
                <p className="font-mono text-xs text-surface-400 dark:text-surface-500 truncate">
                    {pages}
                    {denom ? ` / ${denom}` : ''} pages{crawl.currentUrl ? ` · ${crawl.currentUrl}` : ''}
                </p>
            </div>
        );
    }

    // ---- Discovering ----
    if (discovering) {
        return (
            <div className="min-h-[200px] flex flex-col items-center justify-center gap-3 text-surface-500 dark:text-surface-400">
                <Loader2 size={22} className="animate-spin text-primary-500" />
                <p className="text-sm">
                    Scanning <span className="font-mono text-surface-700 dark:text-surface-200">{host}</span> for pages…
                </p>
            </div>
        );
    }

    // ---- Discover error ----
    if (discoverError) {
        return (
            <div className="flex flex-col gap-4">
                <p className="text-sm text-rose-500">{discoverError}</p>
                <button
                    type="button"
                    onClick={retry}
                    className="self-start inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-surface-300 dark:border-surface-700"
                >
                    <RefreshCw size={15} /> Try again
                </button>
            </div>
        );
    }

    // ---- Review: discovered pages + selection ----
    const selectedCount = urls.filter((u) => selected.has(u)).length;
    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2.5 text-sm">
                <Globe size={16} className="text-primary-500 shrink-0" />
                <span className="text-surface-800 dark:text-surface-100">
                    Found <span className="font-semibold">{total}</span> page{total === 1 ? '' : 's'} on{' '}
                    <span className="font-mono text-surface-600 dark:text-surface-300">{host}</span>. Pick which to train on.
                </span>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-xl border border-surface-200 dark:border-surface-800 divide-y divide-surface-100 dark:divide-surface-800/60">
                {urls.map((u) => (
                    <label
                        key={u}
                        className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-surface-50 dark:hover:bg-surface-900/60"
                    >
                        <input
                            type="checkbox"
                            checked={selected.has(u)}
                            onChange={() => toggle(u)}
                            className="accent-primary-500 w-4 h-4"
                        />
                        <span className="font-mono text-xs text-surface-600 dark:text-surface-300 truncate">{pathOf(u)}</span>
                    </label>
                ))}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
                <button
                    type="button"
                    onClick={startTraining}
                    disabled={selectedCount === 0}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    Start training on {selectedCount} page{selectedCount === 1 ? '' : 's'} <ArrowRight size={16} />
                </button>
                <span className="font-mono text-[11px] text-surface-400 dark:text-surface-500">
                    only pages you keep are crawled · uses crawl credits
                </span>
            </div>
        </div>
    );
}
