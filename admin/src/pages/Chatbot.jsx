import { useState, useRef, useEffect } from 'react';
import {
    Bot, Plus, Copy, Check, Trash2, Code2, Key, Globe, Loader2,
    X, AlertCircle, ChevronDown, ChevronRight, Eye, EyeOff
} from 'lucide-react';
import { useBotContext } from '../context/BotContext';
import { createBot, deleteBot } from '../services/api';

export default function Chatbot() {
    const { bots, selectedBot, selectBot, refreshBots, loading } = useBotContext();
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [newBotName, setNewBotName] = useState('');
    const [newBotWebsite, setNewBotWebsite] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [copiedField, setCopiedField] = useState(null);
    const [expandedBot, setExpandedBot] = useState(null);
    const [deletingBot, setDeletingBot] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(null);
    const [showKeys, setShowKeys] = useState({});

    // Toast
    const [toast, setToast] = useState(null);
    const toastTimer = useRef(null);
    const showToast = (type, message) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast({ type, message });
        toastTimer.current = setTimeout(() => setToast(null), 4000);
    };
    useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

    const handleCopy = (text, field) => {
        navigator.clipboard.writeText(text);
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 2000);
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!newBotName.trim()) return;
        setError('');
        setIsSubmitting(true);
        try {
            const result = await createBot({ name: newBotName.trim(), website: newBotWebsite.trim() || undefined });
            await refreshBots();
            setNewBotName('');
            setNewBotWebsite('');
            setIsCreateOpen(false);
            showToast('success', `Bot "${result.name}" created successfully!`);
            // Auto-expand the new bot to show its embed code
            setExpandedBot(result.bot_id);
        } catch (err) {
            setError(typeof err === 'string' ? err : err?.detail || 'Failed to create bot');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDelete = async (botId, botName) => {
        setDeletingBot(botId);
        try {
            await deleteBot(botId);
            await refreshBots();
            showToast('success', `Bot "${botName}" deleted successfully.`);
            setConfirmDelete(null);
            if (expandedBot === botId) setExpandedBot(null);
        } catch (err) {
            showToast('error', typeof err === 'string' ? err : err?.detail || 'Failed to delete bot');
        } finally {
            setDeletingBot(null);
            setConfirmDelete(null);
        }
    };

    const getEmbedScript = (botKey) => {
        return `<script src="https://cdn.oyechats.com/oyechat-widget.js" data-bot-key="${botKey}"></script>`;
    };

    const getDevEmbedScript = (botKey) => {
        return `<!-- OyeChat Widget (Development) -->
<script src="http://localhost:4173/oyechat-widget.js" data-bot-key="${botKey}"></script>`;
    };

    const toggleKey = (botId) => {
        setShowKeys(prev => ({ ...prev, [botId]: !prev[botId] }));
    };

    const maskKey = (key) => {
        if (!key) return '';
        return key.substring(0, 6) + '••••••••' + key.substring(key.length - 4);
    };

    return (
        <div className="space-y-6 animate-slide-up pb-10">
            {/* Toast */}
            <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-5 py-3 rounded-xl shadow-lg border transition-all duration-500 ${toast ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'
                } ${toast?.type === 'success'
                    ? 'bg-green-50 dark:bg-green-900/90 border-green-200 dark:border-green-700 text-green-700 dark:text-green-300'
                    : 'bg-red-50 dark:bg-red-900/90 border-red-200 dark:border-red-700 text-red-700 dark:text-red-300'
                }`}>
                {toast?.type === 'success' ? <Check size={18} /> : <AlertCircle size={18} />}
                <span className="text-sm font-medium">{toast?.message}</span>
                <button onClick={() => { if (toastTimer.current) clearTimeout(toastTimer.current); setToast(null); }}
                    className="ml-2 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
                    <X size={14} />
                </button>
            </div>

            {/* Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-secondary-900 dark:text-white">Chatbots</h1>
                    <p className="text-secondary-500 dark:text-secondary-400 mt-1">
                        Manage your chatbot instances. Each bot has its own knowledge base, settings, and embed key.
                    </p>
                </div>
                <button
                    onClick={() => setIsCreateOpen(true)}
                    className="flex items-center gap-2 px-5 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl font-medium shadow-sm transition-all hover:shadow hover:-translate-y-0.5 active:translate-y-0"
                >
                    <Plus size={16} />
                    Add Chatbot
                </button>
            </div>

            {/* Bot Cards */}
            {loading ? (
                <div className="flex flex-col items-center justify-center py-16 text-secondary-400">
                    <Loader2 className="animate-spin mb-3" size={32} />
                    <p>Loading chatbots...</p>
                </div>
            ) : bots.length === 0 ? (
                <div className="bg-white dark:bg-secondary-800 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm p-12 flex flex-col items-center text-center">
                    <div className="w-16 h-16 rounded-2xl bg-primary-50 dark:bg-primary-900/20 flex items-center justify-center mb-4">
                        <Bot size={28} className="text-primary-500" />
                    </div>
                    <h3 className="text-lg font-bold text-secondary-900 dark:text-white mb-2">No chatbots yet</h3>
                    <p className="text-secondary-500 dark:text-secondary-400 max-w-sm">
                        Create your first chatbot to get started. Each bot gets its own embed code and knowledge base.
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    {bots.map((bot) => {
                        const isExpanded = expandedBot === bot.id;
                        const isSelected = selectedBot?.id === bot.id;
                        return (
                            <div key={bot.id}
                                className={`bg-white dark:bg-secondary-800 rounded-2xl border shadow-sm transition-all overflow-hidden ${isSelected
                                        ? 'border-primary-300 dark:border-primary-700 ring-1 ring-primary-200 dark:ring-primary-800'
                                        : 'border-secondary-200 dark:border-secondary-700'
                                    }`}
                            >
                                {/* Bot Header Row */}
                                <div className="p-5 flex items-center gap-4">
                                    {/* Bot Icon */}
                                    <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${isSelected
                                            ? 'bg-primary-100 dark:bg-primary-900/30'
                                            : 'bg-secondary-100 dark:bg-secondary-700/50'
                                        }`}>
                                        {bot.bot_logo ? (
                                            <img src={bot.bot_logo} alt="" className="w-full h-full object-cover rounded-xl" />
                                        ) : (
                                            <Bot size={20} className={isSelected ? 'text-primary-600 dark:text-primary-400' : 'text-secondary-500'} />
                                        )}
                                    </div>

                                    {/* Bot Info */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <h3 className="text-[15px] font-bold text-secondary-900 dark:text-white truncate">
                                                {bot.name}
                                            </h3>
                                            {isSelected && (
                                                <span className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold text-primary-600 bg-primary-100 dark:bg-primary-900/30 dark:text-primary-400 rounded-full uppercase">
                                                    Active
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-3 mt-0.5">
                                            <span className="text-[11px] text-secondary-400 font-mono">{maskKey(bot.bot_key)}</span>
                                            <span className="text-[10px] text-secondary-400">
                                                Created {new Date(bot.created_at).toLocaleDateString()}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Actions */}
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        {!isSelected && (
                                            <button
                                                onClick={() => selectBot(bot)}
                                                className="px-3 py-1.5 text-[11px] font-bold text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20 rounded-lg hover:bg-primary-100 dark:hover:bg-primary-900/30 transition-colors"
                                            >
                                                Set Active
                                            </button>
                                        )}
                                        <button
                                            onClick={() => setExpandedBot(isExpanded ? null : bot.id)}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-secondary-600 dark:text-secondary-300 bg-secondary-100 dark:bg-secondary-700 rounded-lg hover:bg-secondary-200 dark:hover:bg-secondary-600 transition-colors"
                                        >
                                            <Code2 size={13} />
                                            Embed Code
                                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                        </button>
                                        {confirmDelete === bot.id ? (
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-[10px] text-secondary-500">Sure?</span>
                                                <button
                                                    onClick={() => handleDelete(bot.id, bot.name)}
                                                    disabled={deletingBot === bot.id}
                                                    className="p-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
                                                >
                                                    {deletingBot === bot.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                                                </button>
                                                <button
                                                    onClick={() => setConfirmDelete(null)}
                                                    className="p-1.5 rounded-lg bg-secondary-100 dark:bg-secondary-700 text-secondary-500 hover:bg-secondary-200 dark:hover:bg-secondary-600 transition-colors"
                                                >
                                                    <X size={13} />
                                                </button>
                                            </div>
                                        ) : (
                                            <button
                                                onClick={() => setConfirmDelete(bot.id)}
                                                className="p-1.5 rounded-lg text-secondary-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                                title="Delete bot"
                                            >
                                                <Trash2 size={15} />
                                            </button>
                                        )
                                        }
                                    </div>
                                </div>

                                {/* Expanded: Embed Code Section */}
                                {isExpanded && (
                                    <div className="border-t border-secondary-100 dark:border-secondary-700 bg-secondary-50/50 dark:bg-secondary-900/30 p-5 space-y-5 animate-slide-up">
                                        {/* Bot Key */}
                                        <div>
                                            <div className="flex items-center justify-between mb-2">
                                                <label className="text-[11px] font-bold uppercase tracking-wider text-secondary-500 flex items-center gap-1.5">
                                                    <Key size={12} />
                                                    Bot Key
                                                </label>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => toggleKey(bot.id)}
                                                        className="text-secondary-400 hover:text-secondary-600 dark:hover:text-secondary-300 transition-colors"
                                                        title={showKeys[bot.id] ? 'Hide key' : 'Show key'}
                                                    >
                                                        {showKeys[bot.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                                                    </button>
                                                    <button
                                                        onClick={() => handleCopy(bot.bot_key, `key-${bot.id}`)}
                                                        className="flex items-center gap-1 text-primary-600 dark:text-primary-400 hover:text-primary-700 transition-colors"
                                                    >
                                                        {copiedField === `key-${bot.id}` ? <Check size={12} /> : <Copy size={12} />}
                                                        <span className="text-[9px] font-bold uppercase">
                                                            {copiedField === `key-${bot.id}` ? 'Copied' : 'Copy'}
                                                        </span>
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="flex items-center bg-white dark:bg-secondary-800 border border-secondary-200 dark:border-secondary-700 rounded-lg px-3 py-2.5">
                                                <Key className="w-4 h-4 text-amber-500 mr-2 flex-shrink-0" />
                                                <code className="text-xs text-secondary-800 dark:text-secondary-200 font-mono break-all">
                                                    {showKeys[bot.id] ? bot.bot_key : maskKey(bot.bot_key)}
                                                </code>
                                            </div>
                                        </div>

                                        {/* Production Embed Script */}
                                        <div>
                                            <div className="flex items-center justify-between mb-2">
                                                <label className="text-[11px] font-bold uppercase tracking-wider text-secondary-500 flex items-center gap-1.5">
                                                    <Code2 size={12} />
                                                    Embed Script (Production)
                                                </label>
                                                <button
                                                    onClick={() => handleCopy(getEmbedScript(bot.bot_key), `embed-${bot.id}`)}
                                                    className="flex items-center gap-1 text-primary-600 dark:text-primary-400 hover:text-primary-700 transition-colors"
                                                >
                                                    {copiedField === `embed-${bot.id}` ? <Check size={12} /> : <Copy size={12} />}
                                                    <span className="text-[9px] font-bold uppercase">
                                                        {copiedField === `embed-${bot.id}` ? 'Copied' : 'Copy'}
                                                    </span>
                                                </button>
                                            </div>
                                            <pre className="bg-secondary-900 text-green-400 p-4 rounded-xl text-[11px] leading-relaxed overflow-x-auto border border-secondary-800 font-mono">
                                                {getEmbedScript(bot.bot_key)}
                                            </pre>
                                            <p className="text-[10px] text-secondary-400 mt-1.5">
                                                Paste this script in your website's <code className="text-secondary-500 bg-secondary-100 dark:bg-secondary-800 px-1 py-0.5 rounded">&lt;body&gt;</code> tag to embed the chatbot.
                                            </p>
                                        </div>

                                        {/* Dev Embed Script */}
                                        <div>
                                            <div className="flex items-center justify-between mb-2">
                                                <label className="text-[11px] font-bold uppercase tracking-wider text-secondary-500 flex items-center gap-1.5">
                                                    <Globe size={12} />
                                                    Development Script
                                                </label>
                                                <button
                                                    onClick={() => handleCopy(getDevEmbedScript(bot.bot_key), `dev-${bot.id}`)}
                                                    className="flex items-center gap-1 text-primary-600 dark:text-primary-400 hover:text-primary-700 transition-colors"
                                                >
                                                    {copiedField === `dev-${bot.id}` ? <Check size={12} /> : <Copy size={12} />}
                                                    <span className="text-[9px] font-bold uppercase">
                                                        {copiedField === `dev-${bot.id}` ? 'Copied' : 'Copy'}
                                                    </span>
                                                </button>
                                            </div>
                                            <pre className="bg-secondary-900 text-amber-400 p-4 rounded-xl text-[11px] leading-relaxed overflow-x-auto border border-secondary-800 font-mono">
                                                {getDevEmbedScript(bot.bot_key)}
                                            </pre>
                                            <p className="text-[10px] text-secondary-400 mt-1.5 italic">
                                                * Build the widget first, then serve with <code className="text-secondary-500 bg-secondary-100 dark:bg-secondary-800 px-1 py-0.5 rounded">npx vite preview</code> on port 4173.
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Create Bot Modal */}
            {isCreateOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-secondary-900/60 backdrop-blur-sm animate-fade-in">
                    <div className="bg-white dark:bg-secondary-800 rounded-2xl shadow-xl w-full max-w-md border border-secondary-200 dark:border-secondary-700 overflow-hidden">
                        <div className="p-6">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-900/20 flex items-center justify-center">
                                    <Bot size={20} className="text-primary-600 dark:text-primary-400" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-secondary-900 dark:text-white">Create New Chatbot</h2>
                                    <p className="text-[12px] text-secondary-500 dark:text-secondary-400">Set up a new bot instance with its own embed key.</p>
                                </div>
                            </div>

                            <form onSubmit={handleCreate} className="space-y-4">
                                {error && (
                                    <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-lg border border-red-100 dark:border-red-900/30 flex items-center gap-2">
                                        <AlertCircle size={16} className="flex-shrink-0" />
                                        {error}
                                    </div>
                                )}

                                <div>
                                    <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">
                                        Bot Name <span className="text-red-400">*</span>
                                    </label>
                                    <input
                                        type="text"
                                        required
                                        value={newBotName}
                                        onChange={(e) => setNewBotName(e.target.value)}
                                        className="w-full h-11 px-3 rounded-xl border border-secondary-300 dark:border-secondary-600 bg-white dark:bg-secondary-900 text-secondary-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition-all"
                                        placeholder="e.g. Support Bot, Sales Assistant..."
                                        maxLength={50}
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">
                                        Website <span className="text-secondary-400">(optional)</span>
                                    </label>
                                    <input
                                        type="url"
                                        value={newBotWebsite}
                                        onChange={(e) => setNewBotWebsite(e.target.value)}
                                        className="w-full h-11 px-3 rounded-xl border border-secondary-300 dark:border-secondary-600 bg-white dark:bg-secondary-900 text-secondary-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition-all"
                                        placeholder="https://yourwebsite.com"
                                    />
                                </div>

                                <div className="flex gap-3 pt-4">
                                    <button
                                        type="button"
                                        onClick={() => { setIsCreateOpen(false); setError(''); setNewBotName(''); setNewBotWebsite(''); }}
                                        className="flex-1 py-2.5 bg-white border border-secondary-200 dark:bg-secondary-700 dark:border-secondary-600 text-secondary-700 dark:text-secondary-300 hover:bg-secondary-50 dark:hover:bg-secondary-600 rounded-xl font-medium transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={isSubmitting || !newBotName.trim()}
                                        className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl font-medium shadow-sm transition-colors flex justify-center items-center disabled:opacity-70 disabled:cursor-not-allowed"
                                    >
                                        {isSubmitting ? <Loader2 size={18} className="animate-spin" /> : 'Create Bot'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
