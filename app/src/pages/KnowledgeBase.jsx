import { useState, useRef, useEffect } from 'react';
import { UploadCloud, Link as LinkIcon, FileText, X, CheckCircle2, AlertCircle, Loader2, List as ListIcon, Calendar, Trash2, Check, RefreshCw } from 'lucide-react';
import { uploadDocuments, crawlWebsite, getDocuments, deleteDocument } from '../services/api';
import { useBotContext } from '../context/BotContext';
import NoBotState from '../components/NoBotState';

export default function KnowledgeBase() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const [activeTab, setActiveTab] = useState('files');

    // File Upload State
    const [isDragging, setIsDragging] = useState(false);
    const [selectedFiles, setSelectedFiles] = useState([]);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState(null); // { type: 'success' | 'error', message: string }
    const fileInputRef = useRef(null);

    // URL Crawl State
    const [url, setUrl] = useState('');
    const [isCrawling, setIsCrawling] = useState(false);
    const [crawlStatus, setCrawlStatus] = useState(null); // { type: 'success' | 'error', message: string }

    // Document List State
    const [documents, setDocuments] = useState([]);
    const [isLoadingDocs, setIsLoadingDocs] = useState(false);
    const [deletingDoc, setDeletingDoc] = useState(null);     // name currently being deleted
    const [confirmingDelete, setConfirmingDelete] = useState(null); // name awaiting confirmation
    const [recrawlingDoc, setRecrawlingDoc] = useState(null); // name currently being recrawled

    // Toast notification state
    const [toast, setToast] = useState(null); // { type: 'success' | 'error', message: string }
    const toastTimer = useRef(null);

    const showToast = (type, message) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast({ type, message });
        toastTimer.current = setTimeout(() => setToast(null), 4000);
    };

    useEffect(() => {
        return () => { if (toastTimer.current) clearTimeout(toastTimer.current); };
    }, []);

    const fetchDocuments = async () => {
        setIsLoadingDocs(true);
        try {
            const docs = await getDocuments(selectedBot?.id);
            setDocuments(docs || []);
        } catch (error) {
            console.error("Failed to load documents:", error);
        } finally {
            setIsLoadingDocs(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'list') {
            fetchDocuments();
        }
    }, [activeTab, selectedBot?.id]);

    if (!botsLoading && bots.length === 0) {
        return <NoBotState title="Knowledge Base" subtitle="Create a chatbot first, then upload documents and URLs to build its knowledge base." />;
    }

    // --- File Upload Handlers ---
    const handleDragOver = (e) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = () => {
        setIsDragging(false);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setIsDragging(false);

        // Accept PDF, DOCX, TXT, MD
        const supportedTypes = [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain',
            'text/markdown'
        ];
        const supportedExtensions = ['.pdf', '.docx', '.txt', '.md'];

        const files = Array.from(e.dataTransfer.files).filter(file => {
            const extension = '.' + file.name.split('.').pop().toLowerCase();
            return supportedTypes.includes(file.type) || supportedExtensions.includes(extension);
        });

        if (files.length > 0) {
            setSelectedFiles(prev => [...prev, ...files]);
        }
    };

    const handleFileSelect = (e) => {
        if (e.target.files) {
            const supportedTypes = [
                'application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'text/plain',
                'text/markdown'
            ];
            const supportedExtensions = ['.pdf', '.docx', '.txt', '.md'];

            const files = Array.from(e.target.files).filter(file => {
                const extension = '.' + file.name.split('.').pop().toLowerCase();
                return supportedTypes.includes(file.type) || supportedExtensions.includes(extension);
            });
            setSelectedFiles(prev => [...prev, ...files]);
        }
    };

    const removeFile = (index) => {
        setSelectedFiles(prev => prev.filter((_, i) => i !== index));
    };

    const handleUploadClick = async () => {
        if (selectedFiles.length === 0) return;

        setIsUploading(true);
        setUploadStatus(null);

        try {
            const result = await uploadDocuments(selectedFiles, selectedBot?.id);
            setUploadStatus({
                type: 'success',
                message: `Successfully processed ${result.documents_processed_count || result.files_uploaded?.length} document chunks.`
            });
            setSelectedFiles([]); // Clear success
            if (activeTab === 'list') fetchDocuments(); // refresh if user switches back rapidly

        } catch (error) {
            setUploadStatus({
                type: 'error',
                message: error.detail || error.message || 'Failed to upload documents.'
            });
        } finally {
            setIsUploading(false);
        }
    };

    // --- Delete Handler ---
    const handleDelete = async (docName) => {
        setDeletingDoc(docName);
        try {
            await deleteDocument(docName, selectedBot?.id);
            setDocuments(prev => prev.filter(d => d.name !== docName));
            showToast('success', 'Successfully deleted!');
        } catch (err) {
            showToast('error', `Failed to delete: ${err?.detail || err}`);
        } finally {
            setDeletingDoc(null);
            setConfirmingDelete(null);
        }
    };

    // --- Recrawl Handler ---
    const handleRecrawl = async (docName) => {
        setRecrawlingDoc(docName);
        try {
            // Step 1: Delete old chunks
            await deleteDocument(docName, selectedBot?.id);
            // Step 2: Re-crawl the URL (use the original root domain as URL)
            const crawlUrl = docName.startsWith('http') ? docName : `https://${docName}`;
            const result = await crawlWebsite(crawlUrl, selectedBot?.id);
            showToast('success', `Recrawled successfully! ${result.pages_processed || 0} pages processed.`);
            fetchDocuments();
        } catch (err) {
            showToast('error', `Recrawl failed: ${err?.detail || err?.message || err}`);
        } finally {
            setRecrawlingDoc(null);
        }
    };

    // --- URL Crawl Handlers ---
    const handleCrawlSubmit = async (e) => {
        e.preventDefault();
        if (!url.trim()) return;

        setIsCrawling(true);
        setCrawlStatus(null);

        try {
            const result = await crawlWebsite(url, selectedBot?.id);
            setCrawlStatus({
                type: 'success',
                message: `Successfully crawled ${result.pages_processed || 0} pages and ingested ${result.chunks_processed || 0} chunks.`
            });
            showToast('success', `Crawling done successfully! ${result.pages_processed || 0} pages processed.`);
            setUrl(''); // Clear success
            if (activeTab === 'list') fetchDocuments();

        } catch (error) {
            setCrawlStatus({
                type: 'error',
                message: error.detail || error.message || 'Failed to crawl website.'
            });
            showToast('error', 'Crawling failed. Please try again.');
        } finally {
            setIsCrawling(false);
        }
    };

    // --- Rendering Helpers ---
    const renderStatus = (status) => {
        if (!status) return null;
        return (
            <div className={`mt-4 p-4 rounded-xl flex items-start gap-3 text-sm font-medium ${status.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
                }`}>
                {status.type === 'success' ? <CheckCircle2 className="shrink-0 mt-0.5" size={18} /> : <AlertCircle className="shrink-0 mt-0.5" size={18} />}
                <p>{status.message}</p>
            </div>
        )
    };

    return (
        <div className="space-y-6 animate-slide-up pb-10">
            {/* Toast Notification */}
            <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-5 py-3 rounded-xl shadow-lg border transition-all duration-500 ${toast
                ? 'opacity-100 translate-y-0'
                : 'opacity-0 -translate-y-4 pointer-events-none'
                } ${toast?.type === 'success'
                    ? 'bg-green-50 dark:bg-green-900/90 border-green-200 dark:border-green-700 text-green-700 dark:text-green-300'
                    : 'bg-red-50 dark:bg-red-900/90 border-red-200 dark:border-red-700 text-red-700 dark:text-red-300'
                }`}>
                {toast?.type === 'success'
                    ? <CheckCircle2 size={18} className="shrink-0" />
                    : <AlertCircle size={18} className="shrink-0" />
                }
                <span className="text-sm font-medium">{toast?.message}</span>
                <button
                    onClick={() => { if (toastTimer.current) clearTimeout(toastTimer.current); setToast(null); }}
                    className="ml-2 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                >
                    <X size={14} />
                </button>
            </div>

            <div>
                <h1 className="text-2xl font-bold text-secondary-900 dark:text-white">Knowledge Base</h1>
                <p className="text-secondary-500 dark:text-secondary-400 mt-1">Manage the documents and URLs that power your AI.</p>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-secondary-200 dark:border-secondary-700 gap-6">
                <button
                    onClick={() => setActiveTab('files')}
                    className={`pb-3 font-medium transition-all text-sm border-b-2 ${activeTab === 'files' ? 'border-primary-600 text-primary-600' : 'border-transparent text-secondary-500 hover:text-secondary-700'
                        }`}
                >
                    <div className="flex items-center gap-2"><UploadCloud size={16} /> File Upload</div>
                </button>
                <button
                    onClick={() => setActiveTab('urls')}
                    className={`pb-3 font-medium transition-all text-sm border-b-2 ${activeTab === 'urls' ? 'border-primary-600 text-primary-600' : 'border-transparent text-secondary-500 hover:text-secondary-700'
                        }`}
                >
                    <div className="flex items-center gap-2"><LinkIcon size={16} /> Default Websites</div>
                </button>
                <button
                    onClick={() => setActiveTab('list')}
                    className={`pb-3 font-medium transition-all text-sm border-b-2 ${activeTab === 'list' ? 'border-primary-600 text-primary-600' : 'border-transparent text-secondary-500 hover:text-secondary-700'
                        }`}
                >
                    <div className="flex items-center gap-2"><ListIcon size={16} /> Ingested Data</div>
                </button>
            </div>

            <div className="bg-white dark:bg-secondary-800 p-6 md:p-8 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm max-w-4xl min-h-[400px] transition-colors">

                {/* FILE UPLOAD VIEW */}
                {activeTab === 'files' && (
                    <div className="space-y-6 animate-slide-up">
                        <h2 className="text-lg font-semibold text-secondary-900 dark:text-white">Upload Knowledge Documents</h2>

                        <div
                            onDragOver={handleDragOver}
                            onDragLeave={handleDragLeave}
                            onDrop={handleDrop}
                            className={`border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center text-center transition-all ${isDragging ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20' : 'border-secondary-300 dark:border-secondary-600 hover:border-primary-400 dark:hover:border-primary-500 bg-secondary-50 dark:bg-secondary-900/50'
                                }`}
                        >
                            <div className="w-16 h-16 rounded-full bg-primary-100 dark:bg-primary-900/50 text-primary-600 dark:text-primary-400 flex items-center justify-center mb-4">
                                <UploadCloud size={32} />
                            </div>
                            <h3 className="text-secondary-900 dark:text-white font-medium mb-1">Drag and drop your documents here</h3>
                            <p className="text-secondary-500 dark:text-secondary-400 text-sm mb-6">Supported formats: PDF, DOCX, TXT, MD (Max 50MB)</p>

                            <input
                                type="file"
                                multiple
                                accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                                className="hidden"
                                ref={fileInputRef}
                                onChange={handleFileSelect}
                            />
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="bg-white dark:bg-secondary-800 border border-secondary-300 dark:border-secondary-600 text-secondary-700 dark:text-secondary-300 hover:bg-secondary-50 dark:hover:bg-secondary-700 px-6 py-2.5 rounded-xl font-medium shadow-sm transition-all"
                                disabled={isUploading}
                            >
                                Browse Files
                            </button>
                        </div>

                        {/* Selected Files List */}
                        {selectedFiles.length > 0 && (
                            <div className="space-y-3">
                                <h4 className="text-sm font-medium text-secondary-700 dark:text-secondary-300">Selected Files ({selectedFiles.length})</h4>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {selectedFiles.map((file, index) => (
                                        <div key={index} className="flex items-center justify-between p-3 border border-secondary-200 dark:border-secondary-700 rounded-xl bg-white dark:bg-secondary-800 shadow-sm">
                                            <div className="flex items-center gap-3 overflow-hidden">
                                                <div className={`p-2 rounded-lg shrink-0 ${file.name.toLowerCase().endsWith('.pdf') ? 'bg-red-50 dark:bg-red-900/20 text-red-500 dark:text-red-400' :
                                                    file.name.toLowerCase().endsWith('.docx') ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400' :
                                                        'bg-secondary-100 dark:bg-secondary-700 text-secondary-600 dark:text-secondary-400'
                                                    }`}>
                                                    <FileText size={16} />
                                                </div>
                                                <div className="truncate">
                                                    <p className="text-sm font-medium text-secondary-900 dark:text-secondary-200 truncate">{file.name}</p>
                                                    <p className="text-xs text-secondary-500 dark:text-secondary-400">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => removeFile(index)}
                                                disabled={isUploading}
                                                className="p-1.5 text-secondary-400 dark:text-secondary-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors shrink-0"
                                            >
                                                <X size={16} />
                                            </button>
                                        </div>
                                    ))}
                                </div>

                                <div className="flex justify-end pt-4">
                                    <button
                                        onClick={handleUploadClick}
                                        disabled={isUploading}
                                        className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-6 py-2.5 rounded-xl font-medium shadow-sm transition-all disabled:opacity-70 disabled:cursor-not-allowed"
                                    >
                                        {isUploading ? (
                                            <><Loader2 size={18} className="animate-spin" /> Processing...</>
                                        ) : (
                                            <><UploadCloud size={18} /> Upload {selectedFiles.length} Files</>
                                        )}
                                    </button>
                                </div>
                            </div>
                        )}

                        {renderStatus(uploadStatus)}
                    </div>
                )}

                {/* URL CRAWL VIEW */}
                {activeTab === 'urls' && (
                    <div className="space-y-6 animate-slide-up">
                        <div>
                            <h2 className="text-lg font-semibold text-secondary-900 dark:text-white">Ingest Website Content</h2>
                            <p className="text-sm text-secondary-500 dark:text-secondary-400 mt-1">Provide a root URL, and we will crawl the site to build the AI's knowledge base.</p>
                        </div>

                        <form onSubmit={handleCrawlSubmit} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1">Website URL</label>
                                <div className="relative flex items-center">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <LinkIcon className="text-secondary-400 dark:text-secondary-500" size={18} />
                                    </div>
                                    <input
                                        type="url"
                                        value={url}
                                        onChange={(e) => setUrl(e.target.value)}
                                        required
                                        placeholder="https://example.com"
                                        className="w-full pl-10 pr-4 py-3 rounded-xl border border-secondary-300 dark:border-secondary-600 bg-white dark:bg-secondary-700 text-secondary-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-all shadow-sm"
                                        disabled={isCrawling}
                                    />
                                </div>
                            </div>

                            <button
                                type="submit"
                                disabled={isCrawling || !url}
                                className="flex items-center justify-center gap-2 w-full bg-primary-600 hover:bg-primary-700 text-white px-6 py-3 rounded-xl font-medium shadow-sm transition-all disabled:opacity-70 disabled:cursor-not-allowed"
                            >
                                {isCrawling ? (
                                    <><Loader2 size={18} className="animate-spin" /> Crawling in progress (this may take a minute)...</>
                                ) : (
                                    <><LinkIcon size={18} /> Start Crawl</>
                                )}
                            </button>
                        </form>

                        {renderStatus(crawlStatus)}

                        <div className="mt-8 p-5 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/50 rounded-xl text-blue-800 dark:text-blue-300 text-sm transition-colors">
                            <p className="font-semibold mb-1">How crawling works:</p>
                            <ul className="list-disc pl-5 space-y-1 text-blue-700/80 dark:text-blue-400/80">
                                <li>We fetch the main page and follow any internal links found on that page.</li>
                                <li>Content is automatically stripped of HTML and chunked for AI ingestion.</li>
                                <li>Make sure the site allows bots (check robots.txt) and doesn't require complex JavaScript rendering.</li>
                            </ul>
                        </div>
                    </div>
                )}

                {/* LIST VIEW */}
                {activeTab === 'list' && (
                    <div className="space-y-6 animate-slide-up">
                        <div className="flex items-center justify-between">
                            <div>
                                <h2 className="text-lg font-semibold text-secondary-900 dark:text-white">Ingested Sources</h2>
                                <p className="text-sm text-secondary-500 dark:text-secondary-400 mt-1">Review the files and websites your AI is currently trained on.</p>
                            </div>
                            <button
                                onClick={fetchDocuments}
                                className="flex items-center gap-2 text-sm text-primary-600 hover:text-primary-700 font-medium px-3 py-1.5 rounded-lg hover:bg-primary-50 transition-colors"
                            >
                                Refresh List
                            </button>
                        </div>

                        {isLoadingDocs ? (
                            <div className="flex flex-col items-center justify-center py-12 text-secondary-400 dark:text-secondary-500">
                                <Loader2 className="animate-spin mb-3" size={32} />
                                <p>Loading your documents...</p>
                            </div>
                        ) : documents.length === 0 ? (
                            <div className="text-center py-12 border-2 border-dashed border-secondary-200 dark:border-secondary-700 rounded-2xl bg-secondary-50 dark:bg-secondary-900/50">
                                <FileText className="mx-auto text-secondary-400 dark:text-secondary-600 mb-3" size={32} />
                                <p className="text-secondary-600 dark:text-secondary-400 font-medium">No documents ingested yet.</p>
                                <p className="text-sm text-secondary-500 dark:text-secondary-500 mt-1">Upload documents or crawl a website to see them here.</p>

                            </div>
                        ) : (
                            <div className="overflow-hidden border border-secondary-200 dark:border-secondary-700 rounded-xl shadow-sm transition-colors">
                                <table className="w-full text-left bg-white dark:bg-secondary-800">
                                    <thead className="bg-secondary-50 dark:bg-secondary-900/50 border-b border-secondary-200 dark:border-secondary-700">
                                        <tr>
                                            <th className="px-6 py-3 text-xs font-semibold text-secondary-600 dark:text-secondary-400 uppercase tracking-wider">Source Name</th>
                                            <th className="px-6 py-3 text-xs font-semibold text-secondary-600 dark:text-secondary-400 uppercase tracking-wider">Type</th>
                                            <th className="px-6 py-3 text-xs font-semibold text-secondary-600 dark:text-secondary-400 uppercase tracking-wider text-right">Ingested On</th>
                                            <th className="px-6 py-3 text-xs font-semibold text-secondary-600 dark:text-secondary-400 uppercase tracking-wider text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-secondary-100 dark:divide-secondary-700">
                                        {documents.map((doc, idx) => {
                                            const isUrl = doc.name.startsWith('http://') || doc.name.startsWith('https://');
                                            const Icon = isUrl ? LinkIcon : FileText;

                                            // Format date nicely
                                            const dateObj = doc.ingested_at ? new Date(doc.ingested_at) : null;
                                            const dateStr = dateObj ? dateObj.toLocaleDateString() : 'Unknown';

                                            return (
                                                <tr key={idx} className="hover:bg-secondary-50 dark:hover:bg-secondary-700/50 transition-colors">
                                                    <td className="px-6 py-4">
                                                        <div className="flex items-center gap-3">
                                                            <div className={`p-2 rounded-lg shrink-0 ${isUrl ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400' : 'bg-red-50 dark:bg-red-900/20 text-red-500 dark:text-red-400'}`}>
                                                                <Icon size={16} />
                                                            </div>
                                                            <span className="text-sm font-medium text-secondary-900 dark:text-secondary-200 truncate max-w-[300px]" title={doc.name}>
                                                                {doc.name}
                                                            </span>
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${isUrl ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-400' : 'bg-secondary-100 dark:bg-secondary-700 text-secondary-800 dark:text-secondary-300'}`}>
                                                            {isUrl ? 'Website' : 'Document'}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-secondary-500 dark:text-secondary-400 text-right">
                                                        <div className="flex items-center justify-end gap-1.5">
                                                            <Calendar size={14} className="text-secondary-400 dark:text-secondary-500" />
                                                            {dateStr}
                                                        </div>
                                                    </td>
                                                    {/* Actions Column */}
                                                    <td className="px-6 py-4 text-right">
                                                        {confirmingDelete === doc.name ? (
                                                            <div className="flex items-center justify-end gap-2">
                                                                <span className="text-xs text-secondary-500 dark:text-secondary-400">Sure?</span>
                                                                <button
                                                                    onClick={() => handleDelete(doc.name)}
                                                                    disabled={deletingDoc === doc.name}
                                                                    className="p-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
                                                                    title="Confirm delete"
                                                                >
                                                                    {deletingDoc === doc.name
                                                                        ? <Loader2 size={14} className="animate-spin" />
                                                                        : <Check size={14} />}
                                                                </button>
                                                                <button
                                                                    onClick={() => setConfirmingDelete(null)}
                                                                    className="p-1.5 rounded-lg bg-secondary-100 dark:bg-secondary-700 text-secondary-500 hover:bg-secondary-200 dark:hover:bg-secondary-600 transition-colors"
                                                                    title="Cancel"
                                                                >
                                                                    <X size={14} />
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <div className="flex items-center justify-end gap-1.5">
                                                                {isUrl && (
                                                                    <button
                                                                        onClick={() => handleRecrawl(doc.name)}
                                                                        disabled={recrawlingDoc === doc.name}
                                                                        className="p-1.5 rounded-lg text-secondary-400 hover:text-primary-500 hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors"
                                                                        title="Recrawl website"
                                                                    >
                                                                        {recrawlingDoc === doc.name
                                                                            ? <Loader2 size={15} className="animate-spin text-primary-500" />
                                                                            : <RefreshCw size={15} />}
                                                                    </button>
                                                                )}
                                                                <button
                                                                    onClick={() => setConfirmingDelete(doc.name)}
                                                                    disabled={recrawlingDoc === doc.name}
                                                                    className="p-1.5 rounded-lg text-secondary-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                                                    title="Delete document"
                                                                >
                                                                    <Trash2 size={15} />
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
