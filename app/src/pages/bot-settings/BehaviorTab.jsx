import {
    Paperclip, ThumbsUp, Tag, ListOrdered, MessageCircle, FileText, Lock, Settings2,
} from 'lucide-react';
import AdvancedSettingsTab from './AdvancedSettingsTab';

const SECTION_HEADER_BASE = 'text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2';
const SECTION_SUBTITLE = 'text-[13px] text-surface-500 dark:text-surface-400 mt-0.5';

// Widget behavior feature flags. Keys match the `Bot.feature_flags` JSON
// (api/app/db/models.py) and their model defaults.
const FEATURE_FLAGS = [
    { key: 'file_sharing', label: 'File Sharing', desc: 'Let visitors attach files in the chat.', icon: Paperclip, default: false },
    { key: 'post_chat_rating', label: 'Post-Chat Rating Survey', desc: 'Ask visitors to rate the conversation when it ends.', icon: ThumbsUp, default: true },
    { key: 'show_branding', label: 'Show "Powered by" Branding', desc: 'Display the branding footer in the widget.', icon: Tag, default: true },
    { key: 'queue_position', label: 'Queue Position Indicator', desc: 'Show visitors their place in the live-chat queue.', icon: ListOrdered, default: false },
    { key: 'typing_preview', label: 'Typing Preview', desc: 'Show a typing indicator while the bot or operator replies.', icon: MessageCircle, default: true },
    { key: 'email_transcript', label: 'Email Transcript', desc: 'Offer visitors an emailed copy of the chat transcript.', icon: FileText, default: false },
];

/**
 * BehaviorTab — widget behavior toggles + advanced power-user knobs.
 *
 * The feature-flags section is fully locked on the Free plan (mirrors the
 * server-side override in `api/app/api/bot_routes.py`, which force-resets
 * `feature_flags` to the Free defaults regardless of what's stored). Paid
 * plans get the toggles, except "Show 'Powered by' Branding", which stays
 * locked on until the plan includes `branding_removable` (Starter doesn't;
 * Standard+ does). The advanced knobs (timeouts, frustration thresholds,
 * reconnection — the existing `AdvancedSettingsTab`) are gated separately.
 *
 * @param {object} props
 * @param {object} props.draft - Editable bot fields.
 * @param {(field: string, value: unknown) => void} props.set - Single-field updater.
 * @param {object} props.ent - Plan entitlements (from `useEntitlements`).
 * @param {boolean} props.advancedLocked - Whether the advanced section is locked (Free plan).
 * @param {(intent: string) => void} props.requestUpgrade - Opens the upgrade modal.
 */
