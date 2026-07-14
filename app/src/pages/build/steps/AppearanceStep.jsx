import { useState, useEffect } from 'react';
import { Check, ArrowRight, Loader2 } from 'lucide-react';
import { getClientSettings, updateClientSettings, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useToast } from '../../../context/ToastContext';
import { Button } from '../../../components/ui/Button';
import { cn } from '../../../lib/utils';

const PRESETS = ['#d946ef', '#6366f1', '#0ea5e9', '#10b981', '#f97316', '#ef4444'];

/**
 * Appearance milestone — the accent colour, seeded with the palette auto-detected
 * from the site during the crawl. Picking a colour updates the live preview in
 * real time (via onPreviewColor); the full branding surface lives in Settings.
 */
export default function AppearanceStep({ onDone, onPreviewColor }) {
    const { selectedBot, refreshBots } = useBotContext();
    const { showToast } = useToast();
    const botId = selectedBot?.id;

    const [loading, setLoading] = useState(true);
    const [detected, setDetected] = useState([]);
    const [color, setColor] = useState(selectedBot?.primary_color || '#d946ef');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!botId) return;
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
        setSaving(true);
        try {
            await updateClientSettings({ primary_color: color }, botId);
            recordActivationEvent('appearance_saved', { botId, eventData: { color } });
            await refreshBots();
            onPreviewColor?.(null);
            onDone?.();
        } catch (err) {
            showToast('error', err?.message || 'Could not save appearance.');
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
                <button
                    type="button"
                    onClick={() => {
                        onPreviewColor?.(null);
                        onDone?.();
                    }}
                    className="text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                >
                    Skip
                </button>
            </div>

            <p className="text-xs text-[var(--text-muted)]">
                The preview updates as you pick. You can fine-tune the full look later in Settings.
            </p>
        </div>
    );
}
