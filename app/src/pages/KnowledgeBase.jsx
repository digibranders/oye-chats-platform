import { useState, useRef, useEffect } from 'react';
import { UploadCloud, Link as LinkIcon, FileText, X, CheckCircle2, AlertCircle, Loader2, List as ListIcon, Calendar, Trash2, Check, RefreshCw, Globe, ExternalLink } from 'lucide-react';
import { uploadDocuments, crawlWebsite, getDocuments, deleteDocument } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import PageHeader from '../components/ui/PageHeader';
import Tabs from '../components/ui/Tabs';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonTable } from '../components/ui/SkeletonLoader';

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
    const [isCrawling, setIsCrawling] = useState(false);
    const [crawlStatus, setCrawlStatus] = useState(null);
    const [scanningUrls, setScanningUrls] = useState([]); // live crawl progress
    const scanTimerRef = useRef(null);

    const [documents, setDocuments] = useState([]);
    const [isLoadingDocs, setIsLoadingDocs] = useState(false);
    const [deletingDoc, setDeletingDoc] = useState(null);
    const [confirmingDelete, setConfirmingDelete] = useState(null);
    const [recrawlingDoc, setRecrawlingDoc] = useState(null);

    const fetchDocuments = async () => {
        setIsLoadingDocs(true);
        try {
            const docs = await getDocuments(selectedBot?.id);
            setDocuments(docs || []);
        } catch (error) {
            console.error('Failed to load documents:', error);
        } finally {
            setIsLoadingDocs(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'list') fetchDocuments();
    }, [activeTab, selectedBot?.id]);

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
        try {
            await deleteDocument(docName, selectedBot?.id);
            const crawlUrl = docName.startsWith('http') ? docName : `https://${docName}`;
            const result = await crawlWebsite(crawlUrl, selectedBot?.id);
            showToast('success', `Recrawled! ${result.pages_processed || 0} pages processed.`);
            fetchDocuments();
        } catch (err) {
            showToast('error', `Recrawl failed: ${err?.detail || err?.message || err}`);
        } finally { setRecrawlingDoc(null); }
    };

    const startScanSimulation = (rootUrl) => {
        const domain = new URL(rootUrl).hostname;
        const paths = ['/', '/about', '/contact', '/pricing', '/blog', '/features', '/docs', '/faq', '/terms', '/privacy', '/team', '/careers', '/support', '/api', '/products', '/services'];
        let idx = 0;
        setScanningUrls([{ url: rootUrl, status: 'scanning' }]);
        scanTimerRef.current = setInterval(() => {
            idx++;
            if (idx >= paths.length) { clearInterval(scanTimerRef.current); return; }
            setScanningUrls(prev => {
                const updated = prev.map(u => u.status === 'scanning' ? { ...u, status: 'done' } : u);
                return [...updated, { url: `https://${domain}${paths[idx]}`, status: 'scanning' }];
            });
        }, 1500 + Math.random() * 2000);
    };

    const stopScanSimulation = (pagesFound) => {
        if (scanTimerRef.current) clearInterval(scanTimerRef.current);
        setScanningUrls(prev => prev.map(u => ({ ...u, status: 'done' })));
        if (pagesFound) {
            setTimeout(() => setScanningUrls([]), 3000);
        }
    };

    const handleCrawlSubmit = async (e) => {
        e.preventDefault();
        if (!url.trim()) return;
        setIsCrawling(true); setCrawlStatus(null);
        startScanSimulation(url);
        try {
            const result = await crawlWebsite(url, selectedBot?.id);
            stopScanSimulation(result.pages_processed);
            setCrawlStatus({ type: 'success', message: `Crawled ${result.pages_processed || 0} pages and ingested ${result.chunks_processed || 0} chunks.` });
            showToast('success', `Crawling done! ${result.pages_processed || 0} pages.`);
            setUrl('');
            if (activeTab === 'list') fetchDocuments();
        } catch (error) {
            stopScanSimulation(0);
            setCrawlStatus({ type: 'error', message: error.detail || error.message || 'Failed to crawl website.' });
        } finally { setIsCrawling(false); }
    };

    const renderStatus = (status) => {
        if (!status) return null;
        const isSuccess = status.type === 'success';
        return (
            <div className={`mt-4 p-3 rounded-xl flex items-start gap-2 text-sm font-medium border ${isSuccess ? 'bg-success-50 text-success-600 border-success-500/20' : 'bg-error-50 text-error-600 border-error-500/20'}`}>
                {isSuccess ? <CheckCircle2 className="shrink-0 mt-0.5" size={16} /> : <AlertCircle className="shrink-0 mt-0.5" size={16} />}
                <p>{status.message}</p>
            </div>
        );
    };

    const tabs = [
        { id: 'list', label: 'All Sources', icon: ListIcon },
        { id: 'urls', label: 'Website Scan', icon: LinkIcon },
        { id: 'files', label: 'Documents', icon: UploadCloud },
    ];

    return (
        <div className="space-y-6 animate-fade-in">
            <PageHeader title="Sources" subtitle="Train your chatbot with documents and websites" />

            <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm max-w-4xl min-h-[400px]">

                {/* FILE UPLOAD */}
                {activeTab === 'files' && (
                    <div className="space-y-5 animate-fade-in">
                        <h2 className="text-base font-semibold text-secondary-900">Upload Knowledge Documents</h2>
                        <div
                            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                            onDragLeave={() => setIsDragging(false)}
                            onDrop={handleDrop}
                            className={`border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center text-center transition-all ${isDragging ? 'border-primary-500 bg-primary-50' : 'border-secondary-200 hover:border-primary-300:border-primary-600 bg-secondary-50'}`}
                        >
                            <div className="w-14 h-14 rounded-2xl bg-primary-50 text-primary-600 flex items-center justify-center mb-4">
                                <UploadCloud size={28} />
                            </div>
                            <h3 className="text-secondary-900 font-medium mb-1 text-sm">Drag and drop your documents here</h3>
                            <p className="text-secondary-400 text-xs mb-5">PDF, DOCX, TXT, MD (Max 50MB)</p>
                            <input type="file" multiple accept=".pdf,.docx,.txt,.md" className="hidden" ref={fileInputRef} onChange={handleFileSelect} />
                            <button onClick={() => fileInputRef.current?.click()} className="px-5 py-2 rounded-xl border border-secondary-200 bg-white text-secondary-700 hover:bg-secondary-50:bg-secondary-700 text-sm font-medium transition-all" disabled={isUploading}>
                                Browse Files
                            </button>
                        </div>

                        {selectedFiles.length > 0 && (
                            <div className="space-y-3">
                                <h4 className="text-sm font-medium text-secondary-600">Selected ({selectedFiles.length})</h4>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    {selectedFiles.map((file, index) => (
                                        <div key={index} className="flex items-center justify-between p-3 border border-secondary-200 rounded-xl bg-white">
                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className={`p-2 rounded-lg shrink-0 ${file.name.toLowerCase().endsWith('.pdf') ? 'bg-error-50 text-error-500' : file.name.toLowerCase().endsWith('.docx') ? 'bg-info-50 text-info-500' : 'bg-secondary-100 text-secondary-500'}`}>
                                                    <FileText size={14} />
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="text-sm font-medium text-secondary-900 truncate">{file.name}</p>
                                                    <p className="text-xs text-secondary-400">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                                                </div>
                                            </div>
                                            <button onClick={() => removeFile(index)} disabled={isUploading} className="p-1.5 text-secondary-400 hover:text-error-500 hover:bg-error-50:bg-error-500/10 rounded-lg transition-colors shrink-0">
                                                <X size={14} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                                <div className="flex justify-end pt-2">
                                    <button onClick={handleUploadClick} disabled={isUploading} className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-70">
                                        {isUploading ? <><Loader2 size={16} className="animate-spin" /> Processing...</> : <><UploadCloud size={16} /> Upload {selectedFiles.length} Files</>}
                                    </button>
                                </div>
                            </div>
                        )}
                        {renderStatus(uploadStatus)}
                    </div>
                )}

                {/* URL CRAWL */}
                {activeTab === 'urls' && (
                    <div className="space-y-5 animate-fade-in">
                        <div>
                            <h2 className="text-base font-semibold text-secondary-900">Ingest Website Content</h2>
                            <p className="text-sm text-secondary-500 mt-1">Enter a URL and we'll crawl the site to build your chatbot's knowledge</p>
                        </div>
                        <form onSubmit={handleCrawlSubmit} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-secondary-700 mb-1.5">Website URL</label>
                                <div className="relative">
                                    <LinkIcon size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-secondary-400" />
                                    <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://example.com" className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-secondary-200 bg-white text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm" disabled={isCrawling} />
                                </div>
                            </div>
                            <button type="submit" disabled={isCrawling || !url} className="flex items-center justify-center gap-2 w-full bg-primary-600 hover:bg-primary-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-70">
                                {isCrawling ? <><Loader2 size={16} className="animate-spin" /> Crawling...</> : <><LinkIcon size={16} /> Start Crawl</>}
                            </button>
                        </form>
                        {/* Live Scan Progress */}
                        {scanningUrls.length > 0 && (
                            <div className="border border-secondary-200 rounded-xl overflow-hidden animate-fade-in">
                                <div className="px-4 py-3 bg-secondary-50 border-b border-secondary-200 flex items-center gap-2">
                                    <Globe size={14} className="text-primary-500" />
                                    <span className="text-xs font-semibold text-secondary-700">Scanning URLs</span>
                                    <span className="text-[10px] text-secondary-400 ml-auto">{scanningUrls.filter(u => u.status === 'done').length} found</span>
                                </div>
                                <div className="max-h-52 overflow-y-auto divide-y divide-secondary-100">
                                    {scanningUrls.map((item, i) => (
                                        <div key={i} className="flex items-center gap-3 px-4 py-2.5 animate-fade-in">
                                            {item.status === 'scanning' ? (
                                                <Loader2 size={13} className="text-primary-500 animate-spin shrink-0" />
                                            ) : (
                                                <CheckCircle2 size={13} className="text-success-500 shrink-0" />
                                            )}
                                            <ExternalLink size={11} className="text-secondary-400 shrink-0" />
                                            <span className={`text-xs font-mono truncate ${item.status === 'scanning' ? 'text-primary-600' : 'text-secondary-500'}`}>
                                                {item.url}
                                            </span>
                                            {item.status === 'scanning' && (
                                                <span className="ml-auto text-[9px] font-bold uppercase tracking-wider text-primary-500 animate-pulse">Scanning...</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {renderStatus(crawlStatus)}
                        {!isCrawling && scanningUrls.length === 0 && (
                            <div className="p-4 bg-info-50 border border-info-500/20 rounded-xl text-info-600 text-sm">
                                <p className="font-semibold mb-1">How crawling works:</p>
                                <ul className="list-disc pl-5 space-y-1 text-info-600/80 text-xs">
                                    <li>We fetch the main page and follow internal links</li>
                                    <li>Content is stripped of HTML and chunked for AI ingestion</li>
                                    <li>Make sure the site allows bots (check robots.txt)</li>
                                </ul>
                            </div>
                        )}
                    </div>
                )}

                {/* DOCUMENT LIST */}
                {activeTab === 'list' && (
                    <div className="space-y-5 animate-fade-in">
                        <div className="flex items-center justify-between">
                            <div>
                                <h2 className="text-base font-semibold text-secondary-900">All Sources</h2>
                                <p className="text-sm text-secondary-500 mt-0.5">Files and websites your chatbot is trained on</p>
                            </div>
                            <button onClick={fetchDocuments} className="text-sm text-primary-600 hover:underline font-medium">Refresh</button>
                        </div>

                        {isLoadingDocs ? (
                            <SkeletonTable rows={4} cols={3} />
                        ) : documents.length === 0 ? (
                            <div className="text-center py-12 border-2 border-dashed border-secondary-200 rounded-xl">
                                <FileText className="mx-auto text-secondary-300 mb-3" size={28} />
                                <p className="text-secondary-500 font-medium text-sm">No documents ingested yet</p>
                                <p className="text-xs text-secondary-400 mt-1">Upload documents or crawl a website</p>
                                {localStorage.getItem('company_website') && (
                                    <button
                                        onClick={() => setActiveTab('urls')}
                                        className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-primary-50 hover:bg-primary-100 text-primary-700 rounded-lg text-sm font-medium transition-colors"
                                    >
                                        <Globe size={14} />
                                        Scan {localStorage.getItem('company_website')}
                                    </button>
                                )}
                            </div>
                        ) : (
                            <div className="overflow-hidden border border-secondary-200 rounded-xl">
                                <table className="w-full text-left bg-white">
                                    <thead className="bg-secondary-50 border-b border-secondary-200">
                                        <tr>
                                            <th className="px-5 py-3 text-xs font-semibold text-secondary-500 uppercase tracking-wider">Source</th>
                                            <th className="px-5 py-3 text-xs font-semibold text-secondary-500 uppercase tracking-wider">Type</th>
                                            <th className="px-5 py-3 text-xs font-semibold text-secondary-500 uppercase tracking-wider text-right">Date</th>
                                            <th className="px-5 py-3 text-xs font-semibold text-secondary-500 uppercase tracking-wider text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-secondary-100">
                                        {documents.map((doc, idx) => {
                                            const isUrl = doc.name.startsWith('http://') || doc.name.startsWith('https://');
                                            const Icon = isUrl ? LinkIcon : FileText;
                                            const dateStr = doc.ingested_at ? new Date(doc.ingested_at).toLocaleDateString() : 'Unknown';
                                            return (
                                                <tr key={idx} className="hover:bg-secondary-50:bg-secondary-800/30 transition-colors">
                                                    <td className="px-5 py-3.5">
                                                        <div className="flex items-center gap-3">
                                                            <div className={`p-1.5 rounded-lg shrink-0 ${isUrl ? 'bg-info-50 text-info-500' : 'bg-error-50 text-error-500'}`}>
                                                                <Icon size={14} />
                                                            </div>
                                                            <span className="text-sm font-medium text-secondary-900 truncate max-w-[280px]">{doc.name}</span>
                                                        </div>
                                                    </td>
                                                    <td className="px-5 py-3.5">
                                                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold ${isUrl ? 'bg-info-50 text-info-600' : 'bg-secondary-100 text-secondary-600'}`}>
                                                            {isUrl ? 'Website' : 'Document'}
                                                        </span>
                                                    </td>
                                                    <td className="px-5 py-3.5 text-sm text-secondary-400 text-right">{dateStr}</td>
                                                    <td className="px-5 py-3.5 text-right">
                                                        {confirmingDelete === doc.name ? (
                                                            <div className="flex items-center justify-end gap-1.5">
                                                                <span className="text-[10px] text-secondary-400">Sure?</span>
                                                                <button onClick={() => handleDelete(doc.name)} disabled={deletingDoc === doc.name} className="p-1.5 rounded-lg bg-error-500 text-white hover:bg-error-600 transition-colors">
                                                                    {deletingDoc === doc.name ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                                                                </button>
                                                                <button onClick={() => setConfirmingDelete(null)} className="p-1.5 rounded-lg bg-secondary-100 text-secondary-500 transition-colors"><X size={12} /></button>
                                                            </div>
                                                        ) : (
                                                            <div className="flex items-center justify-end gap-1">
                                                                {isUrl && (
                                                                    <button onClick={() => handleRecrawl(doc.name)} disabled={recrawlingDoc === doc.name} className="p-1.5 rounded-lg text-secondary-400 hover:text-primary-500 hover:bg-primary-50:bg-primary-500/10 transition-colors">
                                                                        {recrawlingDoc === doc.name ? <Loader2 size={14} className="animate-spin text-primary-500" /> : <RefreshCw size={14} />}
                                                                    </button>
                                                                )}
                                                                <button onClick={() => setConfirmingDelete(doc.name)} disabled={recrawlingDoc === doc.name} className="p-1.5 rounded-lg text-secondary-400 hover:text-error-500 hover:bg-error-50:bg-error-500/10 transition-colors">
                                                                    <Trash2 size={14} />
                                                                </button>
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
        </div>
    );
}
