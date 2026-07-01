import { useEffect, useRef, useState } from 'react';
import {
    Bot, Code2, MoreHorizontal, ExternalLink, Link2, Pencil, Trash2, Loader2, Check, X,
} from 'lucide-react';
import { getBotPreviewUrl } from '../../services/api';
import { cn } from '../../lib/utils';

/**
 * One bot row in the My Bots list. The card body is a keyboard-activatable
 * button (Enter/Space) that emits `onManage(bot)` — sets the bot active and
 * opens Bot Settings. The active bot shows an unambiguous badge + ring.
 *
 * Right side: an Install button (opens the slide-over) and an accessible ⋯
 * actions menu (View demo, Copy demo link, Rename, Delete-with-confirm). Every
 * inner control stops propagation so it never triggers the card's manage
 * action. The menu closes on click-outside + Esc.
 *
 * Props:
 *   bot, isActive, isBotManager
 *   onManage(bot) · onInstall(bot) · onRename(bot, name) · onDelete(bot) · onDemo(bot)
 */
export default function BotCard({
    bot, isActive, isBotManager, onManage, onInstall, onRename, onDelete, onDemo,
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(bot.name);

    const menuRef = useRef(null);
    const menuButtonRef = useRef(null);
    const renameInputRef = useRef(null);

    // Close the ⋯ menu on click-outside + Esc. Reset the delete-confirm step
    // whenever the menu closes so it never reopens mid-confirm.
    useEffect(() => {
        if (!menuOpen) return undefined;
        const onPointerDown = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)
                && menuButtonRef.current && !menuButtonRef.current.contains(e.target)) {
                setMenuOpen(false);
            }
        };
        const onKey = (e) => {
            if (e.key === 'Escape') {
                setMenuOpen(false);
                menuButtonRef.current?.focus();
            }
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [menuOpen]);

    useEffect(() => {
        if (!menuOpen) {
            setConfirmDelete(false);
            return;
        }
        // Move focus to the first action so the menu is immediately keyboard-
        // navigable when opened via the keyboard.
        const first = menuRef.current?.querySelector('[role="menuitem"]');
        first?.focus();
    }, [menuOpen]);

    const maskKey = (key) => (key ? `${key.substring(0, 6)}••••••••${key.substring(key.length - 4)}` : '');

    const startRename = () => {
        setMenuOpen(false);
        setRenameValue(bot.name);
        setIsRenaming(true);
        setTimeout(() => renameInputRef.current?.focus(), 30);
    };

    const cancelRename = () => {
        setIsRenaming(false);
        setRenameValue(bot.name);
    };

    const commitRename = () => {
        const trimmed = renameValue.trim();
        setIsRenaming(false);
        if (!trimmed || trimmed === bot.name) {
            setRenameValue(bot.name);
            return;
        }
        onRename(bot, trimmed);
    };

    const handleDelete = async () => {
        setIsDeleting(true);
        try {
            await onDelete(bot);
        } finally {
            setIsDeleting(false);
            setConfirmDelete(false);
            setMenuOpen(false);
        }
    };

    const handleCardKeyDown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onManage(bot);
        }
    };

    // Roving focus for the ⋯ menu: Up/Down move between items, Home/End jump.
    const handleMenuKeyDown = (e) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') || []);
        if (items.length === 0) return;
        const currentIndex = items.indexOf(document.activeElement);
        let nextIndex;
        if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = items.length - 1;
        else if (e.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
        else nextIndex = (currentIndex - 1 + items.length) % items.length;
        items[nextIndex]?.focus();
    };

    const stop = (e) => e.stopPropagation();

    return (
        <div
            role="button"
            tabIndex={0}
            aria-label={`Manage ${bot.name}`}
            onClick={() => onManage(bot)}
            onKeyDown={handleCardKeyDown}
            className={cn(
                'group bg-white dark:bg-surface-900 rounded-2xl border shadow-sm transition-all cursor-pointer',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-surface-950',
                isActive
                    ? 'border-primary-300 dark:border-primary-500/50 ring-1 ring-primary-200/50 dark:ring-primary-500/20'
                    : 'border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600',
            )}
        >
            <div className="p-5 flex items-center gap-4">
                <div className={cn(
                    'w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0',
                    isActive ? 'bg-primary-100 dark:bg-primary-500/15' : 'bg-surface-100 dark:bg-surface-800',
                )}>
                    {bot.bot_logo
                        ? <img src={bot.bot_logo} alt="" className="w-full h-full object-cover rounded-xl" />
                        : <Bot size={20} className={isActive ? 'text-primary-600 dark:text-primary-400' : 'text-surface-400 dark:text-surface-500'} />}
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        {isRenaming ? (
                            <input
                                ref={renameInputRef}
                                type="text"
                                value={renameValue}
                                onClick={stop}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                                    else if (e.key === 'Escape') cancelRename();
                                }}
                                onBlur={commitRename}
                                maxLength={50}
                                className="text-sm font-bold text-surface-900 dark:text-surface-100 bg-white dark:bg-surface-800 border border-primary-400 dark:border-primary-500 rounded-md px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-400/30 w-48"
                            />
                        ) : (
                            <h3 className="text-sm font-bold text-surface-900 dark:text-surface-100 truncate">
                                {bot.name}
                            </h3>
                        )}
                        {isActive && (
                            <span className="px-2 py-0.5 text-[9px] font-bold text-primary-600 dark:text-primary-400 bg-primary-100 dark:bg-primary-500/15 rounded-full uppercase">
                                Active
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-[11px] text-surface-400 dark:text-surface-500 font-mono">{maskKey(bot.bot_key)}</span>
                        <span className="text-[10px] text-surface-400 dark:text-surface-500">Created {new Date(bot.created_at).toLocaleDateString()}</span>
                    </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0" onClick={stop}>
                    <button
                        onClick={(e) => { stop(e); onInstall(bot); }}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-surface-600 dark:text-surface-300 bg-surface-100 dark:bg-surface-800 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                    >
                        <Code2 size={13} /> Install
                    </button>

                    <div className="relative">
                        <button
                            ref={menuButtonRef}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            aria-label={`Actions for ${bot.name}`}
                            onClick={(e) => { stop(e); setMenuOpen((v) => !v); }}
                            className="p-1.5 rounded-lg text-surface-400 dark:text-surface-500 hover:text-surface-700 dark:hover:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                        >
                            <MoreHorizontal size={16} />
                        </button>

                        {menuOpen && (
                            <div
                                ref={menuRef}
                                role="menu"
                                aria-label={`Actions for ${bot.name}`}
                                onClick={stop}
                                onKeyDown={handleMenuKeyDown}
                                className="absolute right-0 top-full mt-1.5 z-20 w-48 py-1.5 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 shadow-lg animate-scale-in origin-top-right"
                            >
                                <a
                                    role="menuitem"
                                    href={getBotPreviewUrl(bot.bot_key, bot.website)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() => setMenuOpen(false)}
                                    className="flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-surface-700 dark:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors focus:outline-none focus-visible:bg-surface-100 dark:focus-visible:bg-surface-800"
                                >
                                    <ExternalLink size={14} className="text-surface-400 dark:text-surface-500" /> View demo
                                </a>
                                <button
                                    role="menuitem"
                                    onClick={() => { setMenuOpen(false); onDemo(bot); }}
                                    className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-surface-700 dark:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors focus:outline-none focus-visible:bg-surface-100 dark:focus-visible:bg-surface-800"
                                >
                                    <Link2 size={14} className="text-surface-400 dark:text-surface-500" /> Copy demo link
                                </button>

                                {isBotManager && (
                                    <>
                                        <div className="my-1 border-t border-surface-100 dark:border-surface-800" />
                                        <button
                                            role="menuitem"
                                            onClick={startRename}
                                            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-surface-700 dark:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors focus:outline-none focus-visible:bg-surface-100 dark:focus-visible:bg-surface-800"
                                        >
                                            <Pencil size={14} className="text-surface-400 dark:text-surface-500" /> Rename
                                        </button>
                                        {confirmDelete ? (
                                            <div className="flex items-center justify-between gap-2 px-3.5 py-2">
                                                <span className="text-[11px] text-surface-500 dark:text-surface-400">Delete this bot?</span>
                                                <div className="flex items-center gap-1.5">
                                                    <button
                                                        onClick={handleDelete}
                                                        disabled={isDeleting}
                                                        aria-label="Confirm delete"
                                                        className="p-1 rounded-md bg-rose-500 text-white hover:bg-rose-600 dark:hover:bg-rose-400 transition-colors disabled:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                                                    >
                                                        {isDeleting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                                                    </button>
                                                    <button
                                                        onClick={() => setConfirmDelete(false)}
                                                        aria-label="Cancel delete"
                                                        className="p-1 rounded-md bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                                                    >
                                                        <X size={12} />
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <button
                                                role="menuitem"
                                                onClick={() => setConfirmDelete(true)}
                                                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors focus:outline-none focus-visible:bg-rose-50 dark:focus-visible:bg-rose-500/10"
                                            >
                                                <Trash2 size={14} /> Delete&hellip;
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
