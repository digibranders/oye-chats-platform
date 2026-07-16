import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Globe, RefreshCw, ArrowRight, Sparkles, Check, Send } from 'lucide-react';
import { useCrawl } from '../../../context/CrawlContext';
import { useBotContext } from '../../../context/BotContext';
import { useToast } from '../../../context/ToastContext';
import useEntitlements from '../../../hooks/useEntitlements';
import { discoverCrawlUrls, getDocuments, getSeedQuestions, recordActivationEvent } from '../../../services/api';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import Progress from '../../../components/ui/Progress';
import { cn } from '../../../lib/utils';

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

// Order URLs so the homepage + shallow nav pages are crawled (and therefore
// embedded) FIRST. The fast-path early-latch trains on whatever lands first, so
// prioritizing the most important pages makes the first proof representative.
// Pure reordering — same set, same page count, so it never changes what's charged.
function prioritizeUrls(urls) {
    const depth = (u) => {
        try {
            return new URL(u).pathname.replace(/\/+$/, '').split('/').filter(Boolean).length;
        } catch {
            return 99;
        }
    };
    return [...urls].sort((a, b) => depth(a) - depth(b) || a.length - b.length);
}

// A single embedded page is enough to start proving — the crawl keeps indexing
// the rest in the background after we latch "trained".
const FAST_PATH_MIN_DOCS = 1;

/**
 * Prove milestone (Prove-it-first step 2) — the emotional peak. Discovers the
 * site, auto-crawls all pages (default-all + opt-in customize), narrates the
 * work with a productive activity feed, then lets the user prove the agent by
 * asking a question that gets answered INSIDE the live widget preview (right
 * column). Verified seed-question chips make the first proof one tap; an
 * always-visible open input lets the user drive.
 *
 * `onAsk`/`sending` drive the shared preview conversation owned by BuildStudio
 * (so the answer renders in the widget, not a separate panel).
 *
 * Completion is latched LOCALLY (`trained`), never derived from the global
 * `crawl.status`. CrawlContext intentionally resets a finished crawl from
 * `done` → `idle` after a few seconds (so the floating progress toast clears).
 * Reading that transient status to decide "am I finished?" made the step fall
 * back to the crawling spinner — and on any remount re-fire a full crawl (the
 * "crawling forever / repeated crawl-complete" bug). The latch fixes both: once
 * done, the prove view stays; and an already-trained bot never re-crawls.
 */
