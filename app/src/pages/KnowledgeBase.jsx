import { Fragment, useState, useRef, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { UploadCloud, Link as LinkIcon, FileText, X, CheckCircle2, AlertCircle, Loader2, List as ListIcon, Trash2, Check, RefreshCw, Globe, ExternalLink, Zap, StopCircle, Eye, ChevronsUp, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { uploadDocuments, getDocuments, deleteDocument, getCurrentSubscription, discoverCrawlUrls, diffRecrawl, getRecrawlStatus } from '../services/api';
import SourcePagesDrawer from '../components/SourcePagesDrawer';
import AutoRecrawlCard from '../components/AutoRecrawlCard';
import RecrawlMenu from '../components/RecrawlMenu';
import CreditCoin from '../components/icons/CreditCoin';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { useCrawl } from '../context/CrawlContext';
import useEntitlements from '../hooks/useEntitlements';
import PageHeader from '../components/PageHeader';
import Tabs from '../components/ui/Tabs';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonTable } from '../components/ui/SkeletonLoader';
import { cn } from '../lib/utils';

// Whitelist of tab IDs that can be requested via the ?tab= query param.
// Anything else falls back to the default. Prevents deep-link spoofing /
// invalid query values from breaking the tab UI.
const VALID_TABS = new Set(['list', 'urls', 'files']);

// Credit-aware partial crawl: order the discovered URLs by the user's choice,
// then take the first `count`. Ordering is derived from the URL strings — the
// discover endpoint returns plain strings, so we sort by path depth for
// "shallow-first" and keep discovery order for "as-discovered".
const CRAWL_ORDER_OPTIONS = [
  { key: 'shallow', label: 'Shallow-first (homepage & top pages first)' },
  { key: 'discovered', label: 'As discovered (site order)' },
];

const pathDepth = (u) => {
  try {
    return new URL(u).pathname.replace(/\/+$/, '').split('/').filter(Boolean).length;
  } catch {
    return 99;
  }
};

const orderCrawlUrls = (urls, order) => {
  if (order === 'shallow') {
    // Stable sort by path depth; ties keep discovery order.
    return urls
      .map((u, i) => [u, i])
      .sort((a, b) => pathDepth(a[0]) - pathDepth(b[0]) || a[1] - b[1])
      .map(([u]) => u);
  }
  return urls; // 'discovered' = as-is
};

const sliceForCrawl = (urls, order, count) => orderCrawlUrls(urls, order).slice(0, count);

// Accept a bare domain ("example.com") — prepend https:// when the user omits
// the scheme so discovery/crawl always receive an absolute URL. Leaves an
// existing http(s):// scheme untouched.
const normalizeWebsiteUrl = (raw) => {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

// Format a crawl duration (seconds) as "45s" / "2m 2s" / "1h 3m". "—" when unknown
// (uploads, or crawls ingested before timing was tracked).
const formatDuration = (seconds) => {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export default function KnowledgeBase() {
  const navigate = useNavigate();
  const { selectedBot, bots, loading: botsLoading } = useBotContext();
  const { showToast } = useToast();
  const { crawl, startCrawl, cancelCrawl, isActive: isCrawlActive } = useCrawl();
  const { entitlements, refresh: refreshEntitlements } = useEntitlements();
  // Delta recrawl ("Updated pages only") is a Standard+ perk. The RecrawlMenu
  // still shows the option to non-entitled tiers so it's discoverable, but
  // clicks route to /billing instead of the diff endpoint.
  const canUseDeltaRecrawl = entitlements.planSlug === 'standard' || entitlements.planSlug === 'enterprise';
  const docsLimit = entitlements.limitFor('documents');
  const docsUsed = Number(entitlements.usage?.documents ?? 0);
  const isUnlimitedDocs = docsLimit === -1;
  const docsRemaining = isUnlimitedDocs ? Infinity : Math.max(0, docsLimit - docsUsed);
  const docsPercent = isUnlimitedDocs || docsLimit === 0
    ? 0
    : Math.min(100, Math.round((docsUsed / docsLimit) * 100));
  const docsAtLimit = !isUnlimitedDocs && docsUsed >= docsLimit;
  const docsNearLimit = !isUnlimitedDocs && !docsAtLimit && docsPercent >= 80;
  // Tab can be deep-linked via ?tab=urls (e.g. from the global crawl
  // indicator's "View details" button). Local state stays the source of
  // truth after mount so clicking tabs doesn't require a URL change.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(
    VALID_TABS.has(tabFromUrl) ? tabFromUrl : 'list',
  );

  // Sync local state when the URL's ?tab= changes (e.g. user clicks the
  // indicator while already on /knowledge — same route, new query string).
  useEffect(() => {
    if (tabFromUrl && VALID_TABS.has(tabFromUrl) && tabFromUrl !== activeTab) {
      setActiveTab(tabFromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabFromUrl]);

  // Wrap setActiveTab so user-driven tab changes also clear the query
  // param — keeps the URL honest without forcing a navigation.
  const handleTabChange = (next) => {
    setActiveTab(next);
    if (searchParams.has('tab')) {
      const params = new URLSearchParams(searchParams);
      params.delete('tab');
      setSearchParams(params, { replace: true });
    }
  };

  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const fileInputRef = useRef(null);

  const [url, setUrl] = useState(localStorage.getItem('company_website') || '');
  const [useJs, setUseJs] = useState(false);

  // Pre-crawl discovery state
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveredTotal, setDiscoveredTotal] = useState(null);
  const [showCrawlConfirm, setShowCrawlConfirm] = useState(false);
  // Full discover payload (credit math + urls) used to drive the credit-aware
  // picker when the site has more pages than the balance can crawl.
  const [crawlEstimate, setCrawlEstimate] = useState(null);
  const [crawlCount, setCrawlCount] = useState(0);
  const [crawlOrder, setCrawlOrder] = useState('shallow');

  // Dismiss the confirmation banner whenever the URL or JS-mode changes
  const resetDiscovery = () => {
    setDiscoveredTotal(null);
    setShowCrawlConfirm(false);
    setCrawlEstimate(null);
  };

  // Plan-aware crawl ceiling — shown inline so the user knows their cap
  // before they kick off a crawl, and used to render an upgrade-CTA toast
  // when the backend rejects with 403 plan_limit_exceeded.
  const [crawlLimits, setCrawlLimits] = useState(null);
  useEffect(() => {
    let cancelled = false;
    getCurrentSubscription()
      .then((data) => {
        if (cancelled) return;
        const limits = data?.plan?.limits || {};
        setCrawlLimits({
          planName: data?.plan?.name || 'Free',
          planSlug: data?.plan?.slug || 'free',
          // Fallbacks track the Free-tier values from migration
          // b8d2faf4c321 — the bare minimum a customer could ever have.
          // The hint UI is conservative on purpose: if we can't read the
          // plan, show the smallest plausible cap so a Standard customer
          // doesn't see "75 pages" and panic.
          // ``-1`` is the UNLIMITED sentinel: paid tiers no longer cap
          // pages per crawl — the hint copy switches to credit-based
          // language in that case (see render below).
          // Fallbacks must match the backend's _DEFAULT_CRAWL_LIMITS floor
          // (plan_service.py) — advertising more than the crawler will
          // actually allow (the old 100 here vs 20 enforced) misleads users
          // whose plan row is missing the crawl keys.
          maxPages: limits.max_crawl_pages ?? 20,
          maxDepth: limits.max_crawl_depth ?? 3,
          jsMaxPages: limits.max_crawl_js_pages ?? 10,
        });
      })
      .catch(() => {
        // Non-fatal: the backend re-enforces the cap. Hint UI just gets
        // skipped when we can't fetch the plan (e.g. token glitch).
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // ── Crawl UI state ─────────────────────────────────────────────────────
  // The actual crawl lifecycle is owned by CrawlContext (one poll loop for
  // the whole admin app, so the floating indicator and this page agree on
  // state). These locals are derived from context — they're kept around so
  // the existing render JSX doesn't need to change shape.
  // Only surface in-page crawl detail when the active crawl belongs to the
  // currently selected bot. The global toast (GlobalCrawlIndicator) stays
  // visible regardless — this guard only affects the detail panel here.
  const isThisBotCrawl = crawl.botId === null || crawl.botId === selectedBot?.id;
  const isCrawling = isCrawlActive && isThisBotCrawl;
  // Once we're in the embedding phase, every page has already been fetched — so
  // no row should show the "scanning" spinner (that read as "stuck crawling").
  const isEmbedding = crawl.phase?.startsWith('Embedding') ?? false;
  const scanningUrls = (crawl.urls || []).map((u, i, arr) => ({
    url: u,
    // The most-recently-discovered URL is the one actively being crawled;
    // everything before it has been pulled successfully. During embedding all
    // pages are done.
    status: isCrawlActive && !isEmbedding && i === arr.length - 1 ? 'scanning' : 'done',
  }));
  const crawlStatus = (() => {
    if (crawl.status === 'done') {
      const dropped = crawl.result?.pages_dropped ?? 0;
      const droppedNote = dropped > 0 ? ` ${dropped} page${dropped === 1 ? '' : 's'} couldn't be fetched (server errors).` : '';
      return {
        type: 'success',
        message: `Crawled ${crawl.result?.pages_processed ?? crawl.urls.length} pages and ingested ${crawl.result?.chunks_processed ?? 0} chunks.${droppedNote}`,
      };
    }
    if (crawl.status === 'cancelled') {
      return {
        type: 'success',
        message: `Crawl cancelled — ${crawl.result?.pages_processed ?? crawl.urls.length} pages kept.`,
      };
    }
    if (crawl.status === 'failed') {
      return { type: 'error', message: crawl.error || 'Failed to crawl website.' };
    }
    return null;
  })();
  const [cancelConfirm, setCancelConfirm] = useState(false);

  const [documents, setDocuments] = useState([]);
  const [isLoadingDocs, setIsLoadingDocs] = useState(false);
  const [deletingDoc, setDeletingDoc] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [recrawlingDoc, setRecrawlingDoc] = useState(null);
  // Pre-recrawl diff state: while loading we show a spinner on the recrawl button;
  // once loaded we show a banner with exact unchanged / new / removed page counts so
  // the user can decide whether the recrawl is worth the credit spend.
  const [recrawlDiffLoading, setRecrawlDiffLoading] = useState(null);
  const [recrawlDiff, setRecrawlDiff] = useState(null);
  // Which diff bucket's URL list is currently expanded ('unchanged' | 'new' | 'removed' | null)
  const [recrawlDiffViewing, setRecrawlDiffViewing] = useState(null);
  const [drawerSource, setDrawerSource] = useState(null);

  // ── Recrawl history expander (per-Sources-row) ──
  // Only mounted for clients with the ``auto_recrawl`` entitlement — Free
  // and Starter never see the chevron. The history payload is bot-scoped
  // (auto-recrawl refreshes every crawled URL together, so there's no
  // per-URL history to render) and cached in local state; a re-fetch
  // fires when the customer opens the expander so a very recent run is
  // reflected without a full page reload.
  const autoRecrawlAvailable = entitlements.hasFeature('auto_recrawl');
  const [expandedSource, setExpandedSource] = useState(null);
  const [recrawlHistory, setRecrawlHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const toggleSourceHistory = async (sourceName) => {
    if (expandedSource === sourceName) {
      setExpandedSource(null);
      return;
    }
    setExpandedSource(sourceName);
    if (!selectedBot?.id) return;
    setHistoryLoading(true);
    try {
      const data = await getRecrawlStatus(selectedBot.id);
      setRecrawlHistory(Array.isArray(data?.recrawl_history) ? data.recrawl_history : []);
    } catch (err) {
      // A history-fetch failure isn't worth a toast — the expander just
      // renders "No recrawl history yet" and the customer can retry.
      console.warn('[KnowledgeBase] recrawl history fetch failed:', err?.message);
      setRecrawlHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const fetchDocuments = async () => {
    setIsLoadingDocs(true);
    try {
      const docs = await getDocuments(selectedBot?.id);
      setDocuments(docs || []);
    } catch (error) {
      console.error('Failed to load documents:', error);
      showToast('error', error.message || 'Failed to load documents');
    } finally {
      setIsLoadingDocs(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'list') fetchDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedBot?.id]);

  // The CrawlContext owns the poll loop now (single source of truth across
  // the whole admin app). This effect just reacts to terminal transitions
  // so the Knowledge page can clear its URL input and refresh the document
  // list — UI side-effects that don't belong in the shared context.
  useEffect(() => {
    // Only react to crawl terminal states that belong to the currently selected
    // bot. If bot2's crawl finishes while the user is viewing bot1, we must not
    // reset bot1's URL field, switch its tab, or re-fetch its document list.
    const isOwnCrawl = crawl.botId === null || crawl.botId === selectedBot?.id;
    if (crawl.status === 'done' && isOwnCrawl) {
      setUrl('');
      setRecrawlingDoc(null);
      resetDiscovery();
      if (activeTab === 'list') {
        fetchDocuments();
      } else {
        setActiveTab('list');
      }
    } else if ((crawl.status === 'cancelled' || crawl.status === 'failed') && isOwnCrawl) {
      setRecrawlingDoc(null);
      resetDiscovery();
      // Still refresh in case partial pages were ingested before cancel/fail.
      if (activeTab === 'list') fetchDocuments();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crawl.status, crawl.botId]);

  if (!botsLoading && bots.length === 0) {
    return <EmptyState title="Sources" description="Create a chatbot first, then upload documents and URLs to build its knowledge base." actionLabel="Create Chatbot" actionTo="/chatbot" />;
  }

  const supportedExtensions = ['.pdf', '.docx', '.txt', '.md'];
  const supportedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown'];

  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const filterFiles = (fileList) => {
    const accepted = [];
    for (const file of Array.from(fileList)) {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (!supportedTypes.includes(file.type) && !supportedExtensions.includes(ext)) continue;
      if (file.size > MAX_FILE_SIZE) {
        showToast(`"${file.name}" exceeds the 10 MB limit.`, 'error');
        continue;
      }
      accepted.push(file);
    }
    return accepted;
  };

  const handleDrop = (e) => { e.preventDefault(); setIsDragging(false); const files = filterFiles(e.dataTransfer.files); if (files.length > 0) setSelectedFiles(prev => [...prev, ...files]); };
  const handleFileSelect = (e) => { if (e.target.files) setSelectedFiles(prev => [...prev, ...filterFiles(e.target.files)]); };
  const removeFile = (index) => setSelectedFiles(prev => prev.filter((_, i) => i !== index));

  const handleUploadClick = async () => {
    if (selectedFiles.length === 0) return;
    setIsUploading(true); setUploadStatus(null);
    try {
      const result = await uploadDocuments(selectedFiles, selectedBot?.id);
      setUploadStatus({ type: 'success', message: `Successfully processed ${result.documents_processed_count || result.files_uploaded?.length} document chunks.` });
      setSelectedFiles([]);
      showToast('success', 'Documents uploaded successfully!');
      refreshEntitlements();
      if (activeTab === 'list') fetchDocuments();
    } catch (error) {
      const detail = error?.detail;
      if (detail && typeof detail === 'object' && detail.error === 'limit_reached') {
        const msg = detail.message || `You've reached your plan's document limit (${detail.current}/${detail.max}).`;
        setUploadStatus({ type: 'error', message: `${msg} Upgrade your plan to add more.` });
        showToast('error', msg);
      } else {
        setUploadStatus({ type: 'error', message: detail || error.message || 'Failed to upload documents.' });
      }
    } finally { setIsUploading(false); }
  };

  const handleDelete = async (docName) => {
    setDeletingDoc(docName);
    try {
      await deleteDocument(docName, selectedBot?.id);
      setDocuments(prev => prev.filter(d => d.name !== docName));
      showToast('success', 'Document deleted');
      refreshEntitlements();
    } catch (err) {
      showToast('error', `Failed to delete: ${err?.detail || err}`);
    } finally { setDeletingDoc(null); setConfirmingDelete(null); }
  };

  // Recrawl modes — see RecrawlMenu for the UX. Both handlers reach the
  // same diff endpoint; only the ``mode`` payload differs. The mode also
  // determines what ``handleConfirmRecrawl`` sends to /crawl:
  //   full  → force_reingest=True, no ordered_urls  (recursive re-crawl,
  //           charge for every page — Free/Starter's only recrawl option)
  //   delta → force_reingest=False, no ordered_urls (recursive re-crawl,
  //           pipeline dedup skips unchanged pages so only new/changed
  //           pages bill — Standard+ perk)
  const _requestRecrawl = async (docName, mode) => {
    const crawlUrl = docName.startsWith('http') ? docName : `https://${docName}`;
    const replaceSource = docName.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

    setRecrawlDiffLoading(docName);
    setRecrawlDiff(null);
    try {
      const diff = await diffRecrawl(crawlUrl, replaceSource, selectedBot?.id, mode);
      setRecrawlDiff({ docName, crawlUrl, replaceSource, mode, ...diff });
      setActiveTab('urls');
    } catch (err) {
      if (err?.status === 429) {
        showToast('error', 'Too many scan requests — please wait a few minutes before scanning again.');
        return;
      }
      // Plan-gate 403 from the backend — surface the upsell rather than a raw error.
      const detail = err?.detail || {};
      if (err?.status === 403 && detail?.error === 'feature_not_available' && detail?.feature === 'delta_recrawl') {
        showToast('error', 'Updated-pages-only recrawl requires the Standard plan.');
        navigate('/billing?tab=seats');
        return;
      }
      // Network/auth failure — still let the user proceed with a plain confirm.
      const errorMessage = err?.message || err?.detail || (typeof err === 'string' ? err : null);
      setRecrawlDiff({ docName, crawlUrl, replaceSource, mode, error: true, errorMessage });
      setActiveTab('urls');
    } finally {
      setRecrawlDiffLoading(null);
    }
  };

  const handleRequestFullRecrawl = (docName) => _requestRecrawl(docName, 'full');
  const handleRequestDeltaRecrawl = (docName) => _requestRecrawl(docName, 'delta');
  // Backwards-compat alias — the pre-existing "URL already ingested" submit
  // path (handleCrawlSubmit) still calls this by name. Default to delta for
  // entitled tiers so behavior matches the pre-mode-split flow; fall through
  // to full for tiers that can't use delta so they still get a confirmation
  // banner instead of a 403.
  const handleRequestRecrawl = (docName) =>
    _requestRecrawl(docName, canUseDeltaRecrawl ? 'delta' : 'full');

  const handleUpgradeForDelta = () => {
    showToast('info', 'Delta recrawl is available on the Standard plan.');
    navigate('/billing?tab=seats');
  };

  const handleConfirmRecrawl = async () => {
    if (!recrawlDiff) return;
    const {
      docName,
      mode = 'delta',
      new_pages: newPages = 0,
      sitemap_total: sitemapTotal = 0,
      new_urls: newUrls = [],
      unchanged_urls: unchangedUrls = [],
      capped = false,
    } = recrawlDiff;
    setRecrawlDiff(null);
    setRecrawlDiffViewing(null);
    if (mode === 'delta' && newPages === 0) {
      // Delta mode with zero new URLs still crawls to catch content-changed
      // pages on existing URLs — the pipeline dedup skips truly unchanged
      // pages for free. Tell the user what we're doing so they don't think
      // the button is a no-op.
      showToast('info', 'Scanning existing pages for content changes — only changed pages will be billed.');
    }
    if (mode === 'full' && sitemapTotal === 0) {
      showToast('error', 'No pages discovered on this website. Try again in a minute.');
      return;
    }
    // Prefer the diff's exact URL list over the recursive crawler. Two wins:
    //   1) Reliability — some sites (bot-detection landing pages, JS-only
    //      shells) return 0 pages to the recursive Playwright crawl even
    //      when direct GETs work fine. That path bubbles up as "target site
    //      unreachable" and torches the whole recrawl. fetch_urls hits each
    //      URL individually and tolerates partial failures.
    //   2) Speed — no sitemap re-discovery, no BFS enumeration.
    // Fall back to the recursive crawler only when the diff was capped
    // (>500 pages): the diff response's URL lists are truncated at that
    // point, so passing them would silently drop the tail.
    const orderedUrls = capped
      ? null
      : Array.from(new Set([...(newUrls || []), ...(unchangedUrls || [])])).filter(Boolean);
    await handleRecrawl(docName, mode, orderedUrls, newPages);
  };

  const dismissRecrawlDiff = () => {
    setRecrawlDiff(null);
    setRecrawlDiffViewing(null);
  };

  const handleRecrawl = async (docName, mode = 'delta', orderedUrls = null, expectedNewPages = null) => {
    setRecrawlingDoc(docName);
    const crawlUrl = docName.startsWith('http') ? docName : `https://${docName}`;
    // Normalize to root domain so the backend knows what stale chunks to sweep after success
    const replaceSource = docName.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

    try {
      // Switch to Website Scan tab so the live URL progress panel is visible
      setActiveTab('urls');
      // Delegate to CrawlContext — it owns the lifecycle, the global toast
      // follows the user across routes, and the page just observes state.
      //
      // orderedUrls (when set) skips the recursive crawler in favor of a
      // direct fetch of exactly this list — mirrors the pre-recrawl-menu
      // recrawl flow which was more reliable on JS-shell sites. When null
      // (diff was capped), the backend runs the recursive crawler instead.
      //
      //   full  → backend sets force_reingest=True; pipeline bills every page.
      //   delta → backend sets force_reingest=False; pipeline dedup skips
      //           unchanged pages so only new + content-changed pages bill.
      await startCrawl({
        url: crawlUrl,
        botId: selectedBot?.id,
        botName: selectedBot?.name,
        useJs: false,
        replaceSource,
        mode,
        orderedUrls: orderedUrls && orderedUrls.length ? orderedUrls : null,
        // For delta mode with a known-small change set, right-size the
        // credit pre-flight to the new-page count instead of the plan's
        // worst-case ceiling. Full mode intentionally passes null so the
        // pre-flight reserves the whole ordered_urls list (== every page).
        expectedNewPages: mode === 'delta' && Number.isFinite(expectedNewPages) ? expectedNewPages : null,
      });
    } catch (err) {
      // buildApiError flattens structured FastAPI errors (e.g. 402 insufficient_credits)
      // into err.message — use that. Falling back to err.detail risks rendering an
      // object into JSX (React #31) when detail is the raw {error, required, ...} bag.
      const detailMessage =
        err?.detail && typeof err.detail === 'object' && typeof err.detail.message === 'string'
          ? err.detail.message
          : typeof err?.detail === 'string'
            ? err.detail
            : null;
      showToast('error', `Recrawl failed: ${err?.message || detailMessage || 'unknown error'}`);
      setActiveTab('list');
      setRecrawlingDoc(null);
    }
  };

  // Step 1: discover page count, then show confirmation banner
  const handleCrawlSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim() || isDiscovering) return;

    // Normalize a bare domain to an absolute https:// URL and reflect it back in
    // the field so discovery, the confirm step, and startCrawl all use it.
    const normalizedUrl = normalizeWebsiteUrl(url);
    if (normalizedUrl !== url) setUrl(normalizedUrl);

    // If this domain is already ingested, route through the diff flow so a
    // re-scan only fetches + charges NEW pages instead of re-crawling (and
    // re-billing) the whole site.
    const enteredHost = normalizedUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    const alreadyIngested = documents.find((d) => {
      if (!(d.name.startsWith('http://') || d.name.startsWith('https://'))) return false;
      const dHost = d.name.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
      return dHost === enteredHost;
    });
    if (alreadyIngested) {
      await handleRequestRecrawl(alreadyIngested.name);
      return;
    }

    setDiscoveredTotal(null);
    setShowCrawlConfirm(false);
    setCrawlEstimate(null);
    setIsDiscovering(true);
    try {
      const result = await discoverCrawlUrls(normalizedUrl, selectedBot?.id);
      // Preserve 0 as a meaningful value: "sitemap found but empty / no sitemap"
      // so the dialog can show a helpful note rather than the generic fallback.
      setDiscoveredTotal(typeof result.total_found === 'number' ? result.total_found : null);
      setCrawlEstimate(result);
      // When the site exceeds the balance, default the picker to the most the
      // user can afford (never above the affordable cap).
      if (result?.exceeds_balance) {
        const affordable = Math.max(0, Number(result.max_affordable_pages) || 0);
        setCrawlCount(Math.min(Number(result.total_found) || 0, affordable));
        setCrawlOrder('shallow');
      }
    } catch (err) {
      if (err?.status === 429) {
        showToast('error', 'Too many scan requests — please wait a few minutes before scanning again.');
        return; // don't show confirm dialog when rate-limited
      }
      // Other failures (network blip, auth) — still allow crawl without count.
      setDiscoveredTotal(null);
      setCrawlEstimate(null);
    } finally {
      setIsDiscovering(false);
      setShowCrawlConfirm(true);
    }
  };

  // Step 2: user confirmed — actually start the crawl
  const handleConfirmCrawl = async () => {
    setShowCrawlConfirm(false);
    // Credit-aware partial crawl: when the site exceeds the balance, send the
    // chosen ordered slice + count so the backend fetches exactly that much.
    let orderedUrls = null;
    let maxPages = null;
    if (crawlEstimate?.exceeds_balance && Array.isArray(crawlEstimate.urls) && crawlCount > 0) {
      orderedUrls = sliceForCrawl(crawlEstimate.urls, crawlOrder, crawlCount);
      maxPages = crawlCount;
    }
    try {
      await startCrawl({
        url,
        botId: selectedBot?.id,
        botName: selectedBot?.name,
        useJs,
        discoveredTotal,
        orderedUrls,
        maxPages,
      });
    } catch (error) {
      const detail = error?.detail;
      if (detail && typeof detail === 'object' && detail.error === 'plan_limit_exceeded') {
        showToast(
          'error',
          `${detail.message || 'Plan limit reached.'} Open Billing to upgrade.`,
        );
        return;
      }
      // buildApiError already extracts detail.message into error.message for
      // structured FastAPI errors (e.g. 402 insufficient_credits). Rendering
      // raw error.detail here used to land an object inside <p>{message}</p>
      // and trigger React error #31. Prefer the flattened string; fall back
      // to detail.message only if shape is unexpected.
      const fallback =
        detail && typeof detail === 'object' && typeof detail.message === 'string'
          ? detail.message
          : typeof detail === 'string'
            ? detail
            : null;
      showToast('error', error.message || fallback || 'Failed to start crawl.');
    }
  };

  const handleCancelCrawl = async () => {
    setCancelConfirm(false);
    try {
      await cancelCrawl();
    } catch (err) {
      showToast('error', err?.message || 'Failed to cancel crawl.');
    }
  };

  const renderStatus = (status) => {
    if (!status) return null;
    const isSuccess = status.type === 'success';
    return (
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn(
          'mt-4 p-3.5 rounded-xl flex items-start gap-2.5 text-sm font-medium border',
          isSuccess
            ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20'
            : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-500/20'
        )}
      >
        {isSuccess ? <CheckCircle2 className="shrink-0 mt-0.5" size={16} /> : <AlertCircle className="shrink-0 mt-0.5" size={16} />}
        <p>{status.message}</p>
      </motion.div>
    );
  };

  const fileTypeIcon = (name) => {
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'bg-rose-50 dark:bg-rose-500/10 text-rose-500';
    if (ext === 'docx') return 'bg-primary-50 dark:bg-primary-500/10 text-primary-500';
    return 'bg-surface-100 dark:bg-surface-800 text-surface-500';
  };

  const tabs = [
    { id: 'list', label: 'All Sources', icon: ListIcon },
    { id: 'urls', label: 'Website Scan', icon: LinkIcon },
    { id: 'files', label: 'Documents', icon: UploadCloud },
  ];

  return (
    <div className="space-y-6 -mt-2">
      <PageHeader crumbs={[{ label: 'Home', to: '/' }, { label: 'Sources' }]} title="Sources" />
      <Tabs tabs={tabs} activeTab={activeTab} onChange={handleTabChange} />

      <div className="bg-[var(--bg-card)] dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm max-w-4xl min-h-[400px]">

        {/* FILE UPLOAD */}
        {activeTab === 'files' && (
          <div className="space-y-5">
            <h2 className="text-base font-bold text-surface-900 dark:text-white">Upload Knowledge Documents</h2>

            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={cn(
                'border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center text-center transition-all',
                isDragging
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10'
                  : 'border-surface-200 dark:border-surface-700 hover:border-primary-300 dark:hover:border-primary-600 bg-surface-50 dark:bg-surface-800/50'
              )}
            >
              <div className="w-14 h-14 rounded-2xl bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400 flex items-center justify-center mb-4">
                <UploadCloud size={28} />
              </div>
              <h3 className="text-surface-900 dark:text-white font-medium mb-1 text-sm">Drag and drop your documents here</h3>
              <p className="text-surface-400 text-xs mb-5">PDF, DOCX, TXT, MD (Max 10MB)</p>
              <input type="file" multiple accept=".pdf,.docx,.txt,.md" className="hidden" ref={fileInputRef} onChange={handleFileSelect} />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-5 py-2 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-700 text-sm font-medium transition-all"
                disabled={isUploading}
              >
                Browse Files
              </button>
            </div>

            <div
              className={cn(
                'rounded-xl border px-4 py-3',
                docsAtLimit
                  ? 'border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10'
                  : docsNearLimit
                    ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10'
                    : 'border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-800/50',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={cn(
                      'p-2 rounded-lg shrink-0',
                      docsAtLimit
                        ? 'bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-300'
                        : docsNearLimit
                          ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-300'
                          : 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400',
                    )}
                  >
                    <FileText size={14} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-surface-900 dark:text-white truncate">
                      Documents used
                    </p>
                    <p className="text-xs text-surface-500 dark:text-surface-400 truncate">
                      <span className="font-medium text-surface-700 dark:text-surface-200">
                        {entitlements.planName || 'Free'}
                      </span>{' '}
                      plan
                      {isUnlimitedDocs
                        ? ' — unlimited documents'
                        : ` — ${docsLimit} document${docsLimit === 1 ? '' : 's'} included`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span
                    className={cn(
                      'text-sm font-semibold tabular-nums',
                      docsAtLimit
                        ? 'text-rose-600 dark:text-rose-300'
                        : docsNearLimit
                          ? 'text-amber-600 dark:text-amber-300'
                          : 'text-surface-900 dark:text-white',
                    )}
                  >
                    {docsUsed}
                    {' / '}
                    {isUnlimitedDocs ? '∞' : docsLimit}
                  </span>
                  {!isUnlimitedDocs && entitlements.planSlug !== 'enterprise' && (docsAtLimit || docsNearLimit) && (
                    <a
                      href="/billing"
                      className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white transition-colors"
                    >
                      <ChevronsUp size={14} strokeWidth={2.5} />
                      Upgrade
                    </a>
                  )}
                </div>
              </div>
              {!isUnlimitedDocs && (
                <div className="mt-3 h-1.5 w-full rounded-full bg-surface-200/70 dark:bg-surface-800 overflow-hidden">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      docsAtLimit
                        ? 'bg-rose-500'
                        : docsNearLimit
                          ? 'bg-amber-500'
                          : 'bg-primary-500',
                    )}
                    style={{ width: `${docsPercent}%` }}
                  />
                </div>
              )}
              {docsAtLimit && (
                <p className="mt-2 text-xs text-rose-600 dark:text-rose-300">
                  You&apos;ve reached your plan&apos;s document limit. Delete an existing source or upgrade to add more.
                </p>
              )}
            </div>

            <AnimatePresence>
              {selectedFiles.length > 0 && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-3">
                  <h4 className="text-sm font-medium text-surface-600 dark:text-surface-400">Selected ({selectedFiles.length})</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {selectedFiles.map((file, index) => (
                      <motion.div
                        key={index}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="flex items-center justify-between p-3 border border-surface-200 dark:border-surface-800 rounded-xl bg-white dark:bg-surface-800/50"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={cn('p-2 rounded-lg shrink-0', fileTypeIcon(file.name))}>
                            <FileText size={14} />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-surface-900 dark:text-white truncate">{file.name}</p>
                            <p className="text-xs text-surface-400">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                          </div>
                        </div>
                        <button onClick={() => removeFile(index)} disabled={isUploading} className="p-1.5 text-surface-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-lg transition-colors shrink-0">
                          <X size={14} />
                        </button>
                      </motion.div>
                    ))}
                  </div>
                  {!isUnlimitedDocs && selectedFiles.length > docsRemaining && (
                    <p className="text-xs text-rose-600 dark:text-rose-300">
                      You can only add {docsRemaining} more document{docsRemaining === 1 ? '' : 's'} on your {entitlements.planName || 'Free'} plan ({docsUsed}/{docsLimit} used). Remove some files or upgrade.
                    </p>
                  )}
                  <div className="flex justify-end pt-2">
                    <button
                      onClick={handleUploadClick}
                      disabled={isUploading || docsAtLimit || (!isUnlimitedDocs && selectedFiles.length > docsRemaining)}
                      className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                    >
                      {isUploading ? <><Loader2 size={16} className="animate-spin" /> Processing...</> : <><UploadCloud size={16} /> Upload {selectedFiles.length} Files</>}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {renderStatus(uploadStatus)}
          </div>
        )}

        {/* URL CRAWL */}
        {activeTab === 'urls' && (
          <div className="space-y-5">
            <div>
              <h2 className="text-base font-bold text-surface-900 dark:text-white">Ingest Website Content</h2>
              <p className="text-sm text-surface-500 mt-1">Enter a URL and we&apos;ll crawl the site to build your chatbot&apos;s knowledge</p>
            </div>
            <form onSubmit={handleCrawlSubmit} className="space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-surface-700 dark:text-surface-300 mb-1.5">Website URL</label>
                <div className="relative group">
                  <LinkIcon size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                  <input
                    type="text" inputMode="url" value={url} onChange={(e) => { setUrl(e.target.value); resetDiscovery(); }} required
                    placeholder="example.com"
                    className={cn(
                      'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white dark:bg-surface-800 text-surface-900 dark:text-white',
                      'border-surface-200 dark:border-surface-700 focus:ring-1 focus:ring-[var(--focus-ring)] focus:border-[var(--focus)] dark:focus:border-[var(--focus)]',
                      'outline-none transition-all text-sm placeholder:text-surface-400'
                    )}
                    disabled={isCrawling}
                  />
                </div>
                {crawlLimits && (
                  <p className="mt-2 text-xs text-surface-500 dark:text-surface-400">
                    Your <span className="font-medium text-surface-700 dark:text-surface-200">{crawlLimits.planName}</span> plan:{' '}
                    {crawlLimits.maxPages === -1 ? (
                      <>
                        <span className="font-medium text-surface-700 dark:text-surface-200">unlimited pages per crawl</span>
                        {' '}— each page uses{' '}
                        <span className="font-medium text-surface-700 dark:text-surface-200">5 credits</span>
                        {useJs && (
                          <>
                            {' '}(JS mode capped at {crawlLimits.jsMaxPages.toLocaleString()} pages)
                          </>
                        )}
                        , depth {crawlLimits.maxDepth}.
                      </>
                    ) : (
                      <>
                        up to{' '}
                        <span className="font-medium text-surface-700 dark:text-surface-200">
                          {crawlLimits.maxPages.toLocaleString()} pages
                        </span>{' '}
                        per crawl
                        {useJs && (
                          <>
                            {' '}({crawlLimits.jsMaxPages.toLocaleString()} in JS mode)
                          </>
                        )}
                        , depth {crawlLimits.maxDepth}.
                      </>
                    )}
                    {crawlLimits.planSlug !== 'enterprise' && crawlLimits.maxPages !== -1 && (
                      <>
                        {' '}
                        <a
                          href="/billing"
                          className="text-primary-600 dark:text-primary-400 hover:underline font-medium"
                        >
                          Upgrade for more
                        </a>
                        .
                      </>
                    )}
                  </p>
                )}
              </div>

              {/* JavaScript mode toggle */}
              <button
                type="button"
                onClick={() => { setUseJs(prev => !prev); resetDiscovery(); }}
                disabled={isCrawling}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-sm',
                  useJs
                    ? 'border-primary-400 dark:border-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                    : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:border-surface-300 dark:hover:border-surface-600'
                )}
              >
                <div className={cn(
                  'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                  useJs ? 'bg-primary-100 dark:bg-primary-500/20 text-primary-600 dark:text-primary-300' : 'bg-surface-100 dark:bg-surface-700 text-surface-400'
                )}>
                  <Zap size={15} />
                </div>
                <div className="flex-1 text-left">
                  <p className="font-medium leading-tight">JavaScript Mode</p>
                  <p className="text-xs opacity-70 mt-0.5">Required for Next.js, React &amp; other SPA sites</p>
                </div>
                <div className={cn(
                  'w-10 h-5 rounded-full transition-all relative shrink-0',
                  useJs ? 'bg-primary-500' : 'bg-surface-300 dark:bg-surface-600'
                )}>
                  <div className={cn(
                    'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all',
                    useJs ? 'left-[22px]' : 'left-0.5'
                  )} />
                </div>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={isCrawling || isDiscovering || !url}
                  className="flex-1 flex items-center justify-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-70 shadow-sm"
                >
                  {isCrawling
                    ? <><Loader2 size={16} className="animate-spin" /> Crawling...</>
                    : isDiscovering
                      ? <><Loader2 size={16} className="animate-spin" /> Counting pages...</>
                      : url
                        ? <><Globe size={16} /> Scan Website</>
                        : <><Globe size={16} /> Start Crawl</>}
                </button>
                {isCrawling && (
                  <button
                    type="button"
                    onClick={() => setCancelConfirm(true)}
                    disabled={crawl.status === 'cancelling' || crawl.cancelInFlight}
                    className={cn(
                      'flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all shadow-sm',
                      'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200',
                      'dark:bg-rose-500/10 dark:hover:bg-rose-500/20 dark:text-rose-300 dark:border-rose-500/30',
                      'disabled:opacity-60 disabled:cursor-not-allowed',
                    )}
                  >
                    {crawl.status === 'cancelling' ? (
                      <>
                        <Loader2 size={14} className="animate-spin" /> Stopping…
                      </>
                    ) : (
                      <>
                        <StopCircle size={14} /> Cancel
                      </>
                    )}
                  </button>
                )}
              </div>
            </form>

            {/* Cancel confirmation — light inline confirm rather than a modal
                so the user doesn't lose sight of the live progress panel. */}
            <AnimatePresence>
              {cancelConfirm && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="p-4 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10"
                >
                  <p className="text-sm text-amber-800 dark:text-amber-200 font-medium">
                    Stop this crawl?
                  </p>
                  <p className="text-xs text-amber-700/80 dark:text-amber-300/80 mt-1">
                    Any pages already discovered will be discarded. You won&apos;t be charged for crawls that didn&apos;t finish.
                  </p>
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      type="button"
                      onClick={handleCancelCrawl}
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white"
                    >
                      <StopCircle size={12} /> Stop crawl
                    </button>
                    <button
                      type="button"
                      onClick={() => setCancelConfirm(false)}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-white/60 dark:bg-white/5 hover:bg-white text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-500/20"
                    >
                      Keep crawling
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Pre-recrawl confirmation — shown after the diff endpoint returns,
                before the actual recrawl starts. Surfaces exact URL-level diff
                so the user knows what they're spending credits on. */}
            <AnimatePresence>
              {recrawlDiff && !isCrawling && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="p-6 rounded-2xl border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 shadow-sm"
                >
                  <div className="flex items-start gap-4">
                    <div className={cn(
                      'w-12 h-12 rounded-xl flex items-center justify-center shrink-0',
                      recrawlDiff.mode === 'delta'
                        ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400',
                    )}>
                      {recrawlDiff.mode === 'delta'
                        ? <Sparkles size={22} />
                        : <RefreshCw size={22} className="text-primary-600 dark:text-primary-400" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base font-semibold text-surface-900 dark:text-white leading-tight">
                        {recrawlDiff.mode === 'delta'
                          ? 'Re-crawl only updated pages?'
                          : 'Re-crawl the entire website?'}
                      </h3>
                      <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
                        {recrawlDiff.mode === 'delta'
                          ? "Unchanged pages are free — you'll only be billed for pages whose content changed since the last crawl."
                          : 'Every discovered page will be re-scraped and re-embedded, and every page will be charged.'}
                      </p>
                      <a
                        href={recrawlDiff.crawlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 font-medium mt-3 transition-colors"
                      >
                        <Globe size={15} />
                        <span className="truncate max-w-[240px] sm:max-w-md">{recrawlDiff.crawlUrl}</span>
                        <ExternalLink size={13} className="opacity-80" />
                      </a>
                    </div>
                  </div>

                  <div className="h-px bg-surface-200 dark:bg-surface-800/80 my-5" />

                  {recrawlDiff.error ? (
                    <div className="p-4 rounded-xl border border-rose-200 dark:border-rose-500/20 bg-rose-50/50 dark:bg-rose-500/5 text-rose-700 dark:text-rose-300 text-xs sm:text-sm space-y-1.5">
                      <div>
                        Couldn&apos;t fetch the page diff. You can still proceed — the
                        crawl will {recrawlDiff.mode === 'delta'
                          ? 'skip unchanged pages during ingestion.'
                          : 're-scrape and re-bill every page.'}
                      </div>
                      {recrawlDiff.errorMessage && (
                        <div className="font-mono text-[11px] leading-snug break-words opacity-80">
                          {recrawlDiff.errorMessage}
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        {[
                          {
                            key: 'unchanged',
                            label: 'Unchanged',
                            sublabel: 'Pages unchanged',
                            count: recrawlDiff.unchanged,
                            urls: recrawlDiff.unchanged_urls || [],
                            labelClass: 'text-surface-400 dark:text-surface-400',
                            borderClass: 'border-surface-200 dark:border-surface-800',
                            bgClass: 'bg-surface-100/50 dark:bg-surface-800/40',
                            ringClass: 'ring-surface-300 dark:ring-surface-700',
                          },
                          {
                            key: 'new',
                            label: 'New',
                            sublabel: 'New pages found',
                            count: recrawlDiff.new_pages,
                            urls: recrawlDiff.new_urls || [],
                            labelClass: 'text-emerald-500 dark:text-emerald-400',
                            borderClass: 'border-emerald-200 dark:border-emerald-500/30',
                            bgClass: 'bg-emerald-50/30 dark:bg-emerald-500/5',
                            ringClass: 'ring-emerald-300 dark:ring-emerald-500/40',
                          },
                          {
                            key: 'removed',
                            label: 'Removed',
                            sublabel: 'Pages removed',
                            count: recrawlDiff.removed_pages,
                            urls: recrawlDiff.removed_urls || [],
                            labelClass: 'text-rose-500 dark:text-rose-400',
                            borderClass: 'border-rose-200 dark:border-rose-500/30',
                            bgClass: 'bg-rose-50/30 dark:bg-rose-500/5',
                            ringClass: 'ring-rose-300 dark:ring-rose-500/40',
                          },
                        ].map((tile) => {
                          const isActive = recrawlDiffViewing === tile.key;
                          const isDisabled = tile.count === 0;
                          return (
                            <div
                              key={tile.key}
                              className={cn(
                                'relative border rounded-xl p-5 flex flex-col justify-between min-h-[120px] transition-all',
                                tile.borderClass,
                                tile.bgClass,
                                isActive && `ring-2 ${tile.ringClass}`,
                              )}
                            >
                              <button
                                type="button"
                                onClick={() => setRecrawlDiffViewing(isActive ? null : tile.key)}
                                disabled={isDisabled}
                                className={cn(
                                  'absolute top-3 right-3 p-1 rounded-md text-surface-400 dark:text-surface-500 transition-colors',
                                  isDisabled
                                    ? 'opacity-40 cursor-not-allowed'
                                    : 'hover:text-surface-700 dark:hover:text-white hover:bg-white/60 dark:hover:bg-white/5 cursor-pointer',
                                )}
                                aria-label={`View ${tile.label.toLowerCase()} pages`}
                                aria-expanded={isActive}
                              >
                                <Eye size={13} />
                              </button>
                              <div className={cn('text-xs font-semibold uppercase tracking-wider pr-7', tile.labelClass)}>
                                {tile.label}
                              </div>
                              <div className="text-2xl font-bold text-surface-900 dark:text-white tabular-nums my-1">
                                {tile.count.toLocaleString()}
                              </div>
                              <div className="text-xs text-surface-500 dark:text-surface-500">
                                {tile.sublabel}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Pre-crawl credit warning — full mode only. Delta's
                          actual bill depends on how many pages the pipeline
                          detects as content-changed at ingest time, so we
                          don't invent a number the user can't hold us to.
                          For full mode the math is exact: sitemap_total ×
                          cost_per_page = credits_required. Turns red when
                          the caller can't afford the crawl so the confirm
                          button below reads as an obvious dead end. */}
                      {recrawlDiff.mode === 'full' && recrawlDiff.sitemap_total > 0 && (() => {
                        const perPage = Number(recrawlDiff.cost_per_page ?? 1);
                        const pages = Number(recrawlDiff.sitemap_total ?? 0);
                        const required = Number(recrawlDiff.credits_required_full ?? perPage * pages);
                        const balance = Number(recrawlDiff.balance ?? 0);
                        const exceeds = Boolean(recrawlDiff.exceeds_balance) || required > balance;
                        return (
                          <div
                            className={cn(
                              'mt-4 rounded-xl border p-4 flex items-start gap-3',
                              exceeds
                                ? 'border-rose-200 dark:border-rose-500/30 bg-rose-50/60 dark:bg-rose-500/5'
                                : 'border-surface-200 dark:border-surface-800 bg-white/60 dark:bg-surface-800/40',
                            )}
                          >
                            <div
                              className={cn(
                                'shrink-0 w-9 h-9 rounded-lg flex items-center justify-center',
                                exceeds
                                  ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                                  : 'bg-primary-500/10 text-primary-600 dark:text-primary-300',
                              )}
                            >
                              <CreditCoin className="w-5 h-5" />
                            </div>
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className={cn(
                                'text-sm font-semibold',
                                exceeds
                                  ? 'text-rose-700 dark:text-rose-200'
                                  : 'text-surface-900 dark:text-white',
                              )}>
                                {exceeds ? (
                                  <>
                                    Not enough credits — this recrawl needs{' '}
                                    <span className="tabular-nums">{required.toLocaleString()}</span>{' '}
                                    credit{required === 1 ? '' : 's'}
                                  </>
                                ) : (
                                  <>
                                    This will charge{' '}
                                    <span className="tabular-nums">{required.toLocaleString()}</span>{' '}
                                    credit{required === 1 ? '' : 's'}
                                  </>
                                )}
                              </div>
                              <div className="text-xs text-surface-500 dark:text-surface-400 tabular-nums">
                                {perPage.toLocaleString()} credit{perPage === 1 ? '' : 's'} per page
                                {' × '}
                                {pages.toLocaleString()} page{pages === 1 ? '' : 's'}
                                {' — '}
                                you have{' '}
                                <span className={cn(
                                  'font-semibold',
                                  exceeds
                                    ? 'text-rose-600 dark:text-rose-300'
                                    : 'text-surface-900 dark:text-white',
                                )}>
                                  {balance.toLocaleString()}
                                </span>{' '}
                                credit{balance === 1 ? '' : 's'} available
                              </div>
                              {exceeds && (
                                <div className="text-[11px] text-rose-600 dark:text-rose-300/90 pt-1">
                                  Upgrade your plan or buy a top-up to unlock this recrawl.
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}

                      {recrawlDiffViewing && (() => {
                        const buckets = {
                          unchanged: { label: 'Unchanged pages', urls: recrawlDiff.unchanged_urls || [], count: recrawlDiff.unchanged },
                          new: { label: 'New pages', urls: recrawlDiff.new_urls || [], count: recrawlDiff.new_pages },
                          removed: { label: 'Removed pages', urls: recrawlDiff.removed_urls || [], count: recrawlDiff.removed_pages },
                        };
                        const active = buckets[recrawlDiffViewing];
                        const truncated = active.count > active.urls.length;
                        return (
                          <div className="mt-4 rounded-xl border border-surface-200 dark:border-surface-800 bg-white/60 dark:bg-surface-800/40 overflow-hidden">
                            <div className="px-4 py-2.5 border-b border-surface-200 dark:border-surface-800 flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-surface-900 dark:text-white">
                                {active.label}
                                <span className="text-surface-500 dark:text-surface-500 font-normal ml-1.5">
                                  ({active.count.toLocaleString()})
                                </span>
                              </span>
                              <button
                                type="button"
                                onClick={() => setRecrawlDiffViewing(null)}
                                className="p-1 rounded text-surface-400 dark:text-surface-500 hover:text-surface-700 dark:hover:text-white transition-colors"
                                aria-label="Close page list"
                              >
                                <X size={12} />
                              </button>
                            </div>
                            <ul className="max-h-56 overflow-y-auto divide-y divide-surface-100 dark:divide-surface-800/60">
                              {active.urls.map((u) => (
                                <li key={u} className="px-4 py-1.5 text-xs">
                                  <a
                                    href={u}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1.5 text-surface-700 dark:text-surface-200 hover:text-primary-600 dark:hover:text-primary-300 hover:underline truncate"
                                  >
                                    <ExternalLink size={11} className="shrink-0 opacity-60" />
                                    <span className="truncate">{u}</span>
                                  </a>
                                </li>
                              ))}
                              {active.urls.length === 0 && (
                                <li className="px-4 py-3 text-xs text-surface-500 dark:text-surface-500 text-center">
                                  No pages in this bucket.
                                </li>
                              )}
                            </ul>
                            {truncated && (
                              <div className="px-4 py-1.5 border-t border-surface-200 dark:border-surface-800 text-[10px] text-surface-500 dark:text-surface-500">
                                Showing first {active.urls.length.toLocaleString()} of {active.count.toLocaleString()} pages.
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </>
                  )}

                  <div className="flex items-center gap-3 mt-6">
                    {/* Full-mode insufficient-balance is the only case we
                        can gate up front — delta's actual bill isn't
                        knowable until ingest. The route enforces the same
                        gate server-side (402 insufficient_credits), so this
                        is UX polish, not the security boundary. */}
                    {(() => {
                      const isFullBlocked =
                        recrawlDiff.mode === 'full' && Boolean(recrawlDiff.exceeds_balance);
                      return (
                        <button
                          type="button"
                          onClick={isFullBlocked ? () => navigate('/billing?tab=seats') : handleConfirmRecrawl}
                          className={cn(
                            'flex items-center justify-center font-medium px-4 py-2 rounded-xl transition-all text-sm shadow-sm text-white',
                            isFullBlocked
                              ? 'bg-rose-600 hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-600'
                              : 'bg-primary-600 hover:bg-primary-700 dark:bg-primary-500 dark:hover:bg-primary-600',
                          )}
                        >
                          {isFullBlocked
                            ? 'Get more credits'
                            : recrawlDiff.mode === 'delta'
                              ? 'Re-crawl changed pages'
                              : 'Re-crawl all pages'}
                        </button>
                      );
                    })()}
                    <button
                      type="button"
                      onClick={dismissRecrawlDiff}
                      className="flex items-center justify-center border border-surface-300 dark:border-surface-700 bg-transparent hover:bg-surface-100 dark:hover:bg-surface-800/40 text-surface-700 dark:text-surface-200 font-medium px-4 py-2 rounded-xl transition-all text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Pre-crawl confirmation — shown after discovery, before the crawl starts */}
            <AnimatePresence>
              {showCrawlConfirm && !isCrawling && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="p-4 rounded-xl border border-primary-200 dark:border-primary-500/30 bg-primary-50 dark:bg-primary-500/10"
                >
                  <div className="flex items-start gap-3">
                    <div className="p-1.5 rounded-lg bg-primary-100 dark:bg-primary-500/20 text-primary-600 dark:text-primary-400 shrink-0 mt-0.5">
                      <Globe size={14} />
                    </div>
                    <div className="flex-1 min-w-0">
                      {discoveredTotal > 0 ? (
                        <p className="text-sm font-semibold text-primary-900 dark:text-primary-100">
                          <span className="tabular-nums">{discoveredTotal.toLocaleString()}</span> page{discoveredTotal === 1 ? '' : 's'} found in sitemap
                        </p>
                      ) : discoveredTotal === 0 ? (
                        <>
                          <p className="text-sm font-semibold text-primary-900 dark:text-primary-100">
                            No sitemap found — ready to crawl?
                          </p>
                          <p className="text-xs text-primary-700/60 dark:text-primary-300/60 mt-0.5">
                            We&apos;ll follow links from the homepage to discover pages automatically.
                          </p>
                        </>
                      ) : (
                        <p className="text-sm font-semibold text-primary-900 dark:text-primary-100">
                          Ready to crawl this website?
                        </p>
                      )}
                      <p className="text-xs text-primary-700/80 dark:text-primary-300/80 mt-0.5 truncate">
                        {url}
                      </p>
                    </div>
                  </div>

                  {/* Credit-aware picker — only when the site exceeds the balance */}
                  {crawlEstimate?.exceeds_balance && (
                    <div className="mt-3 rounded-lg border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3 space-y-3">
                      <p className="text-xs text-amber-900 dark:text-amber-200">
                        This site has{' '}
                        <span className="font-semibold tabular-nums">
                          {(crawlEstimate.total_found ?? 0).toLocaleString()}{crawlEstimate.capped ? '+' : ''}
                        </span>{' '}
                        pages ({(crawlEstimate.credits_required_full ?? 0).toLocaleString()} credits). You have{' '}
                        <span className="font-semibold tabular-nums">{(crawlEstimate.balance ?? 0).toLocaleString()}</span>{' '}
                        credits — enough for{' '}
                        <span className="font-semibold tabular-nums">{(crawlEstimate.max_affordable_pages ?? 0).toLocaleString()}</span>{' '}
                        pages.{crawlEstimate.capped ? ' (Site has more pages than shown.)' : ''}
                      </p>
                      {(crawlEstimate.max_affordable_pages ?? 0) > 0 ? (
                        <>
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs font-medium text-amber-900 dark:text-amber-200">
                              <span>Pages to crawl</span>
                              <input
                                type="number"
                                min={1}
                                max={crawlEstimate.max_affordable_pages}
                                value={crawlCount}
                                onChange={(e) => {
                                  const n = Math.max(
                                    1,
                                    Math.min(crawlEstimate.max_affordable_pages, Number(e.target.value) || 1),
                                  );
                                  setCrawlCount(n);
                                }}
                                className="w-20 text-right rounded-md border border-amber-300 dark:border-amber-500/30 bg-[var(--bg-card)] dark:bg-surface-900 px-2 py-1 text-xs tabular-nums"
                              />
                            </div>
                            <input
                              type="range"
                              min={1}
                              max={crawlEstimate.max_affordable_pages}
                              value={crawlCount}
                              onChange={(e) => setCrawlCount(Number(e.target.value))}
                              className="w-full accent-primary-600"
                            />
                          </div>
                          <div className="space-y-1">
                            {CRAWL_ORDER_OPTIONS.map((opt) => (
                              <label key={opt.key} className="flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200 cursor-pointer">
                                <input
                                  type="radio"
                                  name="crawl-order"
                                  value={opt.key}
                                  checked={crawlOrder === opt.key}
                                  onChange={() => setCrawlOrder(opt.key)}
                                  className="accent-primary-600"
                                />
                                {opt.label}
                              </label>
                            ))}
                          </div>
                          <p className="text-xs text-amber-800/80 dark:text-amber-300/80 tabular-nums">
                            {crawlCount.toLocaleString()} pages × {crawlEstimate.cost_per_page} ={' '}
                            {(crawlCount * crawlEstimate.cost_per_page).toLocaleString()} credits
                          </p>
                        </>
                      ) : (
                        <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                          You need credits to crawl this site. Top up to continue.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-2 mt-3">
                    {crawlEstimate?.exceeds_balance && (crawlEstimate.max_affordable_pages ?? 0) === 0 ? (
                      <button
                        type="button"
                        onClick={() => window.location.assign('/billing')}
                        className="flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white transition-colors"
                      >
                        Top up credits
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleConfirmCrawl}
                        className="flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white transition-colors"
                      >
                        <Globe size={13} />
                        {crawlEstimate?.exceeds_balance
                          ? `Crawl ${crawlCount.toLocaleString()} page${crawlCount === 1 ? '' : 's'}`
                          : discoveredTotal > 0
                            ? `Crawl ${discoveredTotal.toLocaleString()} page${discoveredTotal === 1 ? '' : 's'}`
                            : 'Yes, crawl it'}
                      </button>
                    )}
                    {crawlEstimate?.exceeds_balance && (crawlEstimate.max_affordable_pages ?? 0) > 0 && (
                      <button
                        type="button"
                        onClick={() => window.location.assign('/billing')}
                        className="text-sm font-medium px-4 py-2 rounded-lg bg-white/60 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 text-primary-800 dark:text-primary-200 border border-primary-200 dark:border-primary-500/20 transition-colors"
                      >
                        Top up
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowCrawlConfirm(false)}
                      className="text-sm font-medium px-4 py-2 rounded-lg bg-white/60 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 text-primary-800 dark:text-primary-200 border border-primary-200 dark:border-primary-500/20 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {isThisBotCrawl && (isCrawling || scanningUrls.length > 0) && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="border border-surface-200 dark:border-surface-800 rounded-xl overflow-hidden"
                >
                  <div className="px-4 py-3 bg-surface-50 dark:bg-surface-800 border-b border-surface-200 dark:border-surface-700 flex items-center gap-2">
                    <Globe size={14} className={isCrawling ? 'text-primary-500 animate-pulse' : 'text-emerald-500'} />
                    <span className="text-xs font-semibold text-surface-700 dark:text-surface-300">
                      {isEmbedding ? 'Embedding content…' : isCrawling ? 'Crawling website…' : 'Pages discovered'}
                    </span>
                    <span className={cn('text-[10px] ml-auto font-medium tabular-nums', isCrawling ? 'text-primary-500 animate-pulse' : 'text-emerald-500')}>
                      {isEmbedding
                        ? (crawl.phase ?? `${scanningUrls.length} pages`)
                        : isCrawling
                        ? (() => {
                            const denominator = crawl.discoveredTotal || crawl.maxPages;
                            return denominator
                              ? `${scanningUrls.length}/${denominator} pages`
                              : scanningUrls.length > 0 ? `${scanningUrls.length} pages` : 'in progress';
                          })()
                        : `${scanningUrls.filter(u => u.status === 'done').length} pages`}
                    </span>
                  </div>
                  <div className="max-h-96 overflow-y-auto divide-y divide-surface-100 dark:divide-surface-800">
                    {scanningUrls.length === 0 && isCrawling ? (
                      // First-paint state: we're crawling but no URLs have
                      // streamed yet (robots.txt + sitemap fetch is happening).
                      // Show a skeleton row so the user knows the panel is
                      // alive and waiting — not broken.
                      <div className="flex items-center gap-3 px-4 py-3">
                        <Loader2 size={13} className="text-primary-500 animate-spin shrink-0" />
                        <span className="text-xs text-surface-500 dark:text-surface-400 italic">
                          Discovering URLs…
                        </span>
                      </div>
                    ) : (
                      scanningUrls.map((item, i) => (
                        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                          {item.status === 'scanning' ? (
                            <Loader2 size={13} className="text-primary-500 animate-spin shrink-0" />
                          ) : (
                            <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                          )}
                          <ExternalLink size={11} className="text-surface-400 shrink-0" />
                          <span className={cn('text-xs font-mono truncate', item.status === 'scanning' ? 'text-primary-600 dark:text-primary-400' : 'text-surface-600 dark:text-surface-400')}>
                            {item.url}
                          </span>
                          {item.status === 'scanning' && (
                            <span className="ml-auto text-[9px] font-bold uppercase tracking-wider text-primary-500 animate-pulse shrink-0">Crawling…</span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {renderStatus(crawlStatus)}
            {!isCrawling && scanningUrls.length === 0 && (
              <div className="p-4 bg-primary-50 dark:bg-primary-500/10 border border-primary-200 dark:border-primary-500/20 rounded-xl text-primary-700 dark:text-primary-300 text-sm">
                <p className="font-semibold mb-1">How crawling works:</p>
                <ul className="list-disc pl-5 space-y-1 text-primary-600/80 dark:text-primary-400/80 text-xs">
                  <li>We fetch the main page and follow internal links</li>
                  <li>Content is stripped of HTML and chunked for AI ingestion</li>
                  <li>Next.js / React / SPA sites are auto-detected and crawled with JavaScript mode</li>
                  <li>Enable <strong>JavaScript Mode</strong> manually if pages are missing</li>
                </ul>
              </div>
            )}

            {/* AUTO-RECRAWL — weekly refresh of crawled URLs (Standard/Enterprise) */}
            {selectedBot?.id && <AutoRecrawlCard botId={selectedBot.id} />}
          </div>
        )}

        {/* DOCUMENT LIST */}
        {activeTab === 'list' && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-surface-900 dark:text-white">All Sources</h2>
                <p className="text-sm text-surface-500 mt-0.5">Files and websites your chatbot is trained on</p>
              </div>
              <button onClick={fetchDocuments} className="text-sm text-primary-600 dark:text-primary-400 hover:underline font-medium">Refresh</button>
            </div>

            {isLoadingDocs ? (
              <SkeletonTable rows={4} cols={6} />
            ) : documents.length === 0 ? (
              <div className="text-center py-12 border-2 border-dashed border-surface-200 dark:border-surface-800 rounded-xl">
                <FileText className="mx-auto text-surface-600 dark:text-surface-300 mb-3" size={28} />
                <p className="text-surface-500 font-medium text-sm">No documents ingested yet</p>
                <p className="text-xs text-surface-400 mt-1">Upload documents or crawl a website</p>
                {localStorage.getItem('company_website') && (
                  <button
                    onClick={() => setActiveTab('urls')}
                    className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-primary-50 dark:bg-primary-500/10 hover:bg-primary-100 dark:hover:bg-primary-500/20 text-primary-700 dark:text-primary-400 rounded-lg text-sm font-medium transition-colors"
                  >
                    <Globe size={14} />
                    Scan {localStorage.getItem('company_website')}
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto border border-surface-200 dark:border-surface-800 rounded-xl">
                <table className="w-full min-w-[720px] text-left table-fixed">
                  <colgroup>
                    <col className="w-[38%]" />
                    <col className="w-[12%]" />
                    <col className="w-[13%]" />
                    <col className="w-[12%]" />
                    <col className="w-[13%]" />
                    <col className="w-[12%]" />
                  </colgroup>
                  <thead className="bg-surface-50 dark:bg-surface-800/50 border-b border-surface-200 dark:border-surface-800">
                    <tr>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">Source</th>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">Type</th>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">Pages</th>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">Time</th>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">Date</th>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-100 dark:divide-surface-800">
                    {documents.map((doc, idx) => {
                      const isUrl = doc.name.startsWith('http://') || doc.name.startsWith('https://');
                      const Icon = isUrl ? LinkIcon : FileText;
                      const dateStr = doc.ingested_at ? new Date(doc.ingested_at).toLocaleDateString() : 'Unknown';
                      // History expander is a Website-only, Standard/Enterprise-only affordance.
                      // Free / Starter customers never see the chevron so the sources table
                      // stays visually identical to their existing experience.
                      const showHistoryChevron = isUrl && autoRecrawlAvailable;
                      const isHistoryOpen = showHistoryChevron && expandedSource === doc.name;
                      return (
                        <Fragment key={idx}>
                        <tr className="hover:bg-surface-50 dark:hover:bg-surface-800/30 transition-colors">
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-3">
                              <div className={cn('p-1.5 rounded-lg shrink-0', isUrl ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-500' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-500')}>
                                <Icon size={14} />
                              </div>
                              {isUrl ? (
                                <button
                                  type="button"
                                  onClick={() => setDrawerSource(doc.name)}
                                  className="text-sm font-medium text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 hover:underline truncate max-w-[280px] text-left cursor-pointer transition-colors duration-150"
                                >
                                  {doc.name}
                                </button>
                              ) : (
                                <span className="text-sm font-medium text-surface-900 dark:text-white truncate max-w-[280px]">{doc.name}</span>
                              )}
                              {/* Recrawl-history chevron — Website + Standard/Enterprise only.
                                  Renders to the right of the URL text. Free / Starter customers
                                  simply don't see it, so the row stays visually clean. */}
                              {showHistoryChevron && (
                                <button
                                  type="button"
                                  onClick={() => toggleSourceHistory(doc.name)}
                                  className="p-0.5 rounded text-surface-400 hover:text-primary-500 hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors shrink-0"
                                  aria-expanded={isHistoryOpen}
                                  aria-label={isHistoryOpen ? 'Hide recrawl history' : 'Show recrawl history'}
                                >
                                  {isHistoryOpen
                                    ? <ChevronDown size={14} />
                                    : <ChevronRight size={14} />}
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <span className={cn(
                              'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold',
                              isUrl ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400' : 'bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-400'
                            )}>
                              {isUrl ? 'Website' : 'Document'}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-sm text-surface-500 dark:text-surface-400">
                            {isUrl
                              ? `${(doc.page_count ?? 0).toLocaleString()} ${doc.page_count === 1 ? 'page' : 'pages'}`
                              : doc.doc_page_count != null
                                ? `${doc.doc_page_count.toLocaleString()} ${doc.doc_page_count === 1 ? 'page' : 'pages'}`
                                : `${(doc.chunk_count ?? 0).toLocaleString()} ${doc.chunk_count === 1 ? 'chunk' : 'chunks'}`}
                          </td>
                          <td className="px-5 py-3.5 text-sm text-surface-400 tabular-nums">
                            {formatDuration(doc.duration_seconds)}
                          </td>
                          <td className="px-5 py-3.5 text-sm text-surface-400">{dateStr}</td>
                          <td className="px-5 py-3.5 text-right">
                            {confirmingDelete === doc.name ? (
                              <div className="flex items-center justify-end gap-1.5">
                                <span className="text-[10px] text-surface-400">Sure?</span>
                                <button onClick={() => handleDelete(doc.name)} disabled={deletingDoc === doc.name} className="p-1.5 rounded-lg bg-rose-500 text-white hover:bg-rose-600 transition-colors">
                                  {deletingDoc === doc.name ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                                </button>
                                <button onClick={() => setConfirmingDelete(null)} className="p-1.5 rounded-lg bg-surface-100 dark:bg-surface-800 text-surface-500 transition-colors"><X size={12} /></button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-end gap-1">
                                {isUrl && (
                                  <div className="relative group">
                                    <button
                                      type="button"
                                      onClick={() => setDrawerSource(doc.name)}
                                      className="p-1.5 rounded-lg text-surface-400 hover:text-primary-500 hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors"
                                      aria-label={`View pages scanned for ${doc.name}`}
                                    >
                                      <Eye size={14} />
                                    </button>
                                    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 rounded text-[10px] font-medium bg-surface-900 dark:bg-surface-700 text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10">
                                      View scanned pages
                                    </span>
                                  </div>
                                )}
                                {isUrl && (
                                  <RecrawlMenu
                                    planSlug={entitlements.planSlug}
                                    loading={recrawlingDoc === doc.name || recrawlDiffLoading === doc.name}
                                    onFullRecrawl={() => handleRequestFullRecrawl(doc.name)}
                                    onDeltaRecrawl={() => handleRequestDeltaRecrawl(doc.name)}
                                    onUpgradeClick={handleUpgradeForDelta}
                                  />
                                )}
                                <div className="relative group">
                                  <button
                                    onClick={() => setConfirmingDelete(doc.name)}
                                    disabled={recrawlingDoc === doc.name}
                                    className="p-1.5 rounded-lg text-surface-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 rounded text-[10px] font-medium bg-surface-900 dark:bg-surface-700 text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10">
                                    Delete
                                  </span>
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                        {isHistoryOpen && (
                          <tr className="bg-surface-50/70 dark:bg-surface-900/50 border-t border-surface-100 dark:border-surface-800">
                            <td colSpan={6} className="px-5 py-3">
                              {historyLoading ? (
                                <div className="flex items-center gap-2 text-xs text-surface-500">
                                  <Loader2 size={12} className="animate-spin" />
                                  Loading recrawl history…
                                </div>
                              ) : recrawlHistory.length === 0 ? (
                                <div className="text-xs text-surface-500">
                                  No recrawl history yet. The first auto-run will appear here after it completes.
                                </div>
                              ) : (
                                <div className="space-y-1.5">
                                  <div className="text-[10px] uppercase tracking-wide text-surface-400 font-semibold mb-1.5">
                                    Auto-recrawl history
                                  </div>
                                  {recrawlHistory.map((entry, i) => (
                                    <div
                                      key={i}
                                      className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-surface-600 dark:text-surface-300 tabular-nums"
                                    >
                                      <span className="text-surface-500 min-w-[110px]">
                                        {entry.ran_at
                                          ? new Date(entry.ran_at).toLocaleDateString(undefined, {
                                              month: 'short',
                                              day: 'numeric',
                                              year: 'numeric',
                                            })
                                          : '—'}
                                      </span>
                                      <span>
                                        <span className="text-surface-400">unchanged</span>{' '}
                                        <span className="font-medium text-surface-700 dark:text-surface-200">{entry.unchanged ?? 0}</span>
                                      </span>
                                      <span>
                                        <span className="text-surface-400">added</span>{' '}
                                        <span className="font-medium text-primary-600 dark:text-primary-400">{entry.changed ?? 0}</span>
                                      </span>
                                      <span>
                                        <span className="text-surface-400">removed</span>{' '}
                                        <span className={cn(
                                          'font-medium',
                                          (entry.failed ?? 0) > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-surface-500'
                                        )}>{entry.failed ?? 0}</span>
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <SourcePagesDrawer
        sourceUrl={drawerSource}
        botId={selectedBot?.id}
        onClose={() => setDrawerSource(null)}
      />
    </div>
  );
}
