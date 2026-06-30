/**
 * LiveChatRequestBanner — compact toast notification that slides in from the
 * top-right when a visitor presses "Talk to a human".
 *
 * Surfaces on every authenticated page so the operator never misses an
 * incoming request. The persistent feed in the bell is unaffected — the
 * operator can still see the request there after dismissing the toast.
 *
 * On "Open chat" → navigate to ``/support?session=<id>`` so the live-chat
 * console opens directly to the requesting visitor.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { MessageSquareText, X } from 'lucide-react';

import { useNotifications } from '../context/NotificationContext';

// Auto-dismiss timeout. Long enough to not be missed, short enough that
// stacking handoffs don't pile up behind a stale card.
const AUTO_DISMISS_MS = 30_000;

// Countdown bar duration matches the auto-dismiss timer.
const COUNTDOWN_S = AUTO_DISMISS_MS / 1000;

export default function LiveChatRequestBanner() {
    const { incomingHandoff, dismissIncomingHandoff, markRead } = useNotifications();
    const navigate = useNavigate();
    const [hovered, setHovered] = useState(false);

    const visible = Boolean(incomingHandoff);

    useEffect(() => {
        if (!visible) return undefined;
        const timer = setTimeout(() => dismissIncomingHandoff(), AUTO_DISMISS_MS);
        return () => clearTimeout(timer);
    }, [visible, dismissIncomingHandoff]);

    const handleAccept = () => {
        if (!incomingHandoff) return;
        const sessionId = incomingHandoff?.data?.session_id;
        if (incomingHandoff.id && !incomingHandoff.is_read) markRead(incomingHandoff.id);
        dismissIncomingHandoff();
        navigate(sessionId ? `/support?session=${encodeURIComponent(sessionId)}` : '/support');
    };

    const botName = incomingHandoff?.data?.bot_name || null;

    return (
        <AnimatePresence>
            {visible && (
                <motion.div
                    initial={{ opacity: 0, x: 40, scale: 0.95 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: 30, scale: 0.96 }}
                    transition={{
                        type: 'spring',
                        stiffness: 400,
                        damping: 28,
                        mass: 0.8,
                    }}
                    role="alert"
                    aria-live="assertive"
                    onMouseEnter={() => setHovered(true)}
                    onMouseLeave={() => setHovered(false)}
                    className="fixed top-[72px] right-4 md:right-5 z-[60] w-[320px] max-w-[calc(100vw-2rem)]"
                    style={{ willChange: 'transform, opacity' }}
                >
                    {/* Outer glow */}
                    <motion.div
                        className="absolute -inset-1 rounded-2xl opacity-40 blur-xl pointer-events-none"
                        style={{ background: 'linear-gradient(135deg, #6366f1, #818cf8, #6366f1)' }}
                        animate={{ opacity: hovered ? 0.55 : 0.3 }}
                        transition={{ duration: 0.3 }}
                    />

                    {/* Card body */}
                    <div
                        className="relative rounded-2xl overflow-hidden backdrop-blur-xl"
                        style={{
                            background: 'linear-gradient(145deg, rgba(15, 23, 42, 0.95), rgba(15, 20, 50, 0.97))',
                            border: '1px solid rgba(99, 102, 241, 0.2)',
                            boxShadow: '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
                        }}
                    >
                        {/* Countdown bar */}
                        <motion.div
                            className="h-[2px] rounded-full"
                            style={{
                                background: 'linear-gradient(90deg, #6366f1, #a78bfa)',
                                transformOrigin: 'left',
                            }}
                            initial={{ scaleX: 1 }}
                            animate={{ scaleX: 0 }}
                            transition={{ duration: COUNTDOWN_S, ease: 'linear' }}
                        />

                        <div className="px-3.5 py-3">
                            {/* Top row: dot + label + dismiss */}
                            <div className="flex items-center gap-2 mb-2.5">
                                {/* Pulsing dot */}
                                <span className="relative flex h-2 w-2">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                                </span>
                                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-400">
                                    Live request
                                </span>
                                <button
                                    type="button"
                                    onClick={dismissIncomingHandoff}
                                    aria-label="Dismiss"
                                    className="ml-auto p-0.5 rounded text-white/30 hover:text-white/70 transition-colors"
                                >
                                    <X size={13} />
                                </button>
                            </div>

                            {/* Message */}
                            <p className="text-[13px] font-medium text-white/90 leading-snug mb-0.5">
                                A visitor wants to talk to a human
                            </p>
                            {botName && (
                                <p className="text-[11px] text-white/40 mb-3">
                                    via {botName}
                                </p>
                            )}
                            {!botName && <div className="mb-2.5" />}

                            {/* Actions */}
                            <div className="flex items-center gap-2">
                                <motion.button
                                    type="button"
                                    onClick={handleAccept}
                                    whileHover={{ scale: 1.02 }}
                                    whileTap={{ scale: 0.97 }}
                                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-[7px] rounded-lg text-[12px] font-semibold text-white transition-all focus:outline-none focus:ring-2 focus:ring-primary-400/50"
                                    style={{
                                        background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                                        boxShadow: '0 2px 12px rgba(99, 102, 241, 0.35)',
                                    }}
                                >
                                    <MessageSquareText size={13} />
                                    Open chat
                                </motion.button>
                                <motion.button
                                    type="button"
                                    onClick={dismissIncomingHandoff}
                                    whileHover={{ scale: 1.02 }}
                                    whileTap={{ scale: 0.97 }}
                                    className="px-3 py-[7px] rounded-lg text-[12px] font-medium text-white/50 hover:text-white/80 border border-white/10 hover:border-white/20 hover:bg-white/5 transition-all"
                                >
                                    Later
                                </motion.button>
                            </div>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
