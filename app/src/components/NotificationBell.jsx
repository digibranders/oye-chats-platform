/**
 * NotificationBell — bell icon + rich dropdown that lives in the TopBar.
 *
 * The bell is the persistent surface for in-app notifications. It shows:
 *
 *   - A bell with an unread count badge (capped at 99+).
 *   - A dropdown panel grouping notifications by recency (Today / Earlier).
 *   - Per-row icon + type-specific accent colour.
 *   - Click → mark read + navigate to the linked route.
 *   - "Mark all read" + "Clear all" footer actions.
 *
 * State comes from :mod:`context/NotificationContext.jsx`. The bell never
 * fetches directly so multiple instances can't fight over the same data.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
    Bell,
    BotIcon,
    CheckCheck,
    CreditCard,
    Headphones,
    Inbox,
    MailOpen,
    MessageSquare,
    Trash2,
    X,
} from 'lucide-react';

import { useNotifications } from '../context/NotificationContext';

const TYPE_META = {
    plan_purchased: {
        icon: CreditCard,
        ring: 'ring-emerald-500/30 dark:ring-emerald-400/30',
        wrap: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
        label: 'Billing',
    },
    bot_created: {
        icon: BotIcon,
        ring: 'ring-indigo-500/30 dark:ring-indigo-400/30',
        wrap: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400',
        label: 'Bot',
    },
    offline_message_received: {
        icon: MailOpen,
        ring: 'ring-amber-500/30 dark:ring-amber-400/30',
        wrap: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
        label: 'Message',
    },
    handoff_request: {
        icon: Headphones,
        ring: 'ring-rose-500/30 dark:ring-rose-400/30',
        wrap: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400',
        label: 'Live chat',
    },
    feedback_resolved: {
        icon: MessageSquare,
        ring: 'ring-emerald-500/30 dark:ring-emerald-400/30',
        wrap: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
        label: 'Feedback',
    },
};

const DEFAULT_META = {
    icon: Bell,
    ring: 'ring-surface-300/30',
    wrap: 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300',
    label: 'Notification',
};

function relativeTime(iso) {
    if (!iso) return '';
    try {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        const diff = (Date.now() - date.getTime()) / 1000;
        if (diff < 5) return 'just now';
        if (diff < 60) return `${Math.floor(diff)}s ago`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
        if (diff < 7 * 86_400) return `${Math.floor(diff / 86_400)}d ago`;
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
        return '';
    }
}

function isToday(iso) {
    if (!iso) return false;
    try {
        const d = new Date(iso);
        const now = new Date();
        return d.toDateString() === now.toDateString();
    } catch {
        return false;
    }
}

function NotificationRow({ item, onClick, onDismiss }) {
    const meta = TYPE_META[item.type] || DEFAULT_META;
    const Icon = meta.icon;
    return (
        <button
            type="button"
            onClick={onClick}
            className={`group relative w-full text-left flex gap-3 px-3 py-3 rounded-lg transition-colors hover:bg-slate-50 dark:hover:bg-[#15203E]/50 ${
                item.is_read ? '' : 'bg-primary-500/[0.04] dark:bg-primary-500/[0.08]'
            }`}
        >
            <span
                className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ring-1 ${meta.ring} ${meta.wrap}`}
            >
                <Icon size={16} />
            </span>
            <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-surface-400 dark:text-surface-500">
                        {meta.label}
                    </span>
                    {!item.is_read && (
                        <span className="w-1.5 h-1.5 rounded-full bg-primary-500" aria-label="unread" />
                    )}
                    <span className="ml-auto text-[11px] text-surface-400 dark:text-surface-500 opacity-100 group-hover:opacity-0 transition-opacity">
                        {relativeTime(item.created_at)}
                    </span>
                </span>
                <span className="block text-[13px] font-semibold text-surface-900 dark:text-surface-50 truncate">
                    {item.title}
                </span>
                {item.body && (
                    <span className="block text-[12px] text-surface-500 dark:text-surface-400 mt-0.5 line-clamp-2">
                        {item.body}
                    </span>
                )}
            </span>
            <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                    e.stopPropagation();
                    onDismiss(item.id);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        onDismiss(item.id);
                    }
                }}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-700"
                aria-label="Dismiss notification"
                title="Dismiss"
            >
                <X size={12} />
            </span>
        </button>
    );
}

export default function NotificationBell() {
    const { items, unreadCount, markRead, markAllRead, dismiss, clearAll } = useNotifications();
    const [open, setOpen] = useState(false);
    const navigate = useNavigate();
    const wrapRef = useRef(null);

    // Close on outside click and on Escape.
    useEffect(() => {
        if (!open) return undefined;
        const onClickOutside = (event) => {
            if (wrapRef.current && !wrapRef.current.contains(event.target)) {
                setOpen(false);
            }
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onClickOutside);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onClickOutside);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    const today = items.filter((item) => isToday(item.created_at));
    const earlier = items.filter((item) => !isToday(item.created_at));
    const badge = unreadCount > 99 ? '99+' : String(unreadCount);

    const handleRowClick = (item) => {
        if (!item.is_read) markRead(item.id);
        if (item.link) {
            setOpen(false);
            navigate(item.link);
        }
    };

    return (
        <div className="relative" ref={wrapRef}>
            <button
                onClick={() => setOpen((v) => !v)}
                className="relative p-2 rounded-lg text-surface-500 hover:text-surface-700 dark:hover:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                aria-label="Notifications"
                aria-expanded={open}
                title="Notifications"
            >
                <Bell size={18} />
                {unreadCount > 0 && (
                    <span
                        className="absolute top-0 right-0 min-w-[18px] h-[18px] px-1 rounded-full bg-primary-600 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white dark:ring-surface-950"
                        aria-label={`${unreadCount} unread`}
                    >
                        {badge}
                    </span>
                )}
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.97, y: 4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97, y: 4 }}
                        transition={{ duration: 0.12 }}
                        className="absolute right-0 mt-2.5 w-[360px] max-w-[calc(100vw-1.5rem)] bg-white dark:bg-[#0B1329] border border-slate-200 dark:border-[#1F2C47]/50 rounded-2xl shadow-2xl z-50"
                        role="dialog"
                        aria-label="Notifications"
                    >
                        {/* Top Indicator Arrow */}
                        <div 
                            className="absolute right-[11px] -top-1.5 w-0 h-0 text-white dark:text-[#0B1329] z-50 pointer-events-none"
                            style={{
                                borderLeft: '6px solid transparent',
                                borderRight: '6px solid transparent',
                                borderBottom: '6px solid currentColor'
                            }}
                        />

                        <div className="flex flex-col overflow-hidden rounded-2xl">
                            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800/60 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center shrink-0 border border-indigo-100/10 dark:border-indigo-500/20">
                                        <Bell size={18} className="text-indigo-600 dark:text-[#818CF8]" />
                                    </div>
                                    <div className="flex flex-col justify-center">
                                        <p className="text-[15px] font-bold text-surface-900 dark:text-white leading-tight">
                                            Notifications
                                        </p>
                                        <p className="text-[12px] text-surface-400 dark:text-[#8F9BB3] mt-0.5 leading-none">
                                            {unreadCount > 0 ? `${unreadCount} unread` : "You're all caught up"}
                                        </p>
                                    </div>
                                </div>
                                {items.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={markAllRead}
                                        disabled={unreadCount === 0}
                                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <CheckCheck size={12} />
                                        Mark all read
                                    </button>
                                )}
                            </div>

                            <div className="max-h-[420px] overflow-y-auto p-1.5 bg-white dark:bg-[#0B1329]">
                                {items.length === 0 ? (
                                    <div className="px-6 py-12 flex flex-col justify-center">
                                        {/* Custom Open Box & Paper Airplane SVG */}
                                        <svg className="w-40 h-28 mx-auto mb-5 select-none pointer-events-none" viewBox="0 0 160 110" fill="none">
                                            <defs>
                                                <filter id="shadow-blur">
                                                    <feGaussianBlur stdDeviation="3" />
                                                </filter>
                                            </defs>
                                            
                                            {/* Drop Shadow */}
                                            <ellipse cx="80" cy="98" rx="28" ry="8" fill="#000000" fillOpacity="0.3" filter="url(#shadow-blur)" />
                                            
                                            {/* Sparkles / Stars */}
                                            <path d="M55,46 Q55,52 49,52 Q55,52 55,58 Q55,52 61,52 Q55,52 55,46 Z" fill="#6366F1" />
                                            <circle cx="68" cy="42" r="1.5" fill="#818CF8" />
                                            <circle cx="81" cy="48" r="1.5" fill="#818CF8" opacity="0.8" />
                                            <circle cx="106" cy="35" r="1.5" fill="#818CF8" opacity="0.6" />

                                            {/* Inside Back Left Wall */}
                                            <polygon points="50,68 80,53 80,75 50,90" fill="#0F162B" />
                                            {/* Inside Back Right Wall */}
                                            <polygon points="80,53 110,68 110,90 80,75" fill="#161E38" />

                                            {/* Flap Back Left (folding out/up) */}
                                            <polygon points="50,68 80,53 65,45 35,60" fill="#202A54" />
                                            {/* Flap Back Right (folding out/up) */}
                                            <polygon points="80,53 110,68 125,60 95,45" fill="#283568" />

                                            {/* Curved dotted flight path */}
                                            <path d="M80,72 C88,77 101,70 102,56 C103,46 95,43 100,31" stroke="#6366F1" strokeWidth="1.5" strokeDasharray="3 3" strokeLinecap="round" opacity="0.8" />

                                            {/* Box Left Side Outer */}
                                            <polygon points="50,68 80,83 80,105 50,90" fill="#1B2544" />
                                            {/* Box Right Side Outer */}
                                            <polygon points="80,83 110,68 110,90 80,105" fill="#252F5A" />

                                            {/* Flap Front Left (folding out/down) */}
                                            <polygon points="50,68 80,83 65,91 35,76" fill="#3D4B84" />
                                            {/* Flap Front Right (folding out/down) */}
                                            <polygon points="80,83 110,68 125,76 95,91" fill="#313E75" />

                                            {/* Paper Airplane (Launching) */}
                                            <g transform="translate(96, 20) rotate(-10)">
                                                <path d="M0,8 L16,0 L11,14 L8,9 Z" fill="#6366F1" />
                                                <path d="M8,9 L11,14 L11,9 Z" fill="#4F46E5" />
                                            </g>
                                        </svg>
                                        <p className="text-[16px] font-bold text-surface-900 dark:text-white mb-2 text-center">
                                            Nothing new yet
                                        </p>
                                        <p className="text-[13px] text-slate-500 dark:text-[#8F9BB3] text-center leading-relaxed max-w-[240px] mx-auto">
                                            Plan, bot, and live-chat events<br />will land here.
                                        </p>
                                    </div>
                                ) : (
                                    <>
                                        {today.length > 0 && (
                                            <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-surface-400">
                                                Today
                                            </div>
                                        )}
                                        {today.map((item) => (
                                            <NotificationRow
                                                key={item.id}
                                                item={item}
                                                onClick={() => handleRowClick(item)}
                                                onDismiss={dismiss}
                                            />
                                        ))}
                                        {earlier.length > 0 && (
                                            <div className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-surface-400">
                                                Earlier
                                            </div>
                                        )}
                                        {earlier.map((item) => (
                                            <NotificationRow
                                                key={item.id}
                                                item={item}
                                                onClick={() => handleRowClick(item)}
                                                onDismiss={dismiss}
                                            />
                                        ))}
                                    </>
                                )}
                            </div>

                            {items.length > 0 && (
                                <div className="px-3 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end bg-white dark:bg-[#0B1329]">
                                    <button
                                        type="button"
                                        onClick={clearAll}
                                        className="inline-flex items-center gap-1 text-[11px] font-medium text-surface-500 hover:text-rose-600 dark:hover:text-rose-400 transition-colors"
                                    >
                                        <Trash2 size={12} />
                                        Clear all
                                    </button>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
