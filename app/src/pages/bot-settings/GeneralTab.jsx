import { Bot } from 'lucide-react';

/**
 * GeneralTab — bot identity.
 *
 * Binds the bot's display name and launcher tooltip text. Colors and avatar
 * moved to AppearanceTab; personality/company moved to PersonalityTab.
 *
 * @param {{ draft: object, set: (field: string, value: unknown) => void }} props
 */
export default function GeneralTab({ draft, set }) {
    return (
        <div className="flex flex-col gap-10">
            {/* Chatbot Display Name */}
            <div className="space-y-3 animate-fade-in">
                <div>
                    <h3 className="text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                        <Bot className="w-4 h-4 text-primary-500" />
                        Chatbot Display Name
                    </h3>
                    <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">
                        The name visitors see at the top of the chat window.
                    </p>
                </div>
                <input
                    type="text"
                    value={draft.bot_name}
                    onChange={(e) => set('bot_name', e.target.value)}
                    maxLength={40}
                    placeholder="e.g. AI Assistant, Support Bot..."
                    className="w-full max-w-lg h-10 px-3 rounded-md border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 text-sm text-surface-900 dark:text-surface-100 placeholder-surface-400 dark:placeholder:text-surface-500 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 transition-all shadow-sm"
                />
            </div>

            {/* Launcher Tooltip Text */}
            <div className="space-y-3 animate-fade-in" style={{ animationDelay: '0.07s' }}>
                <div>
                    <h3 className="text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                        <Bot className="w-4 h-4 text-primary-500" />
                        Launcher Text
                    </h3>
                    <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">
                        The &ldquo;Have Questions?&rdquo; tooltip shown next to the launcher button.
                    </p>
                </div>
                <input
                    type="text"
                    value={draft.launcher_name}
                    onChange={(e) => set('launcher_name', e.target.value)}
                    maxLength={50}
                    placeholder="e.g. Have Questions?"
                    className="w-full max-w-lg h-10 px-3 rounded-md border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 text-sm text-surface-900 dark:text-surface-100 placeholder-surface-400 dark:placeholder:text-surface-500 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 transition-all shadow-sm"
                />
            </div>
        </div>
    );
}
