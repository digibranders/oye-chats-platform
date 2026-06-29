import { useState, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { UploadCloud, Link as LinkIcon, FileText, X, CheckCircle2, AlertCircle, Loader2, List as ListIcon, Trash2, Check, RefreshCw, Globe, ExternalLink, Zap, StopCircle, Eye, ChevronsUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { uploadDocuments, getDocuments, deleteDocument, getCurrentSubscription, discoverCrawlUrls } from '../services/api';
import SourcePagesDrawer from '../components/SourcePagesDrawer';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { useCrawl } from '../context/CrawlContext';
import useEntitlements from '../hooks/useEntitlements';
import PageHeader from '../components/ui/PageHeader';
import Tabs from '../components/ui/Tabs';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonTable } from '../components/ui/SkeletonLoader';
import { cn } from '../lib/utils';

// Whitelist of tab IDs that can be requested via the ?tab= query param.
// Anything else falls back to the default. Prevents deep-link spoofing /
// invalid query values from breaking the tab UI.
const VALID_TABS = new Set(['list', 'urls', 'files']);

export default function KnowledgeBase() {
  const { selectedBot, bots, loading: botsLoading } = useBotContext();
  const { showToast } = useToast();
  const { crawl, startCrawl, cancelCrawl, isActive: isCrawlActive } = useCrawl();
  const { entitlements, refresh: refreshEntitlements } = useEntitlements();
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

  // Dismiss the confirmation banner whenever the URL or JS-mode changes
  const resetDiscovery = () => { setDiscoveredTotal(null); setShowCrawlConfirm(false); };

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
          maxPages: limits.max_crawl_pages ?? 100,
          maxDepth: limits.max_crawl_depth ?? 3,
          jsMaxPages: limits.max_crawl_js_pages ?? 25,
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
  const scanningUrls = (crawl.urls || []).map((u, i, arr) => ({
    url: u,
    // The most-recently-discovered URL is the one actively being crawled;
    // everything before it has been pulled successfully.
    status: isCrawlActive && i === arr.length - 1 ? 'scanning' : 'done',
  }));
  const crawlStatus = (() => {
    if (crawl.status === 'done') {
      return {
        type: 'success',
        message: `Crawled ${crawl.result?.pages_processed ?? crawl.urls.length} pages and ingested ${crawl.result?.chunks_processed ?? 0} chunks.`,
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
  const [confirmingRecrawl, setConfirmingRecrawl] = useState(null);
  const [recrawlingDoc, setRecrawlingDoc] = useState(null);
  const [drawerSource, setDrawerSource] = useState(null);

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

  const handleRecrawl = async (docName) => {
    setRecrawlingDoc(docName);
    const crawlUrl = docName.startsWith('http') ? docName : `https://${docName}`;
    // Normalize to root domain so the backend knows what stale chunks to sweep after success
    const replaceSource = docName.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

    try {
      // Switch to Website Scan tab so the live URL progress panel is visible
      setActiveTab('urls');
      // Delegate to CrawlContext — it owns the lifecycle, the global toast
      // follows the user across routes, and the page just observes state.
      await startCrawl({ url: crawlUrl, botId: selectedBot?.id, botName: selectedBot?.name, useJs: false, replaceSource });
    } catch (err) {
      showToast('error', `Recrawl failed: ${err?.detail || err?.message || err}`);
      setActiveTab('list');
      setRecrawlingDoc(null);
    }
  };

  // Step 1: discover page count, then show confirmation banner
  const handleCrawlSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim() || isDiscovering) return;

    setDiscoveredTotal(null);
    setShowCrawlConfirm(false);
    setIsDiscovering(true);
    try {
      const result = await discoverCrawlUrls(url, selectedBot?.id);
      // Preserve 0 as a meaningful value: "sitemap found but empty / no sitemap"
      // so the dialog can show a helpful note rather than the generic fallback.
      setDiscoveredTotal(typeof result.total_found === 'number' ? result.total_found : null);
    } catch (err) {
      if (err?.status === 429) {
        showToast('error', 'Too many scan requests — please wait a few minutes before scanning again.');
        return; // don't show confirm dialog when rate-limited
      }
      // Other failures (network blip, auth) — still allow crawl without count.
      setDiscoveredTotal(null);
    } finally {
      setIsDiscovering(false);
      setShowCrawlConfirm(true);
    }
  };

  // Step 2: user confirmed — actually start the crawl
  const handleConfirmCrawl = async () => {
    setShowCrawlConfirm(false);
    try {
      await startCrawl({ url, botId: selectedBot?.id, botName: selectedBot?.name, useJs, discoveredTotal });
    } catch (error) {
      const detail = error?.detail;
      if (detail && typeof detail === 'object' && detail.error === 'plan_limit_exceeded') {
        showToast(
          'error',
          `${detail.message || 'Plan limit reached.'} Open Billing to upgrade.`,
        );
        return;
      }
      showToast('error', error.detail || error.message || 'Failed to start crawl.');
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
    if (ext === 'docx') return 'bg-sky-50 dark:bg-sky-500/10 text-sky-500';
    return 'bg-surface-100 dark:bg-surface-800 text-surface-500';
  };

  const tabs = [
    { id: 'list', label: 'All Sources', icon: ListIcon },
    { id: 'urls', label: 'Website Scan', icon: LinkIcon },
    { id: 'files', label: 'Documents', icon: UploadCloud },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Sources" subtitle="Train your chatbot with documents and websites" />
      <Tabs tabs={tabs} activeTab={activeTab} onChange={handleTabChange} />

      <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm max-w-4xl min-h-[400px]">

        {/* FILE UPLOAD */}
        {activeTab === 'files' && (
          <div className="space-y-5">
            <h2 className="text-base font-semibold text-surface-900 dark:text-white">Upload Knowledge Documents</h2>

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
              <h2 className="text-base font-semibold text-surface-900 dark:text-white">Ingest Website Content</h2>
              <p className="text-sm text-surface-500 mt-1">Enter a URL and we&apos;ll crawl the site to build your chatbot&apos;s knowledge</p>
            </div>
            <form onSubmit={handleCrawlSubmit} className="space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-surface-700 dark:text-surface-300 mb-1.5">Website URL</label>
                <div className="relative group">
                  <LinkIcon size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                  <input
                    type="url" value={url} onChange={(e) => { setUrl(e.target.value); resetDiscovery(); }} required
                    placeholder="https://example.com"
                    className={cn(
                      'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white dark:bg-surface-800 text-surface-900 dark:text-white',
                      'border-surface-200 dark:border-surface-700 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400',
                      'outline-none transition-all text-sm placeholder:text-surface-400'
                    )}
                    disabled={isCrawling}
                  />
                </div>
                {crawlLimits && (
                  <p className="mt-2 text-xs text-surface-500 dark:text-surface-400">
                    Your <span className="font-medium text-surface-700 dark:text-surface-200">{crawlLimits.planName}</span> plan: up to{' '}
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
                    {crawlLimits.planSlug !== 'enterprise' && (
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
                    ? 'border-violet-400 dark:border-violet-500 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
                    : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:border-surface-300 dark:hover:border-surface-600'
                )}
              >
                <div className={cn(
                  'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                  useJs ? 'bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-300' : 'bg-surface-100 dark:bg-surface-700 text-surface-400'
                )}>
                  <Zap size={15} />
                </div>
                <div className="flex-1 text-left">
                  <p className="font-medium leading-tight">JavaScript Mode</p>
                  <p className="text-xs opacity-70 mt-0.5">Required for Next.js, React &amp; other SPA sites</p>
                </div>
                <div className={cn(
                  'w-10 h-5 rounded-full transition-all relative shrink-0',
                  useJs ? 'bg-violet-500' : 'bg-surface-300 dark:bg-surface-600'
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
                          Found at least <span className="tabular-nums">{discoveredTotal.toLocaleString()}</span> page{discoveredTotal === 1 ? '' : 's'} — crawl may discover more
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
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      type="button"
                      onClick={handleConfirmCrawl}
                      className="flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white transition-colors"
                    >
                      <Globe size={13} />
                      {discoveredTotal > 0
                        ? `Crawl ${discoveredTotal.toLocaleString()} page${discoveredTotal === 1 ? '' : 's'}`
                        : 'Yes, crawl it'}
                    </button>
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
                      {isCrawling ? 'Crawling website…' : 'Pages discovered'}
                    </span>
                    <span className={cn('text-[10px] ml-auto font-medium tabular-nums', isCrawling ? 'text-primary-500 animate-pulse' : 'text-emerald-500')}>
                      {isCrawling
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
              <div className="p-4 bg-sky-50 dark:bg-sky-500/10 border border-sky-200 dark:border-sky-500/20 rounded-xl text-sky-700 dark:text-sky-300 text-sm">
                <p className="font-semibold mb-1">How crawling works:</p>
                <ul className="list-disc pl-5 space-y-1 text-sky-600/80 dark:text-sky-400/80 text-xs">
                  <li>We fetch the main page and follow internal links</li>
                  <li>Content is stripped of HTML and chunked for AI ingestion</li>
                  <li>Next.js / React / SPA sites are auto-detected and crawled with JavaScript mode</li>
                  <li>Enable <strong>JavaScript Mode</strong> manually if pages are missing</li>
                </ul>
              </div>
            )}
          </div>
        )}

        {/* DOCUMENT LIST */}
        {activeTab === 'list' && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-surface-900 dark:text-white">All Sources</h2>
                <p className="text-sm text-surface-500 mt-0.5">Files and websites your chatbot is trained on</p>
              </div>
              <button onClick={fetchDocuments} className="text-sm text-primary-600 dark:text-primary-400 hover:underline font-medium">Refresh</button>
            </div>

            {isLoadingDocs ? (
              <SkeletonTable rows={4} cols={3} />
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
              <div className="overflow-hidden border border-surface-200 dark:border-surface-800 rounded-xl">
                <table className="w-full text-left table-fixed">
                  <colgroup>
                    <col className="w-[50%]" />
                    <col className="w-[15%]" />
                    <col className="w-[15%]" />
                    <col className="w-[20%]" />
                  </colgroup>
                  <thead className="bg-surface-50 dark:bg-surface-800/50 border-b border-surface-200 dark:border-surface-800">
                    <tr>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">Source</th>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">Type</th>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">Date</th>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-100 dark:divide-surface-800">
                    {documents.map((doc, idx) => {
                      const isUrl = doc.name.startsWith('http://') || doc.name.startsWith('https://');
                      const Icon = isUrl ? LinkIcon : FileText;
                      const dateStr = doc.ingested_at ? new Date(doc.ingested_at).toLocaleDateString() : 'Unknown';
                      return (
                        <tr key={idx} className="hover:bg-surface-50 dark:hover:bg-surface-800/30 transition-colors">
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-3">
                              <div className={cn('p-1.5 rounded-lg shrink-0', isUrl ? 'bg-sky-50 dark:bg-sky-500/10 text-sky-500' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-500')}>
                                <Icon size={14} />
                              </div>
                              {isUrl ? (
                                <button
                                  type="button"
                                  onClick={() => setDrawerSource(doc.name)}
                                  className="text-sm font-medium text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 hover:underline truncate max-w-[280px] text-left cursor-pointer transition-colors duration-150"
                                >
                                  {doc.name}
                                </button>
                              ) : (
                                <span className="text-sm font-medium text-surface-900 dark:text-white truncate max-w-[280px]">{doc.name}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <span className={cn(
                              'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold',
                              isUrl ? 'bg-sky-50 dark:bg-sky-500/10 text-sky-600 dark:text-sky-400' : 'bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-400'
                            )}>
                              {isUrl ? 'Website' : 'Document'}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-sm text-surface-400">{dateStr}</td>
                          <td className="px-5 py-3.5 text-right">
                            {confirmingRecrawl === doc.name ? (
                              <div className="flex items-center justify-end gap-1.5">
                                <span className="text-[10px] text-surface-400">Re-crawl?</span>
                                <button
                                  onClick={() => { setConfirmingRecrawl(null); handleRecrawl(doc.name); }}
                                  className="p-1.5 rounded-lg bg-primary-500 text-white hover:bg-primary-600 transition-colors"
                                >
                                  <Check size={12} />
                                </button>
                                <button
                                  onClick={() => setConfirmingRecrawl(null)}
                                  className="p-1.5 rounded-lg bg-surface-100 dark:bg-surface-800 text-surface-500 transition-colors"
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ) : confirmingDelete === doc.name ? (
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
                                      className="p-1.5 rounded-lg text-surface-400 hover:text-sky-500 hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors"
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
                                  <div className="relative group">
                                    <button
                                      onClick={() => setConfirmingRecrawl(doc.name)}
                                      disabled={recrawlingDoc === doc.name}
                                      className="p-1.5 rounded-lg text-surface-400 hover:text-primary-500 hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors"
                                    >
                                      {recrawlingDoc === doc.name
                                        ? <Loader2 size={14} className="animate-spin text-primary-500" />
                                        : <RefreshCw size={14} />}
                                    </button>
                                    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 rounded text-[10px] font-medium bg-surface-900 dark:bg-surface-700 text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10">
                                      Re-crawl
                                    </span>
                                  </div>
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
