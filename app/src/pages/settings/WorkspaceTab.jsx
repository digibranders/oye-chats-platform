import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
    Users, CreditCard, KeyRound, Loader2, RefreshCw, Copy, Check,
    ChevronRight, Bot, AlertTriangle,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useToast } from '../../context/ToastContext';
import { getClientApiKey, regenerateClientApiKey } from '../../services/api';

function LinkCard({ to, icon, title, description }) {
    return (
        <Link
            to={to}
            className="group flex items-center gap-4 p-4 rounded-2xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 shadow-sm hover:border-primary-300 dark:hover:border-primary-500/40 hover:bg-surface-50 dark:hover:bg-surface-800/60 transition-all"
        >
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-300 shrink-0">
                {icon}
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-surface-900 dark:text-surface-50">{title}</p>
                <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">{description}</p>
            </div>
            <ChevronRight size={16} className="text-surface-400 dark:text-surface-500 group-hover:text-primary-500 transition-colors shrink-0" />
        </Link>
    );
}

/**
 * WorkspaceTab — workspace-level shortcuts and the client API key.
 *
 *   • Quick link cards to Team and Billing.
 *   • API-key card: masked display + Regenerate (confirm → rotate → reveal the
 *     full new key once with copy-to-clipboard → re-mask).
 *   • A migration pointer card noting that per-bot configuration now lives in
 *     Bot Settings (the Chatbot → appearance editor).
 */
export default function WorkspaceTab() {
    const { showToast } = useToast();

    const [masked, setMasked] = useState(null);
    const [loadingKey, setLoadingKey] = useState(true);
    const [keyError, setKeyError] = useState('');
    const [regenerating, setRegenerating] = useState(false);
    // The full key is only available immediately after a rotation; once the
    // user dismisses the reveal we drop it from memory and show the mask again.
    const [revealedKey, setRevealedKey] = useState(null);
    const [copied, setCopied] = useState(false);

    const loadKey = useCallback(async () => {
        setLoadingKey(true);
        setKeyError('');
        try {
            const data = await getClientApiKey();
            setMasked(data.api_key_masked);
        } catch (err) {
            setKeyError(err.message || 'Failed to load API key');
        } finally {
            setLoadingKey(false);
        }
    }, []);

    useEffect(() => {
        loadKey();
    }, [loadKey]);

    const handleRegenerate = async () => {
        const ok = window.confirm(
            'Regenerate your API key?\n\nThe current key will stop working immediately and any integrations using it will need the new key.',
        );
        if (!ok) return;

        setRegenerating(true);
        try {
            const data = await regenerateClientApiKey();
            setMasked(data.api_key_masked);
            setRevealedKey(data.api_key);
            setCopied(false);
            showToast('success', 'API key regenerated. Copy it now — it won’t be shown again.');
        } catch (err) {
            showToast('error', err.message || 'Failed to regenerate API key.');
        } finally {
            setRegenerating(false);
        }
    };

    const handleCopy = async () => {
        if (!revealedKey) return;
        try {
            await navigator.clipboard.writeText(revealedKey);
            setCopied(true);
            showToast('success', 'API key copied to clipboard.');
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            showToast('error', 'Could not copy to clipboard.');
        }
    };

    const dismissReveal = () => {
        setRevealedKey(null);
        setCopied(false);
    };

    return (
        <div className="space-y-6">
            {/* ── Quick links ─────────────────────────────────────────────── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <LinkCard
                    to="/team"
                    icon={<Users size={18} />}
                    title="Team"
                    description="Manage operators and departments"
                />
                <LinkCard
                    to="/billing"
                    icon={<CreditCard size={18} />}
                    title="Billing"
                    description="Plan, credits, and invoices"
                />
            </div>

            {/* ── API key ─────────────────────────────────────────────────── */}
            <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 mb-1 flex items-center gap-2">
                    <KeyRound size={16} className="text-primary-600 dark:text-primary-400" />
                    API Key
                </h2>
                <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">
                    Use this key to authenticate server-to-server requests to the OyeChats API.
                </p>

                {loadingKey ? (
                    <div className="flex items-center gap-2 text-surface-400 dark:text-surface-500 text-sm py-2">
                        <Loader2 size={14} className="animate-spin" />
                        Loading API key…
                    </div>
                ) : keyError ? (
                    <div>
                        <p className="text-sm text-rose-600 dark:text-rose-400 mb-3">{keyError}</p>
                        <button
                            type="button"
                            onClick={loadKey}
                            className="text-sm font-medium text-primary-600 dark:text-primary-400 hover:underline"
                        >
                            Try again
                        </button>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {revealedKey ? (
                            <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/10 p-4">
                                <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 mb-2 flex items-center gap-1.5">
                                    <Check size={13} />
                                    Your new API key (shown once)
                                </p>
                                <div className="flex items-center gap-2">
                                    <code className="flex-1 min-w-0 truncate font-mono text-sm text-surface-900 dark:text-surface-100 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg px-3 py-2">
                                        {revealedKey}
                                    </code>
                                    <button
                                        type="button"
                                        onClick={handleCopy}
                                        className="inline-flex items-center gap-1.5 py-2 px-3 text-sm font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors shrink-0"
                                    >
                                        {copied ? <Check size={14} /> : <Copy size={14} />}
                                        {copied ? 'Copied' : 'Copy'}
                                    </button>
                                </div>
                                <p className="text-xs text-emerald-700/80 dark:text-emerald-400/80 mt-2">
                                    Store it somewhere safe — you won&apos;t be able to see the full key again.
                                </p>
                                <button
                                    type="button"
                                    onClick={dismissReveal}
                                    className="mt-3 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:underline"
                                >
                                    I&apos;ve saved it
                                </button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2">
                                <code className="flex-1 min-w-0 truncate font-mono text-sm text-surface-700 dark:text-surface-200 bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg px-3 py-2">
                                    {masked || '—'}
                                </code>
                            </div>
                        )}

                        <button
                            type="button"
                            onClick={handleRegenerate}
                            disabled={regenerating}
                            className={cn(
                                'inline-flex items-center gap-2 py-2.5 px-5 text-sm font-medium rounded-xl border transition-colors',
                                'border-surface-200 dark:border-surface-700 text-surface-700 dark:text-surface-200',
                                'hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-50 disabled:cursor-not-allowed'
                            )}
                        >
                            {regenerating ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                            Regenerate
                        </button>
                    </div>
                )}
            </div>

            {/* ── Bot configuration pointer ───────────────────────────────── */}
            <div className="bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <div className="flex items-start gap-3">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400 shrink-0">
                        <Bot size={17} />
                    </span>
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-surface-900 dark:text-surface-50 flex items-center gap-1.5">
                            <AlertTriangle size={13} className="text-amber-500 shrink-0" />
                            Looking for bot configuration?
                        </p>
                        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1 leading-relaxed">
                            Bot appearance, visitor messages, behavior, and live-chat queue settings have moved to{' '}
                            <strong className="font-semibold text-surface-700 dark:text-surface-300">Bot Settings</strong>.
                        </p>
                        <Link
                            to="/chatbot?tab=appearance"
                            className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors"
                        >
                            Go to Bot Settings
                            <ChevronRight size={14} />
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    );
}
