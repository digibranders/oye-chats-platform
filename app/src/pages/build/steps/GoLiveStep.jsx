import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, ArrowRight } from 'lucide-react';
import { getBot, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useToast } from '../../../context/ToastContext';
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
    const botId = selectedBot?.id;
    const host = hostOf(selectedBot?.website);

    const [selectedPlatform, setSelectedPlatform] = useState(null);
    const [embedTab, setEmbedTab] = useState('production');
    const [copiedField, setCopiedField] = useState(null);
    const [liveAt, setLiveAt] = useState(selectedBot?.widget_installed_at || null);
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

    useEffect(() => () => clearTimeout(copyTimer.current), []);

    const finish = () => {
        recordActivationEvent('studio_completed', { botId });
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

            <div>
                <Button size="lg" variant={liveAt ? 'success' : 'primary'} onClick={finish}>
                    {liveAt ? 'Finish setup' : 'Go to dashboard'}
                    <ArrowRight size={16} />
                </Button>
            </div>
        </div>
    );
}
