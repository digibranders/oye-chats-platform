import { Sparkles, MessageSquareText, Building2 } from 'lucide-react';

const SECTION_HEADER_BASE = 'text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2';
const SECTION_SUBTITLE = 'text-[13px] text-surface-500 dark:text-surface-400 mt-0.5';
const CARD = 'bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm space-y-4';
const FIELD_LABEL = 'text-[13px] font-bold text-surface-700 dark:text-surface-300';
const FIELD_INPUT = 'w-full h-10 px-3 text-sm text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:placeholder:text-surface-500';
const FIELD_TEXTAREA = 'w-full px-3 py-2.5 text-sm text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:placeholder:text-surface-500 resize-y';
const FIELD_HELP = 'text-[11px] text-surface-400';

// Mirror the backend field length caps (api/app/api/bot_routes.py UpdateBotRequest)
// so the UI rejects over-long input before the save round-trip.
const MAX_SYSTEM_PROMPT = 2000;
const MAX_BRAND_TONE = 500;
const MAX_COMPANY_NAME = 100;
const MAX_COMPANY_DESCRIPTION = 1000;

/**
 * PersonalityTab — AI personality + company identity.
 *
 * Absorbs the configs orphaned from the old Settings "Tone & Personality"
 * section (sub-project 1): the bot's custom system prompt, brand tone/voice,
 * and company name + description. All four bind to existing `Bot` model fields
 * and persist via the standard bot-update save path in the shell.
 *
 * @param {{ draft: object, set: (field: string, value: unknown) => void }} props
 */
export default function PersonalityTab({ draft, set }) {
    return (
        <div className="space-y-6 animate-fade-in">
            {/* System Prompt */}
            <div>
                <h3 className={SECTION_HEADER_BASE}>
                    <Sparkles className="w-4 h-4 text-primary-500" />
                    System Prompt
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Custom instructions that shape how the bot responds. Leave blank to use the platform default.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Custom System Prompt</label>
                    <textarea
                        value={draft.system_prompt}
                        onChange={(e) => set('system_prompt', e.target.value)}
                        maxLength={MAX_SYSTEM_PROMPT}
                        rows={6}
                        placeholder="e.g. You are a friendly support assistant for Acme Inc. Always be concise and offer to escalate to a human when unsure."
                        className={FIELD_TEXTAREA}
                    />
                    <div className="flex items-center justify-between">
                        <p className={FIELD_HELP}>Guides the bot&apos;s behavior on top of your knowledge base.</p>
                        <span className="text-[11px] text-surface-400 tabular-nums">
                            {(draft.system_prompt || '').length}/{MAX_SYSTEM_PROMPT}
                        </span>
                    </div>
                </div>
            </div>

            {/* Brand Tone */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <MessageSquareText className="w-4 h-4 text-primary-500" />
                    Brand Tone
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Describe the voice and tone the bot should use (e.g. professional, playful, concise).
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Brand Voice &amp; Tone</label>
                    <textarea
                        value={draft.brand_tone}
                        onChange={(e) => set('brand_tone', e.target.value)}
                        maxLength={MAX_BRAND_TONE}
                        rows={3}
                        placeholder="e.g. Warm and approachable, with a touch of humor. Avoid jargon."
                        className={FIELD_TEXTAREA}
                    />
                    <div className="flex items-center justify-between">
                        <p className={FIELD_HELP}>Helps the bot match your brand&apos;s personality.</p>
                        <span className="text-[11px] text-surface-400 tabular-nums">
                            {(draft.brand_tone || '').length}/{MAX_BRAND_TONE}
                        </span>
                    </div>
                </div>
            </div>

            {/* Company Info */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <Building2 className="w-4 h-4 text-primary-500" />
                    Company Information
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Context the bot uses to describe your business accurately.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Company Name</label>
                    <input
                        type="text"
                        value={draft.company_name}
                        onChange={(e) => set('company_name', e.target.value)}
                        maxLength={MAX_COMPANY_NAME}
                        placeholder="e.g. Acme Inc."
                        className={FIELD_INPUT}
                    />
                    <p className={FIELD_HELP}>The name of your business or brand.</p>
                </div>

                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Company Description</label>
                    <textarea
                        value={draft.company_description}
                        onChange={(e) => set('company_description', e.target.value)}
                        maxLength={MAX_COMPANY_DESCRIPTION}
                        rows={4}
                        placeholder="e.g. Acme Inc. builds project-management software for remote teams."
                        className={FIELD_TEXTAREA}
                    />
                    <div className="flex items-center justify-between">
                        <p className={FIELD_HELP}>A short summary of what your company does.</p>
                        <span className="text-[11px] text-surface-400 tabular-nums">
                            {(draft.company_description || '').length}/{MAX_COMPANY_DESCRIPTION}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
