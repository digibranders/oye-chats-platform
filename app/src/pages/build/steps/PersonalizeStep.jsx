import { useState, useEffect } from 'react';
import { Check, ArrowRight, Loader2 } from 'lucide-react';
import {
    getClientSettings,
    updateClientSettings,
    updateBot,
    recordActivationEvent,
} from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useToast } from '../../../context/ToastContext';
import { Input } from '../../../components/ui/Input';
import { Button } from '../../../components/ui/Button';
import { cn } from '../../../lib/utils';

const PRESETS = ['#d946ef', '#6366f1', '#0ea5e9', '#10b981', '#f97316', '#ef4444'];

// A placeholder name derived at Connect from the bare domain (e.g. "Acme").
// If the current name still looks like that placeholder and the crawl found a
// nicer company name, we suggest the company name instead.
function suggestName(bot) {
    const current = (bot?.name || '').trim();
    const company = (bot?.company_name || '').trim();
    if (company && company.toLowerCase() !== current.toLowerCase()) return company;
    return current;
}

/**
 * Personalize milestone (Prove-it-first step 3) — merges naming + appearance
 * into one low-effort "make it yours" step. The name is pre-filled from the
 * company name the crawl extracted; the accent colour is seeded from the
 * palette auto-detected on the site. Both are one-tap confirms.
 */
export default function PersonalizeStep({ onDone, onPreviewColor }) {
    const { selectedBot, refreshBots } = useBotContext();
    const { showToast } = useToast();
    const botId = selectedBot?.id;

    const [loading, setLoading] = useState(true);
    const [detected, setDetected] = useState([]);
    const [name, setName] = useState(() => suggestName(selectedBot));
    const [color, setColor] = useState(selectedBot?.primary_color || '#d946ef');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!botId) return undefined;
        let cancelled = false;
        (async () => {
            try {
                const s = await getClientSettings(botId);
                if (cancelled) return;
                setDetected(Array.isArray(s?.recommended_colors) ? s.recommended_colors.slice(0, 6) : []);
                if (s?.primary_color) setColor(s.primary_color);
                setLoading(false);
            } catch {
                if (cancelled) return;
                setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [botId]);

    const pick = (c) => {
        setColor(c);
        onPreviewColor?.(c);
    };

    const save = async () => {
        const finalName = name.trim() || selectedBot?.name || 'AI Assistant';
        setSaving(true);
        try {
            await updateBot(botId, { name: finalName });
            await updateClientSettings({ primary_color: color }, botId);
            recordActivationEvent('appearance_saved', { botId, eventData: { color } });
            await refreshBots();
            onPreviewColor?.(null);
            onDone?.();
        } catch (err) {
            showToast('error', err?.message || 'Could not save your changes.');
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-[160px] flex items-center justify-center">
                <Loader2 size={20} className="animate-spin text-primary-500" />
            </div>
        );
    }

    const Swatch = ({ c }) => {
        const active = color.toLowerCase() === c.toLowerCase();
        return (
            <button
                type="button"
                onClick={() => pick(c)}
                aria-label={`Use ${c}`}
                aria-pressed={active}
                className={cn(
                    'w-9 h-9 rounded-xl grid place-items-center transition-transform hover:scale-105',
                    active ? 'ring-2 ring-offset-2 ring-[var(--text)] dark:ring-offset-surface-950' : 'ring-1 ring-[var(--border)]'
                )}
                style={{ backgroundColor: c }}
            >
                {active && <Check size={15} strokeWidth={3} className="text-white drop-shadow" />}
            </button>
        );
    };

    return (
        <div className="flex flex-col gap-6">
            <div>
                <label className="block text-sm font-medium text-[var(--text)] mb-1.5">Agent name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ava" maxLength={60} aria-label="Agent name" />
                {selectedBot?.company_name && (
                    <p className="mt-1 text-xs text-[var(--text-muted)]">Suggested from your website — edit if you like.</p>
                )}
            </div>

            {detected.length > 0 && (
                <div>
                    <label className="block text-sm font-medium text-[var(--text)] mb-2.5">Detected from your website</label>
                    <div className="flex flex-wrap gap-2.5">
                        {detected.map((c) => (
                            <Swatch key={c} c={c} />
                        ))}
                    </div>
                </div>
            )}

            <div>
                <label className="block text-sm font-medium text-[var(--text)] mb-2.5">Accent colour</label>
                <div className="flex flex-wrap items-center gap-2.5">
                    {PRESETS.map((c) => (
                        <Swatch key={c} c={c} />
                    ))}
                    <label className="w-9 h-9 rounded-xl border-2 border-dashed border-[var(--border-hover)] grid place-items-center cursor-pointer text-[var(--text-muted)] relative overflow-hidden hover:border-[var(--text-muted)]">
                        <input
                            type="color"
                            value={color}
                            onChange={(e) => pick(e.target.value)}
                            className="absolute inset-0 opacity-0 cursor-pointer"
                            aria-label="Custom colour"
                        />
                        +
                    </label>
                </div>
            </div>

            <div className="flex items-center gap-4">
                <Button size="lg" onClick={save} loading={saving}>
                    {saving ? 'Saving…' : 'Looks good'}
                    {!saving && <ArrowRight size={16} />}
                </Button>
            </div>

            <p className="text-xs text-[var(--text-muted)]">
                The preview updates as you pick. You can fine-tune the full look later in Settings.
            </p>
        </div>
    );
}
