import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Check, Globe, RefreshCw, ArrowRight, Sparkles } from 'lucide-react';
import { useCrawl } from '../../../context/CrawlContext';
import { useBotContext } from '../../../context/BotContext';
import { useToast } from '../../../context/ToastContext';
import useEntitlements from '../../../hooks/useEntitlements';
import { discoverCrawlUrls, recordActivationEvent } from '../../../services/api';
import { Button } from '../../../components/ui/Button';
import Progress from '../../../components/ui/Progress';

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
    const { entitlements } = useEntitlements();
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
                <div className="flex flex-col gap-5">
                    <div className="flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-50 dark:bg-emerald-900/15 px-4 py-3.5">
                        <span className="w-7 h-7 rounded-full grid place-items-center bg-emerald-500 text-white shrink-0">
                            <Check size={15} strokeWidth={3} />
                        </span>
                        <p className="text-sm font-medium text-[var(--text)]">
                            Trained on {trained} page{trained === 1 ? '' : 's'} from {host}.
                        </p>
                    </div>
                    <Button size="lg" className="self-start" onClick={() => onDone?.()}>
                        Continue to testing <ArrowRight size={16} />
                    </Button>
                </div>
            );
        }
        if (crawl.status === 'failed' || crawl.status === 'cancelled') {
            return (
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-rose-500">{crawl.error || 'Training did not finish. You can try again.'}</p>
                    <Button variant="outline" size="md" className="self-start" onClick={() => setStarted(false)}>
                        <RefreshCw size={15} /> Back to pages
                    </Button>
                </div>
            );
        }
        const denom = crawl.discoveredTotal || total || 0;
        const pages = crawl.pagesCrawled || 0;
        return (
            <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                    <Loader2 size={18} className="animate-spin text-primary-500" />
                    <p className="text-sm font-medium text-[var(--text)]">{crawl.phase || 'Training your agent…'}</p>
                </div>
                {denom > 0 && <Progress value={pages} max={denom} color="primary" size="md" />}
                <p className="font-mono text-xs text-[var(--text-muted)] truncate">
                    {pages}
                    {denom ? ` / ${denom}` : ''} pages{crawl.currentUrl ? ` · ${crawl.currentUrl}` : ''}
                </p>
            </div>
        );
    }

    // ---- Discovering ----
    if (discovering) {
        return (
            <div className="min-h-[200px] flex flex-col items-center justify-center gap-3 text-[var(--text-muted)]">
                <Loader2 size={22} className="animate-spin text-primary-500" />
                <p className="text-sm">
                    Scanning <span className="font-mono text-[var(--text-secondary)]">{host}</span> for pages…
                </p>
            </div>
        );
    }

    // ---- Discover error ----
    if (discoverError) {
        return (
            <div className="flex flex-col gap-4">
                <p className="text-sm text-rose-500">{discoverError}</p>
                <Button variant="outline" size="md" className="self-start" onClick={retry}>
                    <RefreshCw size={15} /> Try again
                </Button>
            </div>
        );
    }

    // ---- Review: discovered pages + selection ----
    const selectedCount = urls.filter((u) => selected.has(u)).length;
    // Contextual plan awareness (ADR: value-first, upgrade nudges only when a
    // real limit is hit — never a plan gate up front). page_scraping is the
    // per-plan crawl-page ceiling; -1 means unlimited.
    const pageCap = entitlements.limitFor('page_scraping');
    const overCap = pageCap > 0 && selectedCount > pageCap;
    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2.5 text-sm">
                <Globe size={16} className="text-primary-500 shrink-0" />
                <span className="text-[var(--text)]">
                    Found <span className="font-semibold">{total}</span> page{total === 1 ? '' : 's'} on{' '}
                    <span className="font-mono text-[var(--text-secondary)]">{host}</span>. Pick which to train on.
                </span>
            </div>

            {overCap && (
                <div className="flex items-start gap-2.5 rounded-xl border border-primary-500/25 bg-primary-500/[0.06] px-3.5 py-3">
                    <Sparkles size={15} className="mt-0.5 shrink-0 text-primary-500" />
                    <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
                        Your <span className="font-medium text-[var(--text)]">{entitlements.planName}</span> plan trains up
                        to <span className="font-medium text-[var(--text)]">{pageCap}</span> pages — the first {pageCap} of
                        your selection will be trained.{' '}
                        <Link to="/billing" className="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400">
                            Upgrade
                        </Link>{' '}
                        to train your whole site.
                    </p>
                </div>
            )}

            <div className="max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)] divide-y divide-[var(--border)]">
                {urls.map((u) => (
                    <label key={u} className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-[var(--bg-muted)]/50">
                        <input
                            type="checkbox"
                            checked={selected.has(u)}
                            onChange={() => toggle(u)}
                            className="accent-primary-500 w-4 h-4"
                        />
                        <span className="font-mono text-xs text-[var(--text-secondary)] truncate">{pathOf(u)}</span>
                    </label>
                ))}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
                <Button size="lg" onClick={startTraining} disabled={selectedCount === 0}>
                    Start training on {selectedCount} page{selectedCount === 1 ? '' : 's'} <ArrowRight size={16} />
                </Button>
                <span className="font-mono text-[11px] text-[var(--text-muted)]">only pages you keep are crawled · uses crawl credits</span>
            </div>
        </div>
    );
}