export default function ProveStep({ onDone, onAsk, sending, askedCount = 0 }) {
    const { selectedBot } = useBotContext();
    const { crawl, startCrawl, cancelCrawl } = useCrawl();
    const { showToast } = useToast();
    const { entitlements } = useEntitlements();
    const website = selectedBot?.website || '';
    const host = hostOf(website);
    const botId = selectedBot?.id;

    // 'pending' until we know whether this bot already has knowledge. 'trained'
    // short-circuits straight to the prove view (no discovery, no crawl); 'fresh'
    // runs the discover + auto-crawl path exactly once.
    const [precheck, setPrecheck] = useState('pending');
    const [trained, setTrained] = useState(false);
    const [trainedPages, setTrainedPages] = useState(null);

    const [discovering, setDiscovering] = useState(true);
    const [discoverError, setDiscoverError] = useState(null);
    const [urls, setUrls] = useState([]);
    const [total, setTotal] = useState(0);
    const [selected, setSelected] = useState(() => new Set());
    const [customizing, setCustomizing] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [started, setStarted] = useState(false);
    const [seeds, setSeeds] = useState(null); // null = not loaded, [] = none
    const [loadingSeeds, setLoadingSeeds] = useState(false);
    const [openQ, setOpenQ] = useState('');
    const doneFiredRef = useRef(false);
    const autoStartRef = useRef(false);
    const autoAskedRef = useRef(false);
    const autoFirstAskRef = useRef(false);

    const beginCrawl = async (orderedUrls, discoveredTotal) => {
        if (!orderedUrls.length) {
            showToast('error', 'Select at least one page to train on.');
            return;
        }
        setStarted(true);
        setCustomizing(false);
        doneFiredRef.current = false;
        recordActivationEvent('crawl_started', { botId, eventData: { pages: orderedUrls.length } });
        try {
            await startCrawl({
                url: normalizeUrl(website),
                botId,
                botName: selectedBot?.name,
                discoveredTotal: discoveredTotal ?? total,
                orderedUrls,
                maxPages: orderedUrls.length,
                mode: 'full',
            });
        } catch (err) {
            showToast('error', err?.message || 'Could not start training.');
            setStarted(false);
        }
    };

    // Precheck: has this bot already been trained? If so, latch `trained` and
    // skip crawling — this is what makes remounts (Back/forward, a flapped
    // status) safe instead of kicking off a duplicate crawl.
    useEffect(() => {
        if (!botId) return undefined;
        let cancelled = false;
        (async () => {
            // Prefer the durable per-bot trained fact (stamped by the crawl
            // orchestrator on completion) over racing the ephemeral crawl
            // progress or an extra document round-trip. Fall back to a document
            // check for bots trained before this field existed (or when the
            // in-context bot copy predates the just-finished crawl).
            if (selectedBot?.crawl_completed_at || selectedBot?.last_crawl_status === 'done') {
                if (!cancelled) {
                    setTrained(true);
                    setPrecheck('trained');
                }
                return;
            }
            try {
                const docs = await getDocuments(botId);
                if (cancelled) return;
                if (Array.isArray(docs) && docs.length > 0) {
                    setTrained(true);
                    setPrecheck('trained');
                } else {
                    setPrecheck('fresh');
                }
            } catch {
                // Best-effort — if we can't tell, treat it as a fresh bot and
                // let the crawl run (the crawl itself is idempotent server-side).
                if (!cancelled) setPrecheck('fresh');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [botId, selectedBot?.crawl_completed_at, selectedBot?.last_crawl_status]);

    // Discover pages on arrival (fresh bots only), then DEFAULT-ALL: auto-start
    // the crawl on every discovered page for momentum. "Customize" (during the
    // feed) cancels and reveals the selection list. All setState happens
    // post-await; auto-start is one-shot via autoStartRef.
    useEffect(() => {
        if (precheck !== 'fresh' || !website) return undefined;
        let cancelled = false;
        (async () => {
            try {
                const res = await discoverCrawlUrls(normalizeUrl(website), botId);
                if (cancelled) return;
                const found = Array.isArray(res?.urls) ? res.urls : [];
                const ordered = prioritizeUrls(found);
                const totalFound = typeof res?.total_found === 'number' ? res.total_found : ordered.length;
                setUrls(ordered);
                setTotal(totalFound);
                setSelected(new Set(ordered));
                setDiscovering(false);
                if (ordered.length === 0) {
                    setDiscoverError('I couldn’t find any readable pages on that site. Check the URL and try again.');
                    return;
                }
                if (!autoStartRef.current) {
                    autoStartRef.current = true;
                    beginCrawl(ordered, totalFound);
                }
            } catch (err) {
                if (cancelled) return;
                setDiscoverError(err?.message || 'Could not scan your website. Check the URL and try again.');
                setDiscovering(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [precheck, website, botId, reloadKey]);

    // Latch completion the first time the crawl reports `done`. We snapshot the
    // page count here because CrawlContext clears `crawl.result` when it resets
    // the finished crawl back to idle — reading it later would show 0.
    useEffect(() => {
        if (started && crawl.status === 'done' && !doneFiredRef.current) {
            doneFiredRef.current = true;
            const pages = crawl.result?.pages_processed ?? crawl.pagesCrawled ?? total ?? null;
            setTrainedPages(pages);
            setTrained(true);
            recordActivationEvent('crawl_completed', { botId, eventData: { pages } });
        }
    }, [started, crawl.status, crawl.result, crawl.pagesCrawled, total, botId]);

    // Fast path: latch "trained" as soon as the FIRST pages are embedded, rather
    // than waiting for the entire site to finish. Streaming ingest embeds pages
    // in waves, so documents appear within ~20-30s even on a large site; the user
    // can prove immediately while the crawl keeps indexing the rest in the
    // background. Safe because it's the same single crawl (no re-crawl / double
    // charge). The done-latch above still fires later to record the final count.
    useEffect(() => {
        if (trained || !started || !botId) return undefined;
        let cancelled = false;
        const id = setInterval(async () => {
            try {
                const docs = await getDocuments(botId);
                if (cancelled) return;
                if (Array.isArray(docs) && docs.length >= FAST_PATH_MIN_DOCS) {
                    setTrainedPages(crawl.pagesCrawled || null);
                    setTrained(true);
                    recordActivationEvent('trained_fast_path', { botId });
                }
            } catch {
                // Keep waiting — the done-latch is the backstop if polling fails.
            }
        }, 4000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
        // crawl.pagesCrawled is read for a best-effort snapshot only; excluding it
        // keeps the poll interval stable instead of resetting on every progress tick.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [trained, started, botId]);

    // Once trained (fresh crawl or precheck), fetch verified seed questions.
    useEffect(() => {
        if (trained && seeds === null && !loadingSeeds && botId) {
            setLoadingSeeds(true);
            getSeedQuestions(botId)
                .then((qs) => setSeeds(Array.isArray(qs) ? qs : []))
                .finally(() => setLoadingSeeds(false));
        }
    }, [trained, seeds, loadingSeeds, botId]);

    // Demonstrate the aha: auto-ask the FIRST verified seed question once, so the
    // user sees the agent answer from their own site without lifting a finger.
    // Fires only when nothing's been asked yet and the agent isn't busy; uses a
    // distinct activation event so it doesn't inflate the user-initiated
    // `first_test_asked` metric (that still fires on their real first ask).
    useEffect(() => {
        if (autoFirstAskRef.current) return;
        if (!trained || sending || askedCount > 0) return;
        const chips = Array.isArray(seeds) ? seeds : null;
        if (!chips || chips.length === 0) return;
        autoFirstAskRef.current = true;
        recordActivationEvent('first_test_auto', { botId });
        onAsk?.(chips[0]);
    }, [trained, seeds, sending, askedCount, botId, onAsk]);

    const ask = (q) => {
        const question = (q ?? openQ).trim();
        if (!question || sending) return;
        setOpenQ('');
        if (!autoAskedRef.current) {
            autoAskedRef.current = true;
            recordActivationEvent('first_test_asked', { botId });
        }
        onAsk?.(question);
    };

    const retry = () => {
        setDiscovering(true);
        setDiscoverError(null);
        autoStartRef.current = false;
        doneFiredRef.current = false;
        setStarted(false);
        setReloadKey((k) => k + 1);
    };

    const toggle = (u) =>
        setSelected((prev) => {
            const n = new Set(prev);
            if (n.has(u)) n.delete(u);
            else n.add(u);
            return n;
        });

    const openCustomize = async () => {
        setCustomizing(true);
        setStarted(false);
        autoStartRef.current = true; // suppress auto-start while customizing
        try {
            if (crawl.status === 'running' || crawl.status === 'cancelling') await cancelCrawl();
        } catch {
            /* best-effort — the selection view still lets them restart */
        }
    };

    // ---- Done: prove it (drives the widget preview on the right) ----
    // Rendered off the local `trained` latch, NOT crawl.status, so it can't
    // regress to the spinner when the global crawl state resets to idle.
    if (trained) {
        const chips = Array.isArray(seeds) ? seeds : [];
        return (
            <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-50 dark:bg-emerald-900/15 px-4 py-3">
                    <span className="w-6 h-6 rounded-full grid place-items-center bg-emerald-500 text-white shrink-0">
                        <Check size={13} strokeWidth={3} />
                    </span>
                    <p className="text-sm font-medium text-[var(--text)]">
                        {trainedPages ? (
                            <>
                                Trained on {trainedPages} page{trainedPages === 1 ? '' : 's'}. Try it out →
                            </>
                        ) : (
                            <>Your agent is trained on your site. Try it out →</>
                        )}
                    </p>
                </div>

                <p className="text-sm text-[var(--text-secondary)]">
                    Ask your agent a question — it&rsquo;ll answer right in the preview, using your site.
                </p>

                {loadingSeeds ? (
                    <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                        <Loader2 size={15} className="animate-spin text-primary-500" /> Drafting a few questions to try…
                    </div>
                ) : chips.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {chips.map((q) => (
                            <button
                                key={q}
                                type="button"
                                onClick={() => ask(q)}
                                disabled={sending}
                                className={cn(
                                    'px-3.5 py-2 rounded-full text-[13px] border transition-colors disabled:opacity-50',
                                    'border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-secondary)]',
                                    'hover:border-primary-500/50 hover:text-primary-600 dark:hover:text-primary-400'
                                )}
                            >
                                {q}
                            </button>
                        ))}
                    </div>
                ) : null}

                <div className="relative">
                    <Input
                        value={openQ}
                        onChange={(e) => setOpenQ(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && ask()}
                        placeholder={`Ask ${selectedBot?.company_name || 'your agent'} anything…`}
                        aria-label="Ask your agent a question"
                        className="pr-11"
                        disabled={sending}
                    />
                    <button
                        type="button"
                        onClick={() => ask()}
                        disabled={sending || !openQ.trim()}
                        aria-label="Send"
                        className="absolute right-2 top-1/2 -translate-y-1/2 grid h-7 w-7 place-items-center rounded-lg text-white bg-primary-600 hover:bg-primary-500 disabled:opacity-40 transition-colors"
                    >
                        {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    </button>
                </div>

                <div>
                    <Button size="lg" variant={askedCount > 0 ? 'primary' : 'outline'} className="self-start" onClick={() => onDone?.()}>
                        {askedCount > 0 ? 'Looks great — continue' : 'Continue'} <ArrowRight size={16} />
                    </Button>
                </div>
            </div>
        );
    }

    if (!website) {
        return <p className="text-sm text-rose-500">This agent has no website to learn from.</p>;
    }

    // ---- Preparing (precheck in flight) ----
    if (precheck === 'pending') {
        return (
            <div className="flex items-center gap-3">
                <Loader2 size={18} className="animate-spin text-primary-500" />
                <p className="text-sm text-[var(--text-secondary)]">Preparing your agent…</p>
            </div>
        );
    }

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

    // ---- Discovering ----
    if (discovering) {
        return (
            <div className="flex items-center gap-3">
                <Loader2 size={18} className="animate-spin text-primary-500" />
                <p className="text-sm text-[var(--text-secondary)]">
                    Scanning <span className="font-mono text-[var(--text)]">{host}</span> for pages…
                </p>
            </div>
        );
    }

    // ---- Customize: page selection (opt-in) ----
    if (customizing) {
        const selectedCount = urls.filter((u) => selected.has(u)).length;
        const pageCap = entitlements.limitFor('page_scraping');
        const overCap = pageCap > 0 && selectedCount > pageCap;
        return (
            <div className="flex flex-col gap-4">
                <p className="text-sm text-[var(--text)]">
                    Pick which of the <span className="font-semibold">{total}</span> pages to train on.
                </p>
                {overCap && (
                    <div className="flex items-start gap-2.5 rounded-xl border border-primary-500/25 bg-primary-500/[0.06] px-3.5 py-3">
                        <Sparkles size={15} className="mt-0.5 shrink-0 text-primary-500" />
                        <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
                            Your <span className="font-medium text-[var(--text)]">{entitlements.planName}</span> plan trains
                            up to <span className="font-medium text-[var(--text)]">{pageCap}</span> pages.{' '}
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
                            <input type="checkbox" checked={selected.has(u)} onChange={() => toggle(u)} className="accent-primary-500 w-4 h-4" />
                            <span className="font-mono text-xs text-[var(--text-secondary)] truncate">{pathOf(u)}</span>
                        </label>
                    ))}
                </div>
                <Button size="lg" className="self-start" onClick={() => beginCrawl(urls.filter((u) => selected.has(u)))} disabled={selectedCount === 0}>
                    Train on {selectedCount} page{selectedCount === 1 ? '' : 's'} <ArrowRight size={16} />
                </Button>
            </div>
        );
    }

    // ---- Crawl failed / cancelled ----
    if (started && (crawl.status === 'failed' || crawl.status === 'cancelled')) {
        return (
            <div className="flex flex-col gap-4">
                <p className="text-sm text-rose-500">{crawl.error || 'Training did not finish. You can try again.'}</p>
                <Button variant="outline" size="md" className="self-start" onClick={() => setCustomizing(true)}>
                    <RefreshCw size={15} /> Choose pages
                </Button>
            </div>
        );
    }

    // ---- Crawling: productive activity feed ----
    const denom = crawl.discoveredTotal || total || 0;
    const pages = crawl.pagesCrawled || 0;
    const brandDetected = (selectedBot?.recommended_colors || []).length > 0;
    const feed = [
        { done: true, label: `Found ${total} page${total === 1 ? '' : 's'} on ${host}` },
        { done: pages > 0, label: pages > 0 ? `Reading your pages — ${pages}${denom ? ` of ${denom}` : ''}` : 'Reading your pages…' },
        { done: brandDetected, label: brandDetected ? 'Brand style detected' : 'Detecting your brand…' },
    ];
    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
                <Loader2 size={18} className="animate-spin text-primary-500" />
                <p className="text-sm font-medium text-[var(--text)]">{crawl.phase || 'Teaching your agent your site…'}</p>
            </div>
            {denom > 0 && <Progress value={pages} max={denom} color="primary" size="md" />}
            <ul className="flex flex-col gap-2">
                {feed.map((f, i) => (
                    <li key={i} className="flex items-center gap-2 text-[13px]">
                        {f.done ? (
                            <Check size={14} className="text-emerald-500 shrink-0" strokeWidth={3} />
                        ) : (
                            <Loader2 size={13} className="animate-spin text-[var(--text-muted)] shrink-0" />
                        )}
                        <span className={f.done ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}>{f.label}</span>
                    </li>
                ))}
            </ul>
            {crawl.currentUrl && (
                <p className="font-mono text-[11px] text-[var(--text-muted)] truncate">{crawl.currentUrl}</p>
            )}
            <button type="button" onClick={openCustomize} className="self-start text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] underline underline-offset-2">
                Customize which pages
            </button>
        </div>
    );
}
