import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Search, LayoutDashboard, BookOpen, BarChart3, MessageCircle,
    ThumbsUp, Bot, Palette, Settings, Plug, Upload, Plus, X
} from 'lucide-react';

const pages = [
    { name: 'Overview', path: '/', icon: LayoutDashboard, keywords: 'dashboard home overview stats' },
    { name: 'Sources', path: '/knowledge', icon: BookOpen, keywords: 'knowledge base documents upload' },
    { name: 'Analytics', path: '/analytics', icon: BarChart3, keywords: 'analytics charts metrics activity' },
    { name: 'Conversations', path: '/users', icon: MessageCircle, keywords: 'visitors users conversations chat history' },
    { name: 'Feedback', path: '/feedback', icon: ThumbsUp, keywords: 'feedback ratings thumbs review' },
    { name: 'My Bots', path: '/chatbot', icon: Bot, keywords: 'chatbot bots embed code create' },
    { name: 'Appearance', path: '/interface', icon: Palette, keywords: 'interface customize theme colors branding' },
    { name: 'Settings', path: '/settings', icon: Settings, keywords: 'settings preferences account theme' },
    { name: 'Integrations', path: '/integrations/email', icon: Plug, keywords: 'integrations email channels' },
    { name: 'Team', path: '/team', icon: Settings, keywords: 'team agents departments members' },
    { name: 'Messages', path: '/messages', icon: MessageCircle, keywords: 'offline messages inbox' },
];

const actions = [
    { name: 'Upload Documents', path: '/knowledge', icon: Upload, keywords: 'upload documents files' },
    { name: 'Create New Bot', path: '/chatbot', icon: Plus, keywords: 'create new bot chatbot' },
    { name: 'Customize Bot', path: '/interface', icon: Palette, keywords: 'customize bot appearance theme' },
];

export default function CommandPalette({ isOpen, onClose }) {
    const [query, setQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef(null);
    const navigate = useNavigate();

    useEffect(() => {
        if (isOpen) {
            setQuery('');
            setSelectedIndex(0);
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [isOpen]);

    const results = useMemo(() => {
        if (!query.trim()) {
            return [
                { type: 'section', label: 'Pages' },
                ...pages.map(p => ({ ...p, type: 'page' })),
                { type: 'section', label: 'Quick Actions' },
                ...actions.map(a => ({ ...a, type: 'action' })),
            ];
        }
        const q = query.toLowerCase();
        const matchedPages = pages.filter(p => p.name.toLowerCase().includes(q) || p.keywords.includes(q));
        const matchedActions = actions.filter(a => a.name.toLowerCase().includes(q) || a.keywords.includes(q));
        const items = [];
        if (matchedPages.length) { items.push({ type: 'section', label: 'Pages' }); items.push(...matchedPages.map(p => ({ ...p, type: 'page' }))); }
        if (matchedActions.length) { items.push({ type: 'section', label: 'Quick Actions' }); items.push(...matchedActions.map(a => ({ ...a, type: 'action' }))); }
        return items;
    }, [query]);

    const selectableResults = results.filter(r => r.type !== 'section');

    useEffect(() => {
        if (!isOpen) return;
        const handler = (e) => {
            if (e.key === 'Escape') { onClose(); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, selectableResults.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); }
            if (e.key === 'Enter' && selectableResults[selectedIndex]) {
                e.preventDefault();
                navigate(selectableResults[selectedIndex].path);
                onClose();
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [isOpen, selectedIndex, selectableResults, navigate, onClose]);

    useEffect(() => { setSelectedIndex(0); }, [query]);

    if (!isOpen) return null;

    let selectableIndex = -1;

    return (
        <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] animate-fade-in">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-lg bg-white dark:bg-secondary-900 rounded-2xl shadow-2xl border border-secondary-200 dark:border-secondary-800 overflow-hidden animate-scale-in">
                {/* Search Input */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-secondary-100 dark:border-secondary-800">
                    <Search size={18} className="text-secondary-400 shrink-0" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search pages and actions..."
                        className="flex-1 bg-transparent text-secondary-900 dark:text-white placeholder-secondary-400 outline-none text-sm"
                    />
                    <kbd className="px-1.5 py-0.5 bg-secondary-100 dark:bg-secondary-800 rounded text-[10px] font-semibold text-secondary-400">ESC</kbd>
                </div>

                {/* Results */}
                <div className="max-h-80 overflow-y-auto p-2">
                    {results.length === 0 ? (
                        <div className="py-8 text-center text-secondary-400 text-sm">No results found</div>
                    ) : (
                        results.map((item, i) => {
                            if (item.type === 'section') {
                                return <p key={`section-${i}`} className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-secondary-400">{item.label}</p>;
                            }
                            selectableIndex++;
                            const isSelected = selectableIndex === selectedIndex;
                            const Icon = item.icon;
                            const currentIdx = selectableIndex;
                            return (
                                <button
                                    key={item.path + item.name}
                                    onClick={() => { navigate(item.path); onClose(); }}
                                    onMouseEnter={() => setSelectedIndex(currentIdx)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                                        isSelected ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-400' : 'text-secondary-700 dark:text-secondary-300 hover:bg-secondary-50 dark:hover:bg-secondary-800'
                                    }`}
                                >
                                    <Icon size={16} className={isSelected ? 'text-primary-500' : 'text-secondary-400'} />
                                    <span className="text-sm font-medium">{item.name}</span>
                                    {item.type === 'action' && (
                                        <span className="ml-auto text-[9px] font-bold uppercase tracking-wider text-secondary-400 bg-secondary-100 dark:bg-secondary-800 px-1.5 py-0.5 rounded">Action</span>
                                    )}
                                </button>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
}