export default function BehaviorTab({ draft, set, ent, advancedLocked, requestUpgrade }) {
    const flags = draft.feature_flags || {};

    // Free plan: the entire Widget Behavior section is paid-gated. Mirrors
    // `api/app/api/bot_routes.py`, which overrides `feature_flags` with the
    // Free-plan locked values (file_sharing/post_chat_rating/etc. off,
    // show_branding always on) server-side regardless of stored state.
    const behaviorLocked = Boolean(ent?.isFree);

    // Free AND Starter plans can't remove the "Powered by" branding footer —
    // only plans with `branding_removable` may turn this toggle off. Mirrors
    // the server-side enforcement in `api/app/api/bot_routes.py`
    // (`_plan_branding_removable`), which forces `show_branding: true` for
    // any plan lacking the entitlement regardless of the stored flag value.
    const brandingLocked = !(ent?.hasFeature?.('branding_removable'));

    const toggleFlag = (key, value) => {
        if (key === 'show_branding' && brandingLocked) {
            requestUpgrade?.('branding_removable');
            return;
        }
        set('feature_flags', { ...flags, [key]: value });
    };

    // Adapt AdvancedSettingsTab's legacy `{ settings, onSettingsChange }`
    // contract to the draft/set surface.
    const advancedSettings = {
        widget_config: draft.widget_config,
        relevance_threshold: draft.relevance_threshold,
    };
    const advancedOnChange = (updates) => {
        Object.entries(updates).forEach(([key, value]) => set(key, value));
    };

    return (
        <div className="space-y-6 animate-fade-in">
            {/* ── Feature Flags (paid-gated on Free plan) ── */}
            <div>
                <h3 className={SECTION_HEADER_BASE}>
                    <Settings2 className="w-4 h-4 text-primary-500" />
                    Widget Behavior
                    {behaviorLocked && (
                        <span className="inline-flex h-[18px] items-center gap-1 rounded-md bg-amber-100 px-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
                            <Lock size={10} strokeWidth={2.6} /> Paid
                        </span>
                    )}
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Toggle widget features on or off for this bot.
                </p>
            </div>

            {behaviorLocked ? (
                <div className="relative rounded-2xl border border-dashed border-surface-200 dark:border-surface-700 bg-surface-50/60 dark:bg-surface-800/40 p-8 text-center">
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
                        <Lock size={20} strokeWidth={2.2} />
                    </div>
                    <h4 className="text-[15px] font-bold text-surface-900 dark:text-surface-100">Widget behavior toggles are a paid feature</h4>
                    <p className="mx-auto mt-1 max-w-md text-[13px] text-surface-500 dark:text-surface-400">
                        Upgrade to control file sharing, post-chat ratings, the queue indicator, typing preview, and email transcripts for this bot.
                    </p>
                    <button
                        type="button"
                        onClick={() => requestUpgrade('widget_behavior')}
                        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary-600 px-4 h-10 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-700"
                    >
                        Upgrade to unlock
                    </button>
                </div>
            ) : (
                <div className="bg-white dark:bg-surface-900 p-2 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm divide-y divide-surface-100 dark:divide-surface-800">
                    {FEATURE_FLAGS.map((flag) => {
                        const { key, label, desc, default: dflt } = flag;
                        const FlagIcon = flag.icon;
                        const locked = key === 'show_branding' && brandingLocked;
                        const checked = locked ? true : (flags[key] ?? dflt);
                        return (
                            <div
                                key={key}
                                className={`flex items-center justify-between gap-4 p-3 ${locked ? 'cursor-pointer' : ''}`}
                                onClick={locked ? () => requestUpgrade?.('branding_removable') : undefined}
                            >
                                <div className="flex items-start gap-3 min-w-0">
                                    <div className="w-8 h-8 rounded-lg bg-surface-100 dark:bg-surface-800 flex items-center justify-center flex-shrink-0 text-primary-500">
                                        <FlagIcon className="w-4 h-4" />
                                    </div>
                                    <div className="min-w-0">
                                        <h4 className="text-[14px] font-semibold text-surface-900 dark:text-surface-100 flex items-center gap-1.5">
                                            {label}
                                            {locked && (
                                                <span className="inline-flex h-[18px] items-center gap-1 rounded-md bg-amber-100 px-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
                                                    <Lock size={10} strokeWidth={2.6} /> Paid
                                                </span>
                                            )}
                                        </h4>
                                        <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-0.5">{desc}</p>
                                    </div>
                                </div>
                                <label className={`relative inline-flex items-center flex-shrink-0 ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                                    <input
                                        type="checkbox"
                                        className="sr-only peer"
                                        checked={Boolean(checked)}
                                        disabled={locked}
                                        onChange={(e) => toggleFlag(key, e.target.checked)}
                                    />
                                    <div className={`w-11 h-6 bg-surface-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-surface-300 dark:after:border-surface-600 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600 ${locked ? 'opacity-60' : ''}`}></div>
                                </label>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* ── Advanced Settings (paid-gated section) ── */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <Settings2 className="w-4 h-4 text-primary-500" />
                    Advanced Settings
                    {advancedLocked && (
                        <span className="inline-flex h-[18px] items-center gap-1 rounded-md bg-amber-100 px-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
                            <Lock size={10} strokeWidth={2.6} /> Paid
                        </span>
                    )}
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Power-user knobs: scope strictness, animation timing, frustration detection, and reconnection.
                </p>
            </div>

            {advancedLocked ? (
                <div className="relative rounded-2xl border border-dashed border-surface-200 dark:border-surface-700 bg-surface-50/60 dark:bg-surface-800/40 p-8 text-center">
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
                        <Lock size={20} strokeWidth={2.2} />
                    </div>
                    <h4 className="text-[15px] font-bold text-surface-900 dark:text-surface-100">Advanced settings are a paid feature</h4>
                    <p className="mx-auto mt-1 max-w-md text-[13px] text-surface-500 dark:text-surface-400">
                        Upgrade to fine-tune scope strictness, welcome-screen timing, frustration detection, and WebSocket reconnection behavior.
                    </p>
                    <button
                        type="button"
                        onClick={() => requestUpgrade('advanced_settings')}
                        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary-600 px-4 h-10 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-700"
                    >
                        Upgrade to unlock
                    </button>
                </div>
            ) : (
                <AdvancedSettingsTab settings={advancedSettings} onSettingsChange={advancedOnChange} />
            )}
        </div>
    );
}
