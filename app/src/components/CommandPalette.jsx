import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Search, LayoutDashboard, BookOpen, BarChart3, Target, Crosshair, Headphones,
    Bot, Palette, Settings, Plug, Upload, Plus, X, UsersRound
} from 'lucide-react';
import { cn } from '../lib/utils';

const pages = [
    { name: 'Overview', path: '/', icon: LayoutDashboard, keywords: 'dashboard home overview stats' },
    { name: 'Sources', path: '/knowledge', icon: BookOpen, keywords: 'knowledge base documents upload' },
    { name: 'Insights', path: '/insights', icon: BarChart3, keywords: 'analytics charts metrics activity conversations feedback ratings' },
    { name: 'Support', path: '/support', icon: Headphones, keywords: 'live chat messages offline support operator' },
    { name: 'Leads', path: '/leads', icon: Target, keywords: 'leads sales prospects' },
    { name: 'Qualification', path: '/qualification', icon: Crosshair, keywords: 'qualification bant scoring criteria visitor' },
    { name: 'My Bots', path: '/chatbot', icon: Bot, keywords: 'chatbot bots embed code create appearance customize' },
    { name: 'Team', path: '/team', icon: UsersRound, keywords: 'team operators departments members quick replies canned responses' },
    { name: 'Settings', path: '/settings', icon: Settings, keywords: 'settings preferences account theme' },
    { name: 'Integrations', path: '/integrations/email', icon: Plug, keywords: 'integrations email channels' },
];

const actions = [
    { name: 'Upload Documents', path: '/knowledge', icon: Upload, keywords: 'upload documents files' },
    { name: 'Create New Bot', path: '/chatbot?create=true', icon: Plus, keywords: 'create new bot chatbot' },
    { name: 'Customize Bot', path: '/chatbot?tab=appearance', icon: Palette, keywords: 'customize bot appearance theme colors branding' },
];

const overlayVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1 },
    exit: { opacity: 0 },
};

const modalVariants = {
    hidden: { opacity: 0, scale: 0.95, y: -10 },
    visible: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring', damping: 25, stiffness: 400 } },
    exit: { opacity: 0, scale: 0.95, y: -10, transition: { duration: 0.15 } },
};

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

    let selectableIndex = -1;

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]">
                    <motion.div
                        className="absolute inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm"
                        variants={overlayVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        onClick={onClose}
                    />
                    <motion.div
                        className="relative w-full max-w-lg bg-white dark:bg-surface-900 rounded-2xl shadow-2xl border border-surface-200 dark:border-surface-700 overflow-hidden"
                        variants={modalVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                    >
                        {/* Search Input */}
                        <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-100 dark:border-surface-700">
                            <Search size={18} className="text-surface-400 dark:text-surface-500 shrink-0" />
                            <input
                                ref={inputRef}
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search pages and actions..."
                                className="flex-1 bg-transparent text-surface-900 dark:text-surface-100 placeholder-surface-400 dark:placeholder-surface-500 outline-none text-sm"
                            />
                            <kbd className="px-1.5 py-0.5 bg-surface-100 dark:bg-surface-800 rounded text-[10px] font-semibold text-surface-400 dark:text-surface-500">ESC</kbd>
                        </div>

                        {/* Results */}
                        <div className="max-h-80 overflow-y-auto p-2">
                            {results.length === 0 ? (
                                <div className="py-8 text-center text-surface-400 dark:text-surface-500 text-sm">No results found</div>
                            ) : (
                                results.map((item, i) => {
                                    if (item.type === 'section') {
                                        return (
                                            <p
                                                key={`section-${i}`}
                                                className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500"
                                            >
                                                {item.label}
                                            </p>
                                        );
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
                                            className={cn(
                                                'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors',
                                                isSelected
                                                    ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                                                    : 'text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800'
                                            )}
                                        >
                                            <Icon
                                                size={16}
                                                className={cn(
                                                    isSelected
                                                        ? 'text-primary-500 dark:text-primary-400'
                                                        : 'text-surface-400 dark:text-surface-500'
                                                )}
                                            />
                                            <span className="text-sm font-medium">{item.name}</span>
                                            {item.type === 'action' && (
                                                <span className="ml-auto text-[9px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500 bg-surface-100 dark:bg-surface-800 px-1.5 py-0.5 rounded">
                                                    Action
                                                </span>
                                            )}
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}
