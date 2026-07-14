import { motion } from 'framer-motion';
import { Sparkles, Send } from 'lucide-react';
import { useBotContext } from '../../context/BotContext';
import Badge from '../../components/ui/Badge';

const EASE = [0.16, 1, 0.3, 1];

/**
 * A faithful preview of the customer's chat widget that "comes alive" as the
 * agent is built — the emotional core of the guided flow. Before a bot exists
 * it shows a calm empty state; once created it renders a real chat-window mock
 * in the bot's own brand colour with its greeting.
 */
export default function LiveAgentPreview({ previewColor }) {
    const { selectedBot } = useBotContext();
    const brand = previewColor || selectedBot?.primary_color || '#d946ef';
    const name = selectedBot?.launcher_name || selectedBot?.name || 'Your agent';
    const initial = (name.trim()[0] || 'A').toUpperCase();
    const greeting = selectedBot?.widget_welcome_message || `Hi! I'm ${name} 👋 How can I help you today?`;

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">Live preview</span>
                {selectedBot ? (
                    <Badge variant="soft" color="default" size="sm">
                        Not live yet
                    </Badge>
                ) : null}
            </div>

            <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: EASE }}
                className="flex-1 w-full max-w-sm mx-auto rounded-[22px] border border-[var(--border)] bg-[var(--bg-card)] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.25)] overflow-hidden flex flex-col"
            >
                {/* Widget header — brand coloured */}
                <div className="px-4 py-3.5 flex items-center gap-2.5 text-white" style={{ backgroundColor: brand }}>
                    <div className="w-8 h-8 rounded-xl bg-white/25 grid place-items-center text-sm font-semibold">{initial}</div>
                    <div className="leading-tight">
                        <div className="font-semibold text-sm">{name}</div>
                        <div className="text-[11px] text-white/80 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-300" /> Online
                        </div>
                    </div>
                </div>

                {/* Message area */}
                <div className="flex-1 min-h-[240px] px-4 py-4 flex flex-col gap-2.5 bg-[var(--bg-muted)]/50">
                    {selectedBot ? (
                        <>
                            <motion.div
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.4, ease: EASE }}
                                className="self-start max-w-[85%] rounded-2xl rounded-tl-md bg-[var(--bg-card)] border border-[var(--border)] px-3.5 py-2.5 text-sm text-[var(--text)] shadow-sm"
                            >
                                {greeting}
                            </motion.div>
                            <div className="flex flex-wrap gap-1.5 mt-1">
                                {['See pricing', 'Book a demo', 'Contact us'].map((c) => (
                                    <span
                                        key={c}
                                        className="text-xs px-2.5 py-1 rounded-full border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-secondary)]"
                                    >
                                        {c}
                                    </span>
                                ))}
                            </div>
                        </>
                    ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 py-8">
                            <motion.div
                                initial={{ scale: 0.85, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
                                className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary-100 to-primary-50 dark:from-primary-900/30 dark:to-primary-800/20 grid place-items-center"
                            >
                                <Sparkles size={24} className="text-primary-500 dark:text-primary-400" />
                            </motion.div>
                            <p className="text-sm text-[var(--text-muted)] max-w-[22ch]">
                                Your agent will appear here as you build it.
                            </p>
                        </div>
                    )}
                </div>

                {/* Composer (visual only) */}
                <div className="px-3 py-2.5 border-t border-[var(--border)] bg-[var(--bg-card)]">
                    <div className="h-9 rounded-xl bg-[var(--bg-muted)] border border-[var(--border)] flex items-center justify-between pl-3.5 pr-1.5 text-xs text-[var(--text-muted)]">
                        Ask me anything…
                        <span className="w-7 h-7 rounded-lg grid place-items-center text-white" style={{ backgroundColor: brand }}>
                            <Send size={13} />
                        </span>
                    </div>
                </div>
            </motion.div>
        </div>
    );
}
