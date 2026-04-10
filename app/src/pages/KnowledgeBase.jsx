import { useState, useRef, useEffect } from 'react';
import { UploadCloud, Link as LinkIcon, FileText, X, CheckCircle2, AlertCircle, Loader2, List as ListIcon, Trash2, Check, RefreshCw, Globe, ExternalLink, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { uploadDocuments, crawlWebsite, getCrawlProgress, getDocuments, deleteDocument } from '../services/api';
import SourcePagesDrawer from '../components/SourcePagesDrawer';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import PageHeader from '../components/ui/PageHeader';
import Tabs from '../components/ui/Tabs';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonTable } from '../components/ui/SkeletonLoader';
import { cn } from '../lib/utils';

export default function KnowledgeBase() {
  const { selectedBot, bots, loading: botsLoading } = useBotContext();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState('list');

  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const fileInputRef = useRef(null);

  const [url, setUrl] = useState(localStorage.getItem('company_website') || '');
  const [useJs, setUseJs] = useState(false);
  const [isCrawling, setIsCrawling] = useState(false);
  const [crawlStatus, setCrawlStatus] = useState(null);
  const [scanningUrls, setScanningUrls] = useState([]);
  const scanTimerRef = useRef(null);

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

  // Poll real-time crawl progress every 3 s while a crawl is running.
  // Each poll is a trivial file-read on the server — negligible overhead.
  useEffect(() => {
    if (!isCrawling) return;
    const interval = setInterval(async () => {
      const data = await getCrawlProgress();
      if (data.urls && data.urls.length > 0) {
        setScanningUrls(data.urls.map(u => ({ url: u, status: 'scanning' })));
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [isCrawling]);

  if (!botsLoading && bots.length === 0) {
    return <EmptyState title="Sources" description="Create a chatbot first, then upload documents and URLs to build its knowledge base." actionLabel="Create Chatbot" actionTo="/chatbot" />;
  }

  const supportedExtensions = ['.pdf', '.docx', '.txt', '.md'];
  const supportedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown'];

  const filterFiles = (fileList) => Array.from(fileList).filter(file => {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    return supportedTypes.includes(file.type) || supportedExtensions.includes(ext);
  });

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
      if (activeTab === 'list') fetchDocuments();
    } catch (error) {
      setUploadStatus({ type: 'error', message: error.detail || error.message || 'Failed to upload documents.' });
    } finally { setIsUploading(false); }
  };

  const handleDelete = async (docName) => {
    setDeletingDoc(docName);
    try {
      await deleteDocument(docName, selectedBot?.id);
      setDocuments(prev => prev.filter(d => d.name !== docName));
      showToast('success', 'Document deleted');
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
      setIsCrawling(true);
      startScanSimulation(crawlUrl);

      const result = await crawlWebsite(crawlUrl, selectedBot?.id, false, replaceSource);

      stopScanSimulation(result);
      showToast('success', `Recrawled! ${result.pages_processed || 0} pages updated.`);
      fetchDocuments();
    } catch (err) {
      stopScanSimulation(null);
      showToast('error', `Recrawl failed: ${err?.detail || err?.message || err}`);
    } finally {
      setRecrawlingDoc(null);
      setIsCrawling(false);
    }
  };

  const startScanSimulation = (rootUrl) => {
    setScanningUrls([{ url: rootUrl, status: 'scanning' }]);
  };

  const stopScanSimulation = (result) => {
    if (scanTimerRef.current) clearInterval(scanTimerRef.current);
    if (result && result.pages_crawled && result.pages_crawled.length > 0) {
      setScanningUrls(result.pages_crawled.map(u => ({ url: u, status: 'done' })));
    } else {
      setScanningUrls(prev => prev.map(u => ({ ...u, status: 'done' })));
    }
    // Keep visible for 60 s so users can read all discovered URLs
    setTimeout(() => setScanningUrls([]), 60000);
  };

  const handleCrawlSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setIsCrawling(true); setCrawlStatus(null);
    startScanSimulation(url);
    try {
      const result = await crawlWebsite(url, selectedBot?.id, useJs);
      stopScanSimulation(result);
      setCrawlStatus({ type: 'success', message: `Crawled ${result.pages_processed || 0} pages and ingested ${result.chunks_processed || 0} chunks.` });
      showToast('success', `Crawling done! ${result.pages_processed || 0} pages.`);
      setUrl('');
      if (activeTab === 'list') fetchDocuments();
    } catch (error) {
      stopScanSimulation(null);
      setCrawlStatus({ type: 'error', message: error.detail || error.message || 'Failed to crawl website.' });
    } finally { setIsCrawling(false); }
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
      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

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
              <p className="text-surface-400 text-xs mb-5">PDF, DOCX, TXT, MD (Max 50MB)</p>
              <input type="file" multiple accept=".pdf,.docx,.txt,.md" className="hidden" ref={fileInputRef} onChange={handleFileSelect} />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-5 py-2 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-700 text-sm font-medium transition-all"
                disabled={isUploading}
              >
                Browse Files
              </button>
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
                  <div className="flex justify-end pt-2">
                    <button
                      onClick={handleUploadClick}
                      disabled={isUploading}
                      className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-70 shadow-sm"
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
                    type="url" value={url} onChange={(e) => setUrl(e.target.value)} required
                    placeholder="https://example.com"
                    className={cn(
                      'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white dark:bg-surface-800 text-surface-900 dark:text-white',
                      'border-surface-200 dark:border-surface-700 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400',
                      'outline-none transition-all text-sm placeholder:text-surface-400'
                    )}
                    disabled={isCrawling}
                  />
                </div>
              </div>

              {/* JavaScript mode toggle */}
              <button
                type="button"
                onClick={() => setUseJs(prev => !prev)}
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

              <button
                type="submit"
                disabled={isCrawling || !url}
                className="flex items-center justify-center gap-2 w-full bg-primary-600 hover:bg-primary-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-70 shadow-sm"
              >
                {isCrawling ? <><Loader2 size={16} className="animate-spin" /> Crawling...</> : <><Globe size={16} /> Start Crawl</>}
              </button>
            </form>

            <AnimatePresence>
              {scanningUrls.length > 0 && (
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
                    <span className={cn('text-[10px] ml-auto font-medium', isCrawling ? 'text-primary-500 animate-pulse' : 'text-emerald-500')}>
                      {isCrawling
                        ? 'in progress'
                        : `${scanningUrls.filter(u => u.status === 'done').length} pages`}
                    </span>
                  </div>
                  <div className="max-h-96 overflow-y-auto divide-y divide-surface-100 dark:divide-surface-800">
                    {scanningUrls.map((item, i) => (
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
                    ))}
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
                <table className="w-full text-left">
                  <thead className="bg-surface-50 dark:bg-surface-800/50 border-b border-surface-200 dark:border-surface-800">
                    <tr>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">Source</th>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider">Type</th>
                      <th className="px-5 py-3 text-xs font-semibold text-surface-500 uppercase tracking-wider text-right">Date</th>
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
                          <td className="px-5 py-3.5 text-sm text-surface-400 text-right">{dateStr}</td>
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
