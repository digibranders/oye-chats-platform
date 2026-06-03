import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, Globe, Loader2, Shield, ShieldCheck, ShieldOff, Sparkles, X } from 'lucide-react';
import { useToast } from '../context/ToastContext';
import { getBot, updateBot } from '../services/api';

const MAX_DOMAINS = 50;

/**
 * Strip protocol / path / port / leading "www." from a free-form user input
 * so the chip we display matches what the backend will store. Returns null
 * for inputs that obviously cannot be domains so the caller can surface an
 * error before hitting the API.
 */
function normalizeDomain(input) {
    if (!input) return null;
    let value = String(input).trim().toLowerCase();
    if (!value) return null;

    let wildcard = false;
    if (value.startsWith('*.')) {
        wildcard = true;
        value = value.slice(2);
    }

    // Strip scheme + path so the user can paste "https://www.acme.com/about".
    value = value.replace(/^https?:\/\//, '');
    value = value.split('/')[0];
    value = value.split(':')[0];
    if (value.startsWith('www.')) value = value.slice(4);

    if (!value) return null;
    if (value === 'localhost' || value === '127.0.0.1') return value;

    const hostnamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
    if (!hostnamePattern.test(value)) return null;

    return wildcard ? `*.${value}` : value;
}

/**
 * Best-effort: turn the bot's saved website value into apex + wildcard so
 * the "Detect from my website" button can pre-fill the list.
 */
function deriveFromWebsite(website) {
    const apex = normalizeDomain(website);
    if (!apex) return [];
    if (apex.startsWith('*.')) return [apex];
    if (apex === 'localhost' || apex === '127.0.0.1') return [apex];
    return [apex, `*.${apex}`];
}

export default function DomainRestrictions({ botId, initialAllowedDomains, initialDomainCheckEnabled, botWebsite }) {
    const { showToast } = useToast();
    const [domains, setDomains] = useState(initialAllowedDomains || []);
    const [enabled, setEnabled] = useState(Boolean(initialDomainCheckEnabled));
    const [draft, setDraft] = useState('');
    const [draftError, setDraftError] = useState('');
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);

    // If the parent bot prop reloads (e.g. after refreshBots) and we haven't
    // touched anything locally, mirror the new server state.
    useEffect(() => {
        if (dirty) return;
        setDomains(initialAllowedDomains || []);
        setEnabled(Boolean(initialDomainCheckEnabled));
    }, [initialAllowedDomains, initialDomainCheckEnabled, dirty]);

    const status = useMemo(() => {
        if (!enabled) {
            return {
                tone: 'warning',
                icon: ShieldOff,
                title: 'Your widget is unprotected',
                detail: 'Anyone with your bot key can embed the widget on any site. Turn this on to lock it down.',
            };
        }
        if (domains.length === 0) {
            return {
                tone: 'danger',
                icon: AlertCircle,
                title: 'Widget will be blocked everywhere',
                detail: 'You enabled domain restriction but haven’t added any domains. Add at least one.',
            };
        }
        return {
            tone: 'success',
            icon: ShieldCheck,
            title: `Widget locked to ${domains.length} domain${domains.length === 1 ? '' : 's'}`,
            detail: 'Requests from any other site will be rejected.',
        };
    }, [enabled, domains]);

    const websiteSuggestions = useMemo(() => deriveFromWebsite(botWebsite), [botWebsite]);
    const canDetect = websiteSuggestions.length > 0 && websiteSuggestions.some((d) => !domains.includes(d));

    const tryAdd = (raw) => {
        const normalized = normalizeDomain(raw);
        if (!normalized) {
            setDraftError('Enter a valid domain like acme.com or *.acme.com');
            return false;
        }
        if (domains.includes(normalized)) {
            setDraftError('Already added');
            return false;
        }
        if (domains.length >= MAX_DOMAINS) {
            setDraftError(`Maximum ${MAX_DOMAINS} domains`);
            return false;
        }
        setDomains([...domains, normalized]);
        setDirty(true);
        setDraftError('');
        return true;
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            if (tryAdd(draft)) setDraft('');
        } else if (e.key === 'Backspace' && draft === '' && domains.length > 0) {
            // Quick remove the last chip if the input is empty.
            const next = domains.slice(0, -1);
            setDomains(next);
            setDirty(true);
        }
    };

    const removeDomain = (target) => {
        setDomains(domains.filter((d) => d !== target));
        setDirty(true);
    };

    const detectFromWebsite = () => {
        const merged = [...domains];
        for (const suggestion of websiteSuggestions) {
            if (!merged.includes(suggestion) && merged.length < MAX_DOMAINS) {
                merged.push(suggestion);
            }
        }
        setDomains(merged);
        if (!enabled) setEnabled(true);
        setDirty(true);
    };

    const toggleEnabled = () => {
        setEnabled(!enabled);
        setDirty(true);
    };

    const save = async () => {
        if (saving) return;
        setSaving(true);
        try {
            await updateBot(botId, {
                allowed_domains: domains,
                domain_check_enabled: enabled,
            });
            // Re-fetch so we display the server-normalized values back to the user.
            try {
                const fresh = await getBot(botId);
                setDomains(fresh.allowed_domains || []);
                setEnabled(Boolean(fresh.domain_check_enabled));
            } catch (refreshErr) {
                console.warn('Bot reload after domain save failed:', refreshErr);
            }
            setDirty(false);
            showToast('success', 'Domain restrictions saved.');
        } catch (err) {
            showToast('error', err.message || 'Failed to save domain restrictions');
        } finally {
            setSaving(false);
        }
    };

    const toneClasses = {
        success: 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300',
        warning: 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-300',
        danger: 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300',
    };
    const StatusIcon = status.icon;

    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <label className="text-[10px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500 flex items-center gap-1.5">
                    <Shield size={11} /> Allowed Domains
                </label>
                <button
                    type="button"
                    onClick={toggleEnabled}
                    className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors ${
                        enabled
                            ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : 'bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400'
                    }`}
                >
                    {enabled ? 'On' : 'Off'}
                </button>
            </div>

            <p className="text-xs text-surface-500 dark:text-surface-400 mb-3">
                Lock your widget to the websites listed below. We&apos;ll automatically include subdomains like
                {' '}<code className="font-mono text-[11px] text-surface-700 dark:text-surface-300">www</code>,{' '}
                <code className="font-mono text-[11px] text-surface-700 dark:text-surface-300">blog</code>, or{' '}
                <code className="font-mono text-[11px] text-surface-700 dark:text-surface-300">shop</code> when you
                add an entry that starts with <code className="font-mono text-[11px] text-surface-700 dark:text-surface-300">*.</code>
            </p>

            <div className="bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg p-3 mb-3">
                <div className="flex flex-wrap gap-2">
                    {domains.map((domain) => (
                        <span
                            key={domain}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-200 text-xs font-mono"
                        >
                            <Globe size={11} className="text-primary-500" />
                            {domain}
                            <button
                                type="button"
                                onClick={() => removeDomain(domain)}
                                className="text-surface-400 hover:text-rose-500 dark:text-surface-500 dark:hover:text-rose-400 transition-colors"
                                aria-label={`Remove ${domain}`}
                            >
                                <X size={11} />
                            </button>
                        </span>
                    ))}
                    <input
                        type="text"
                        value={draft}
                        onChange={(e) => { setDraft(e.target.value); if (draftError) setDraftError(''); }}
                        onKeyDown={handleKeyDown}
                        onBlur={() => { if (draft.trim()) { if (tryAdd(draft)) setDraft(''); } }}
                        placeholder={domains.length === 0 ? 'acme.com' : 'Add another domain...'}
                        className="flex-1 min-w-[140px] bg-transparent text-xs text-surface-700 dark:text-surface-200 placeholder:text-surface-400 dark:placeholder:text-surface-500 outline-none font-mono"
                    />
                </div>
                {draftError && (
                    <p className="mt-2 text-[11px] text-rose-600 dark:text-rose-400 flex items-center gap-1">
                        <AlertCircle size={11} /> {draftError}
                    </p>
                )}
            </div>

            {canDetect && (
                <button
                    type="button"
                    onClick={detectFromWebsite}
                    className="inline-flex items-center gap-1.5 mb-3 px-2.5 py-1.5 text-[11px] font-semibold text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-500/10 rounded-lg hover:bg-primary-100 dark:hover:bg-primary-500/20 transition-colors"
                >
                    <Sparkles size={12} />
                    Use my website ({websiteSuggestions.join(', ')})
                </button>
            )}

            <div className={`flex items-start gap-2 p-3 rounded-lg border text-xs ${toneClasses[status.tone]}`}>
                <StatusIcon size={14} className="flex-shrink-0 mt-0.5" />
                <div>
                    <p className="font-semibold">{status.title}</p>
                    <p className="opacity-90">{status.detail}</p>
                </div>
            </div>

            {dirty && (
                <div className="flex items-center justify-end gap-2 mt-3">
                    <span className="text-[11px] text-surface-500 dark:text-surface-400">Unsaved changes</span>
                    <button
                        type="button"
                        onClick={save}
                        disabled={saving}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 hover:bg-primary-700 dark:hover:bg-primary-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-70"
                    >
                        {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            )}
        </div>
    );
}
