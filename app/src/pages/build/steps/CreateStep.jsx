import { useState } from 'react';
import { MessageSquare, Target, CalendarClock, ArrowRight } from 'lucide-react';
import { createBot, updateBot, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useToast } from '../../../context/ToastContext';
import { Input } from '../../../components/ui/Input';
import { Button } from '../../../components/ui/Button';
import { cn } from '../../../lib/utils';

// Primary-job choices. Single-select — the pick sets the default persona AND
// the qualification framework. `framework` values must be valid presets on the
// backend (bant | meddic | champ | gpctba_ci).
const JOBS = [
    { key: 'support', icon: MessageSquare, title: 'Answer support questions', sub: 'Deflect FAQs, cut tickets', framework: 'bant' },
    { key: 'leadgen', icon: Target, title: 'Capture & qualify leads', sub: 'Turns on BANT qualification', framework: 'bant' },
    { key: 'sell', icon: CalendarClock, title: 'Book meetings & sell', sub: 'Route hot visitors to a call', framework: 'meddic' },
];

/**
 * Create milestone: name the agent, pick its primary job (→ framework), and
 * enter the website. Creates the bot + sets the framework, then advances to
 * Train (which runs the discover-first crawl). Deliberately does NOT start a
 * crawl here — see ADR-7.
 */
export default function CreateStep({ onCreated }) {
    const { selectBot, refreshBots } = useBotContext();
    const { showToast } = useToast();
    const [name, setName] = useState('');
    const [job, setJob] = useState('leadgen');
    const [website, setWebsite] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const canSubmit = name.trim() && website.trim() && !submitting;

    const handleCreate = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        try {
            const framework = JOBS.find((j) => j.key === job)?.framework ?? 'bant';
            const result = await createBot({ name: name.trim(), website: website.trim() });
            const botId = result.bot_id;
            await updateBot(botId, { qualification_framework: framework });
            recordActivationEvent('bot_created', { botId, eventData: { job } });
            await refreshBots();
            selectBot(botId);
            onCreated?.(botId);
        } catch (err) {
            showToast('error', err?.message || 'Could not create your agent. Please try again.');
            setSubmitting(false);
        }
    };

    return (
        <div className="flex flex-col gap-6">
            <div>
                <label className="block text-sm font-medium text-[var(--text)] mb-1.5">Agent name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ava" maxLength={60} aria-label="Agent name" />
            </div>

            <div>
                <label className="block text-sm font-medium text-[var(--text)] mb-2">
                    What&rsquo;s its primary job?{' '}
                    <span className="font-normal text-[var(--text-muted)]">— you can add more later</span>
                </label>
                <div className="flex flex-col gap-2.5" role="radiogroup" aria-label="Primary job">
                    {JOBS.map((j) => {
                        const Icon = j.icon;
                        const selected = job === j.key;
                        return (
                            <button
                                key={j.key}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                onClick={() => setJob(j.key)}
                                className={cn(
                                    'flex items-center gap-3.5 text-left rounded-xl border px-4 py-3 transition-all duration-200',
                                    selected
                                        ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-900/15 ring-1 ring-primary-500/20'
                                        : 'border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--border-hover)]'
                                )}
                            >
                                <span
                                    className={cn(
                                        'w-9 h-9 shrink-0 rounded-xl grid place-items-center transition-colors',
                                        selected ? 'bg-primary-500 text-white' : 'bg-[var(--bg-muted)] text-[var(--text-secondary)]'
                                    )}
                                >
                                    <Icon size={17} />
                                </span>
                                <span className="flex-1">
                                    <span className="block text-sm font-medium text-[var(--text)]">{j.title}</span>
                                    <span className="block text-xs text-[var(--text-muted)]">{j.sub}</span>
                                </span>
                                <span
                                    className={cn(
                                        'w-[18px] h-[18px] rounded-full border-2 shrink-0 grid place-items-center transition-colors',
                                        selected ? 'border-primary-500' : 'border-[var(--border-hover)]'
                                    )}
                                >
                                    {selected && <span className="w-2 h-2 rounded-full bg-primary-500" />}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div>
                <label className="block text-sm font-medium text-[var(--text)] mb-1.5">Your website</label>
                <Input
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="acme.com"
                    aria-label="Website URL"
                    className="font-mono"
                />
            </div>

            <Button size="lg" className="self-start" onClick={handleCreate} disabled={!canSubmit} loading={submitting}>
                {submitting ? 'Creating your agent…' : 'Create your agent'}
                {!submitting && <ArrowRight size={16} />}
            </Button>
        </div>
    );
}
