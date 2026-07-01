import { useEffect, useRef, useState } from 'react';
import {
    X, Key, Copy, Check, Eye, EyeOff, ExternalLink, Link2, Code2,
} from 'lucide-react';
import { getAuthState } from '../../utils/auth';
import { useToast } from '../../context/ToastContext';
import {
    getBotDemoUrl,
    getBotPreviewUrl,
    trackDemoShareClick,
} from '../../services/api';
import { platforms } from '../../data/platformIntegrations';
import PlatformSelector from '../../components/PlatformSelector';
import IntegrationGuide from '../../components/IntegrationGuide';
import DomainRestrictions from '../../components/DomainRestrictions';

/**
 * Right-side slide-over that hosts everything needed to install/embed a bot:
 * the Bot Key (show/copy), Preview & Share links, DomainRestrictions, and the
 * platform Integration Guide. Content is lazy-mounted — nothing renders while
 * closed. Accessible: role="dialog" + aria-modal, labelled heading, Esc +
 * backdrop close, body scroll-lock, focus moved into the panel on open and
 * restored to the trigger on close, mobile = full-screen sheet.
 */
export default function InstallDrawer({ bot, open, onClose }) {
    const { isBotManager } = getAuthState();
    const { showToast } = useToast();
    const panelRef = useRef(null);
    const triggerRef = useRef(null);

    const [showKey, setShowKey] = useState(false);
    const [selectedPlatform, setSelectedPlatform] = useState(null);
    const [embedTab, setEmbedTab] = useState('production');
    const [copiedField, setCopiedField] = useState(null);

    // Esc to close + body scroll-lock while open; move focus into the panel on
    // open and restore it to whatever was focused (the trigger) on close.
    useEffect(() => {
        if (!open) return undefined;
        triggerRef.current = document.activeElement;
        const onKey = (e) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        panelRef.current?.focus();
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
            if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
        };
    }, [open, onClose]);

    if (!open || !bot) return null; // lazy content: nothing mounted when closed

    const maskKey = (key) => (key ? `${key.substring(0, 6)}••••••••${key.substring(key.length - 4)}` : '');

    const handleCopy = async (text, field, onCopied) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedField(field);
            setTimeout(() => setCopiedField(null), 2000);
            await onCopied?.();
        } catch (err) {
            console.error('Failed to copy text:', err);
            showToast('error', 'Failed to copy to clipboard');
        }
    };

    const handleDemoCopy = () => handleCopy(getBotDemoUrl(bot.bot_key), `demo-${bot.id}`, async () => {
        try {
            await trackDemoShareClick(bot.id);
        } catch (err) {
            console.error('Failed to track demo share click:', err);
        }
    });

    return (
        <div
            className="fixed inset-0 z-50"
            role="dialog"
            aria-modal="true"
            aria-label={`Install ${bot.name}`}
        >
            <div
                className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm animate-fade-in"
                onClick={onClose}
            />
            <div
                ref={panelRef}
                tabIndex={-1}
                className="absolute right-0 top-0 h-full w-full sm:max-w-lg bg-white dark:bg-surface-900 shadow-xl border-l border-surface-200 dark:border-surface-700 overflow-y-auto outline-none animate-slide-in-right"
            >
                <div className="sticky top-0 z-10 bg-white/95 dark:bg-surface-900/95 backdrop-blur px-5 py-4 border-b border-surface-100 dark:border-surface-800 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-surface-900 dark:text-surface-50 truncate pr-3">
                        Install &ldquo;{bot.name}&rdquo;
                    </h2>
                    <button
                        onClick={onClose}
                        aria-label="Close"
                        className="p-1.5 rounded-lg text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="p-5 space-y-5">
                    {/* Bot Key */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-[10px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500 flex items-center gap-1.5">
                                <Key size={11} /> Bot Key
                            </label>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setShowKey((v) => !v)}
                                    aria-label={showKey ? 'Hide bot key' : 'Show bot key'}
                                    className="text-surface-400 dark:text-surface-500 hover:text-surface-600 dark:hover:text-surface-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 rounded"
                                >
                                    {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                                </button>
                                <button
                                    onClick={() => handleCopy(bot.bot_key, `key-${bot.id}`)}
                                    className="flex items-center gap-1 text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 rounded"
                                >
                                    {copiedField === `key-${bot.id}` ? <Check size={11} /> : <Copy size={11} />}
                                    <span className="text-[9px] font-bold uppercase">{copiedField === `key-${bot.id}` ? 'Copied' : 'Copy'}</span>
                                </button>
                            </div>
                        </div>
                        <div className="flex items-center bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg px-3 py-2">
                            <Key className="w-3.5 h-3.5 text-amber-500 mr-2 flex-shrink-0" />
                            <code className="text-xs text-surface-700 dark:text-surface-300 font-mono break-all">
                                {showKey ? bot.bot_key : maskKey(bot.bot_key)}
                            </code>
                        </div>
                    </div>

                    {isBotManager && (
                        <div>
                            <label className="text-[10px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Preview &amp; Share</label>
                            <p className="text-xs text-surface-500 dark:text-surface-400 mt-1 mb-3">
                                {bot.website
                                    ? 'Preview the widget on your website, or share a demo link with teammates.'
                                    : 'Share a live preview page to test the widget before embedding.'}
                            </p>
                            <div className="flex items-center gap-2">
                                <a
                                    href={getBotPreviewUrl(bot.bot_key, bot.website)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-primary-600 hover:bg-primary-700 dark:hover:bg-primary-500 text-white text-xs font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                                >
                                    <ExternalLink size={13} />
                                    View Demo
                                </a>
                                <button
                                    onClick={handleDemoCopy}
                                    className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-surface-200 dark:border-surface-600 hover:border-surface-300 dark:hover:border-surface-500 text-surface-600 dark:text-surface-300 hover:text-surface-700 dark:hover:text-surface-200 text-xs font-semibold rounded-lg transition-colors bg-white dark:bg-surface-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                                >
                                    {copiedField === `demo-${bot.id}` ? <Check size={13} /> : <Link2 size={13} />}
                                    {copiedField === `demo-${bot.id}` ? 'Copied!' : 'Copy Link'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Domain restrictions (widget embed whitelist) */}
                    {isBotManager && (
                        <DomainRestrictions
                            botId={bot.id}
                            initialAllowedDomains={bot.allowed_domains || []}
                            initialDomainCheckEnabled={Boolean(bot.domain_check_enabled)}
                            botWebsite={bot.website}
                        />
                    )}

                    {/* Platform Integration Guide */}
                    <div>
                        <label className="text-[10px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500 flex items-center gap-1.5 mb-3">
                            <Code2 size={11} /> Integration Guide
                        </label>
                        {selectedPlatform ? (
                            <IntegrationGuide
                                platform={platforms.find((p) => p.id === selectedPlatform)}
                                botKey={bot.bot_key}
                                env={embedTab}
                                onEnvChange={setEmbedTab}
                                onBack={() => setSelectedPlatform(null)}
                                onCopy={handleCopy}
                                copiedField={copiedField}
                            />
                        ) : (
                            <PlatformSelector
                                platforms={platforms}
                                selectedId={null}
                                onSelect={setSelectedPlatform}
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
