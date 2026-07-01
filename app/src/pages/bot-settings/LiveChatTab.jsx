import { Settings2, Bot, Sparkles, ChevronDown, Users } from 'lucide-react';

/**
 * LiveChatTab — live-chat handoff configuration.
 *
 * Enable toggle, widget welcome copy, the waiting / handoff-delay / offline
 * states, and the live-chat **queue** settings (timeout + max size) absorbed
 * from the old Settings "Live Chat Queue" (sub-project 1 gap closure). The
 * whole tab is paid; the shell only renders it when the plan is unlocked.
 *
 * @param {{ draft: object, set: (field: string, value: unknown) => void }} props
 */
export default function LiveChatTab({ draft, set }) {
    return (
        <div className="space-y-6 animate-fade-in">
            {/* Master Toggle */}
            <div>
                <h3 className="text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <Settings2 className="w-4 h-4 text-primary-500" />
                    Live Chat
                </h3>
                <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">
                    Allow visitors to request a live operator during a chat session.
                </p>
            </div>
            <div className="bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm flex items-center justify-between">
                <div>
                    <h4 className="text-[14px] font-semibold text-surface-900 dark:text-surface-100">Enable Live Chat</h4>
                    <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-1">Show &quot;Talk to a human&quot; button in the widget.</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" checked={draft.live_chat_enabled} onChange={(e) => set('live_chat_enabled', e.target.checked)} />
                    <div className="w-11 h-6 bg-surface-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-surface-300 dark:after:border-surface-600 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
                </label>
            </div>

            {/* Widget Messages */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className="text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <Bot className="w-4 h-4 text-primary-500" />
                    Widget Messages
                </h3>
                <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">
                    Customize the text visitors see when they open the chat.
                </p>
            </div>
            <div className="bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm space-y-4">
                <div className="space-y-2">
                    <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">Welcome Title</label>
                    <input
                        type="text"
                        value={draft.welcome_title}
                        onChange={(e) => set('welcome_title', e.target.value)}
                        maxLength={80}
                        placeholder="Hi there 👋"
                        className="w-full h-10 px-3 text-sm text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:placeholder:text-surface-500"
                    />
                    <p className="text-[11px] text-surface-400">Main heading shown on the welcome screen.</p>
                </div>
                <div className="space-y-2">
                    <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">Welcome Subtitle</label>
                    <input
                        type="text"
                        value={draft.welcome_subtitle}
                        onChange={(e) => set('welcome_subtitle', e.target.value)}
                        maxLength={120}
                        placeholder="How can we help you today?"
                        className="w-full h-10 px-3 text-sm text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:placeholder:text-surface-500"
                    />
                    <p className="text-[11px] text-surface-400">Subtitle shown below the welcome title.</p>
                </div>
            </div>

            {/* What happens when... */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className="text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary-500" />
                    What happens when…
                </h3>
                <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">
                    Configure what visitors see in each availability state.
                </p>
            </div>

            {/* Waiting state */}
            <div className="bg-white dark:bg-surface-900 p-6 rounded-xl border border-surface-200 dark:border-white/[0.06] shadow-sm dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] space-y-5">
                <div>
                    <h4 className="text-[13px] font-semibold tracking-[-0.01em] text-surface-900 dark:text-white">Visitor requests live chat</h4>
                    <p className="text-[12.5px] leading-relaxed text-surface-500 dark:text-surface-400 mt-1">Shown while the visitor waits for an operator to accept.</p>
                </div>
                <div className="space-y-1.5">
                    <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-surface-500 dark:text-surface-400">Waiting Message</label>
                    <input
                        type="text"
                        value={draft.waiting_message}
                        onChange={(e) => set('waiting_message', e.target.value)}
                        maxLength={200}
                        placeholder="Connecting you to support..."
                        className="w-full h-10 px-3 text-sm text-surface-700 dark:text-surface-200 bg-surface-50 dark:bg-white/[0.025] border border-surface-200 dark:border-white/[0.06] rounded-lg placeholder:text-surface-400 dark:placeholder:text-surface-500 transition-shadow focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
                    />
                </div>
                <div className="space-y-1.5">
                    <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-surface-500 dark:text-surface-400">Handoff Delay</label>
                    <p className="text-[11.5px] text-surface-400 dark:text-surface-500">Time before the handoff form appears after the bot suggests live chat.</p>
                    <div className="relative">
                        <select
                            value={draft.handoff_delay_seconds}
                            onChange={(e) => set('handoff_delay_seconds', Number(e.target.value))}
                            className="appearance-none w-full h-10 pl-3 pr-9 text-sm text-surface-700 dark:text-surface-200 bg-surface-50 dark:bg-white/[0.025] border border-surface-200 dark:border-white/[0.06] rounded-lg transition-shadow focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
                        >
                            <option value={0}>Immediately</option>
                            <option value={2}>After 2 seconds</option>
                            <option value={5}>After 5 seconds</option>
                            <option value={10}>After 10 seconds</option>
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 dark:text-surface-500" />
                    </div>
                </div>
            </div>

            {/* Offline / unavailable state */}
            <div className="bg-white dark:bg-surface-900 p-6 rounded-xl border border-surface-200 dark:border-white/[0.06] shadow-sm dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] space-y-5">
                <div>
                    <h4 className="text-[13px] font-semibold tracking-[-0.01em] text-surface-900 dark:text-white">No operators are available</h4>
                    <p className="text-[12.5px] leading-relaxed text-surface-500 dark:text-surface-400 mt-1">Shown when live chat is off or all operators are offline.</p>
                </div>
                <div className="space-y-1.5">
                    <label className="text-[11px] font-medium uppercase tracking-[0.04em] text-surface-500 dark:text-surface-400">Offline / Unavailable Message</label>
                    <input
                        type="text"
                        value={draft.offline_message}
                        onChange={(e) => set('offline_message', e.target.value)}
                        maxLength={200}
                        placeholder="We'll be right back! Leave a message and we'll follow up shortly."
                        className="w-full h-10 px-3 text-sm text-surface-700 dark:text-surface-200 bg-surface-50 dark:bg-white/[0.025] border border-surface-200 dark:border-white/[0.06] rounded-lg placeholder:text-surface-400 dark:placeholder:text-surface-500 transition-shadow focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
                    />
                </div>
            </div>

            {/* Queue settings (absorbed from old Settings "Live Chat Queue") */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className="text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <Users className="w-4 h-4 text-primary-500" />
                    Queue Settings
                </h3>
                <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">
                    Control how visitors are queued when all operators are busy.
                </p>
            </div>
            <div className="bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm space-y-4">
                <div className="space-y-2">
                    <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">Queue Timeout (seconds)</label>
                    <input
                        type="number"
                        min={5}
                        max={600}
                        step={5}
                        value={draft.live_chat_queue_timeout_seconds}
                        onChange={(e) => set('live_chat_queue_timeout_seconds', Number(e.target.value))}
                        placeholder="20"
                        className="w-full h-10 px-3 text-sm text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:placeholder:text-surface-500"
                    />
                    <p className="text-[11px] text-surface-400">How long a visitor waits for an operator before timing out (20 seconds default).</p>
                </div>
                <div className="space-y-2">
                    <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">Max Queue Size</label>
                    <input
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        value={draft.live_chat_max_queue_size}
                        onChange={(e) => set('live_chat_max_queue_size', Number(e.target.value))}
                        placeholder="10"
                        className="w-full h-10 px-3 text-sm text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:placeholder:text-surface-500"
                    />
                    <p className="text-[11px] text-surface-400">Maximum number of visitors that can wait in the live-chat queue at once (10 default).</p>
                </div>
            </div>
        </div>
    );
}
