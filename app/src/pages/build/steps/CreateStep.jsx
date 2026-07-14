import { useState } from 'react';
import { MessageSquare, Target, CalendarClock, Loader2, ArrowRight } from 'lucide-react';
import { createBot, updateBot, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useToast } from '../../../context/ToastContext';

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

    const label = 'font-mono text-[11px] uppercase tracking-wider text-surface-400 dark:text-surface-500';
    const field =
        'w-full rounded-xl border border-surface-300 dark:border-surface-700 bg-white dark:bg-surface-900 px-3.5 py-2.5 text-sm text-surface-900 dark:text-surface-50 placeholder:text-surface-400 focus:outline-none focus:border-primary-500';

    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
                <span className={label}>Agent name</span>
                <input
                    className={field}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Ava"
                    maxLength={60}
                    aria-label="Agent name"
                />
            </div>

            <div className="flex flex-col gap-2">
                <span className={label}>
                    What&rsquo;s its primary job?{' '}
                    <span className="normal-case tracking-normal text-surface-400">· you can add more later</span>
                </span>
                <div className="flex flex-col gap-2" role="radiogroup" aria-label="Primary job">
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
                                className={[
                                    'flex items-center gap-3 text-left rounded-xl border px-3.5 py-3 transition-colors',
                                    selected
                                        ? 'border-primary-500 bg-primary-500/5'
                                        : 'border-surface-300 dark:border-surface-700 hover:border-surface-400 dark:hover:border-surface-600',
                                ].join(' ')}
                            >
                                <span className="w-8 h-8 shrink-0 rounded-lg grid place-items-center bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300">
                                    <Icon size={16} />
                                </span>
                                <span className="flex-1">
                                    <span className="block text-sm font-medium text-surface-900 dark:text-surface-50">{j.title}</span>
                                    <span className="block text-xs text-surface-400 dark:text-surface-500">{j.sub}</span>
                                </span>
                                <span
                                    className={[
                                        'w-[18px] h-[18px] rounded-full border-2 shrink-0 grid place-items-center',
                                        selected ? 'border-primary-500' : 'border-surface-300 dark:border-surface-600',
                                    ].join(' ')}
                                >
                                    {selected && <span className="w-2 h-2 rounded-full bg-primary-500" />}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="flex flex-col gap-1.5">
                <span className={label}>Your website</span>
                <input
                    className={`${field} font-mono`}
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="acme.com"
                    aria-label="Website URL"
                />
            </div>

            <button
                type="button"
                onClick={handleCreate}
                disabled={!canSubmit}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed self-start"
            >
                {submitting ? (
                    <>
                        <Loader2 size={16} className="animate-spin" /> Creating your agent…
                    </>
                ) : (
                    <>
                        Create your agent <ArrowRight size={16} />
                    </>
                )}
            </button>
        </div>
    );
}
