import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Check, Loader2, ArrowRight, HelpCircle, RefreshCw } from 'lucide-react';
import { getBot, recordActivationEvent, completeOnboarding } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useToast } from '../../../context/ToastContext';
import useEntitlements from '../../../hooks/useEntitlements';
import { Button } from '../../../components/ui/Button';
import { cn } from '../../../lib/utils';
import { platforms } from '../../../data/platformIntegrations';
import PlatformSelector from '../../../components/PlatformSelector';
import IntegrationGuide from '../../../components/IntegrationGuide';

function hostOf(url) {
    try {
        return new URL((url || '').startsWith('http') ? url : `https://${url}`).host;
    } catch {
        return url || 'your site';
    }
}

/**
 * Go-live milestone — reuses the app's real install UI (PlatformSelector +
 * IntegrationGuide) so there's one source of truth for the embed snippet, and
 * polls the bot for widget install-detection so the status flips to "live" the
 * moment the widget first loads on the customer's site.
 */
export default function GoLiveStep() {
    const navigate = useNavigate();
    const { selectedBot } = useBotContext();
    const { showToast } = useToast();
    const { entitlements } = useEntitlements();
    const botId = selectedBot?.id;
    const host = hostOf(selectedBot?.website);

    const [selectedPlatform, setSelectedPlatform] = useState(null);
    const [embedTab, setEmbedTab] = useState('production');
    const [copiedField, setCopiedField] = useState(null);
    const [liveAt, setLiveAt] = useState(selectedBot?.widget_installed_at || null);
    // After a grace period with no auto-detection, reveal a manual-verify +
    // troubleshooting panel so a correctly-installed-but-undetected widget (auth
    // wall, referrer-stripping, CSP) never leaves the user stuck on a spinner.
    const [showTrouble, setShowTrouble] = useState(false);
    const [checking, setChecking] = useState(false);
    const copyTimer = useRef(null);

    const handleCopy = async (text, field) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedField(field);
            clearTimeout(copyTimer.current);
            copyTimer.current = setTimeout(() => setCopiedField(null), 1800);
            recordActivationEvent('snippet_copied', { botId });
        } catch {
            showToast('error', 'Could not copy to clipboard.');
        }
    };

    // Poll for widget install-detection until it goes live.
    useEffect(() => {
        if (!botId || liveAt) return;
        let cancelled = false;
        const id = setInterval(async () => {
            try {
                const b = await getBot(botId);
                if (cancelled) return;
                if (b?.widget_installed_at) {
                    setLiveAt(b.widget_installed_at);
                    recordActivationEvent('widget_detected_live', { botId });
                }
            } catch {
                /* transient — keep polling */
            }
        }, 5000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [botId, liveAt]);

    // Surface the troubleshooting panel after a grace period without detection.
    useEffect(() => {
        if (!botId || liveAt) {
            setShowTrouble(false);
            return undefined;
        }
        const t = setTimeout(() => setShowTrouble(true), 35000);
        return () => clearTimeout(t);
    }, [botId, liveAt]);

    useEffect(() => () => clearTimeout(copyTimer.current), []);

    // Manual, on-demand re-check for users whose install we can't auto-detect.
    const checkNow = async () => {
        if (!botId || checking) return;
        setChecking(true);
        try {
            const b = await getBot(botId);
            if (b?.widget_installed_at) {
                setLiveAt(b.widget_installed_at);
                recordActivationEvent('widget_detected_live', { botId });
            } else {
                showToast('info', "We still can't see the widget yet. Give it a few seconds after publishing, then check again.");
            }
        } catch {
            showToast('error', 'Could not check right now. Please try again.');
        } finally {
            setChecking(false);
        }
    };

    const finish = async () => {
        recordActivationEvent('studio_completed', { botId });
        recordActivationEvent('activation_goal_set', { botId, eventData: { goal: 'first_10_qualified_leads' } });
        await completeOnboarding();
        navigate('/');
    };

    return (
        <div className="flex flex-col gap-5">
            {/* Live-detection status */}
            <div
                className={cn(
                    'flex items-center gap-3 rounded-xl border px-4 py-3.5',
                    liveAt
                        ? 'border-emerald-500/25 bg-emerald-50 dark:bg-emerald-900/15'
                        : 'border-[var(--border)] bg-[var(--bg-muted)]/40'
                )}
            >
                {liveAt ? (
                    <>
                        <span className="w-7 h-7 rounded-full grid place-items-center bg-emerald-500 text-white shrink-0">
                            <Check size={15} strokeWidth={3} />
                        </span>
                        <p className="text-sm font-medium text-[var(--text)]">
                            Your agent is live on <span className="font-mono">{host}</span> 🎉
                        </p>
                    </>
                ) : (
                    <>
                        <Loader2 size={16} className="animate-spin text-primary-500 shrink-0" />
                        <p className="text-sm text-[var(--text-secondary)]">
                            Waiting to detect your widget — add the snippet below and it&rsquo;ll light up here automatically.
                        </p>
                    </>
                )}
            </div>

            {/* Manual verify + troubleshooting — appears only after a grace period
                with no auto-detection, so it never nags a smooth install. */}
            {!liveAt && showTrouble && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3.5">
                    <div className="flex items-start gap-2.5">
                        <HelpCircle size={16} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
                        <div className="flex-1">
                            <p className="text-sm font-medium text-[var(--text)]">Not seeing it go live yet?</p>
                            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-[var(--text-muted)]">
                                <li>
                                    Paste the snippet just before the closing <code className="font-mono">&lt;/body&gt;</code> tag,
                                    on a page that&rsquo;s publicly live (not behind a login).
                                </li>
                                <li>
                                    Just added it? Hard-refresh the page (<span className="font-mono">Ctrl/Cmd + Shift + R</span>) so
                                    the new code loads — a CDN can take a minute to update.
                                </li>
                                <li>
                                    Strict privacy settings or a Content-Security-Policy that blocks the widget can stop
                                    auto-detection. Your agent still works — you can finish and we&rsquo;ll keep checking.
                                </li>
                            </ul>
                            <Button size="sm" variant="secondary" className="mt-3" onClick={checkNow} loading={checking}>
                                {!checking && <RefreshCw size={14} />}
                                {checking ? 'Checking…' : 'Check again'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Install UI — the app's real PlatformSelector + IntegrationGuide */}
            <div>
                {selectedPlatform ? (
                    <IntegrationGuide
                        platform={platforms.find((p) => p.id === selectedPlatform)}
                        botKey={selectedBot?.bot_key}
                        env={embedTab}
                        onEnvChange={setEmbedTab}
                        onBack={() => setSelectedPlatform(null)}
                        onCopy={handleCopy}
                        copiedField={copiedField}
                    />
                ) : (
                    <PlatformSelector platforms={platforms} selectedId={null} onSelect={setSelectedPlatform} />
                )}
            </div>

            <div className="flex flex-col gap-3">
                <Button size="lg" variant={liveAt ? 'success' : 'primary'} onClick={finish}>
                    {liveAt ? 'Finish setup' : 'Go to dashboard'}
                    <ArrowRight size={16} />
                </Button>
                {/* Contextual plan awareness at the commitment moment — a quiet,
                    informational line, not a hard sell. Hidden on Enterprise
                    (no higher tier to move to). */}
                {!entitlements.isEnterprise && (
                    <p className="text-xs text-[var(--text-muted)]">
                        You&rsquo;re on the <span className="font-medium text-[var(--text-secondary)]">{entitlements.planName}</span> plan.{' '}
                        <Link to="/billing" className="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400">
                            Compare plans
                        </Link>
                    </p>
                )}
            </div>
        </div>
    );
}
