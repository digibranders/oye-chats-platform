import { Mail, CodeXml, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '../../context/ToastContext';

const SUPPORT_EMAIL = 'support@oyechats.com';

/**
 * ContactTab — landing spot for custom/personalized requests that don't fit
 * the Feedback & Support ticket flow (e.g. bespoke integrations, custom
 * pricing, white-glove onboarding). Surfaces the support inbox directly
 * rather than routing through the bug/feature/question taxonomy.
 */
export default function ContactTab() {
    const { showToast } = useToast();
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(SUPPORT_EMAIL);
            setCopied(true);
            showToast('success', 'Email copied to clipboard.');
            setTimeout(() => setCopied(false), 2000);
        } catch {
            showToast('error', 'Could not copy — select and copy the email manually.');
        }
    };

    return (
        <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
            <div className="flex items-start gap-4 mb-4">
                <div className="relative shrink-0">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-sm shadow-primary-500/30 flex items-center justify-center">
                        <CodeXml size={15} strokeWidth={2.2} />
                    </div>
                </div>
                <div className="flex-1 min-w-0">
                    <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50">
                        Need something custom?
                    </h2>
                    <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">
                        Custom integrations, bespoke pricing, or a feature built specifically for your workspace.
                        Our team handles these directly rather than through the standard feedback queue.
                    </p>
                </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-50 dark:bg-surface-800/50 border border-surface-100 dark:border-surface-700 px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                    <Mail size={16} className="text-primary-600 dark:text-primary-400 shrink-0" />
                    <span className="text-sm font-medium text-surface-900 dark:text-surface-50 truncate">
                        {SUPPORT_EMAIL}
                    </span>
                </div>
                <button
                    type="button"
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 transition-colors shrink-0"
                >
                    {copied ? <Check size={14} className="text-emerald-600 dark:text-emerald-400" /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </div>

            <a
                href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Custom request')}`}
                className="inline-flex items-center gap-2 mt-5 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all"
            >
                <Mail size={15} />
                Email us
            </a>
        </div>
    );
}
