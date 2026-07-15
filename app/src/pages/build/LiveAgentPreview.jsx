import { motion } from 'framer-motion';
import { MessageCircle } from 'lucide-react';
import { useBotContext } from '../../context/BotContext';
import Badge from '../../components/ui/Badge';
import WidgetChatPreview from '../../components/WidgetChatPreview';

const EASE = [0.16, 1, 0.3, 1];

function hostOf(url) {
    try {
        return new URL((url || '').startsWith('http') ? url : `https://${url}`).host;
    } catch {
        return '';
    }
}

// A faint mock of the customer's own web page, behind the widget — so the
// preview reads as "your widget, live on your site" rather than a bare card.
function PageSkeleton() {
    return (
        <div aria-hidden="true" className="absolute inset-0 px-5 pt-5 pointer-events-none opacity-60">
            <div className="h-3.5 w-20 rounded bg-[var(--border)] mb-5" />
            <div className="h-20 rounded-xl bg-[var(--border)]/70 mb-4" />
            <div className="h-2.5 w-3/4 rounded bg-[var(--border)] mb-2.5" />
            <div className="h-2.5 w-2/3 rounded bg-[var(--border)] mb-2.5" />
            <div className="h-2.5 w-1/2 rounded bg-[var(--border)]" />
        </div>
    );
}

// The chrome of a browser window — traffic-light dots + an address bar showing
// the customer's domain (placeholder until Connect captures it).
function BrowserFrame({ domain, children }) {
    return (
        <div className="w-full rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] shadow-[0_20px_50px_-24px_rgba(0,0,0,0.35)] overflow-hidden">
            <div className="flex items-center gap-2 px-3 h-9 border-b border-[var(--border)] bg-[var(--bg-muted)]/50">
                <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
                    <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
                    <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
                </div>
                <div className="flex-1 mx-2 h-5 rounded-md bg-[var(--bg-card)] border border-[var(--border)] flex items-center px-2.5">
                    <span className="text-[10px] text-[var(--text-muted)] font-mono truncate">{domain}</span>
                </div>
            </div>
            <div className="relative min-h-[440px] bg-[var(--bg-muted)]/25">
                <PageSkeleton />
                <div className="relative flex justify-end items-end min-h-[440px] p-3">{children}</div>
            </div>
        </div>
    );
}

/**
 * Map a bot record (from `useBotContext`) into the settings shape
 * `WidgetChatPreview` expects. Defaults mirror BotSettings' `DEFAULT_DRAFT` so a
 * freshly-created bot missing a field previews exactly as it will in Bot
 * Settings. `previewColor`, when set by the Appearance step, live-recolours the
 * brand (both primary and header, matching the Bot Settings preview payload).
 */
function botToPreviewSettings(bot, previewColor) {
    const primary = previewColor || bot?.primary_color || '#ba68c8';
    return {
        bot_name: bot?.name || 'AI Assistant',
        bot_logo: bot?.bot_logo || null,
        avatar_type: bot?.avatar_type || 'upload',
        orb_color: bot?.orb_color || '',
        primary_color: primary,
        header_color: primary,
        welcome_title: bot?.welcome_title || 'Hi there 👋',
        welcome_subtitle: bot?.welcome_subtitle || 'How can we help you today?',
        waiting_message: bot?.waiting_message || 'Connecting you to support...',
        offline_message: bot?.offline_message || "We'll be right back! Leave a message and we'll follow up shortly.",
        live_chat_enabled: bot?.live_chat_enabled ?? true,
        meeting_booking_enabled: bot?.meeting_booking_enabled ?? false,
        widget_messages: bot?.widget_messages || {},
        feature_flags: bot?.feature_flags || {},
        branding_text: bot?.branding_text || 'Powered by OyeChats',
    };
}

/**
 * A faithful preview of the customer's chat widget that "comes alive" as the
 * agent is built — the emotional core of the guided flow. Before a bot exists
 * it shows a calm empty state; once created it renders the shared
 * `WidgetChatPreview` (the exact same mock Bot Settings shows) in the bot's own
 * brand colour, so the Studio preview is pixel-identical to Bot Settings and the
 * real widget. The Appearance step's `previewColor` live-recolours it.
 */
export default function LiveAgentPreview({ previewColor, messages = [], pending = false }) {
    const { selectedBot } = useBotContext();

    const domain = hostOf(selectedBot?.website) || 'your-site.com';

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">Live preview</span>
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
            >
                <BrowserFrame domain={domain}>
                    {selectedBot ? (
                        <WidgetChatPreview
                            settings={botToPreviewSettings(selectedBot, previewColor)}
                            state="chat"
                            messages={messages}
                            pending={pending}
                            className="max-w-[340px]"
                        />
                    ) : (
                        // No bot yet (Connect step): show the closed launcher on the
                        // page, as it would appear before a visitor opens it.
                        <div className="flex flex-col items-end gap-2">
                            <span className="text-[11px] text-[var(--text-muted)] mr-1">Your agent will appear here</span>
                            <div className="w-14 h-14 rounded-full grid place-items-center text-white shadow-lg bg-primary-500">
                                <MessageCircle size={24} />
                            </div>
                        </div>
                    )}
                </BrowserFrame>
            </motion.div>
        </div>
    );
}
