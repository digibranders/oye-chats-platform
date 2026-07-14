import { useState, useRef, useEffect } from 'react';
import { ArrowRight, Send, Loader2 } from 'lucide-react';
import { previewChat, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import Badge from '../../../components/ui/Badge';
import { cn } from '../../../lib/utils';

const SUGGESTED = ['What do you offer?', 'How much does it cost?', 'How do I get in touch?', 'Do you offer support?'];
const RATINGS = [
    { v: 'good', e: '👍' },
    { v: 'ok', e: '👌' },
    { v: 'poor', e: '👎' },
];

function pathOf(u) {
    try {
        return new URL(u).pathname || u;
    } catch {
        return u;
    }
}

/**
 * Test & trust milestone — ask the freshly-trained agent real questions via the
 * free owner-preview chat (B4), see each answer WITH its cited sources, and rate
 * it. A running trust score turns "will this embarrass me?" into demonstrated
 * confidence before go-live.
 */
export default function TestStep({ onDone }) {
    const { selectedBot } = useBotContext();
    const botId = selectedBot?.id;
    const [turns, setTurns] = useState([]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const sessionRef = useRef(`studio-preview-${Date.now()}`);
    const askedRef = useRef(false);
    const nextId = useRef(0);
    const scrollRef = useRef(null);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [turns]);

    const ask = async (question) => {
        const q = (question ?? input).trim();
        if (!q || busy || !botId) return;
        setInput('');
        setBusy(true);
        const id = nextId.current++;
        setTurns((t) => [...t, { id, q, a: null, sources: [], rating: null, loading: true, error: null }]);
        if (!askedRef.current) {
            askedRef.current = true;
            recordActivationEvent('first_test_asked', { botId });
        }
        try {
            const res = await previewChat(botId, q, sessionRef.current);
            setTurns((t) =>
                t.map((x) =>
                    x.id === id
                        ? { ...x, a: res?.answer || '', sources: Array.isArray(res?.sources) ? res.sources : [], loading: false }
                        : x
                )
            );
        } catch (err) {
            setTurns((t) =>
                t.map((x) => (x.id === id ? { ...x, error: err?.message || 'The agent could not answer that.', loading: false } : x))
            );
        } finally {
            setBusy(false);
        }
    };

    const rate = (id, rating) => {
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, rating } : x)));
        recordActivationEvent('answer_rated', { botId, eventData: { rating } });
    };

    const rated = turns.filter((t) => t.rating);
    const good = rated.filter((t) => t.rating === 'good').length;

    return (
        <div className="flex flex-col gap-4">
            {rated.length > 0 && (
                <Badge variant="soft" color={good === rated.length ? 'success' : 'default'} size="md" className="self-start">
                    Trust score: {good}/{rated.length} rated good
                </Badge>
            )}

            {turns.length > 0 && (
                <div ref={scrollRef} className="max-h-[320px] overflow-y-auto flex flex-col gap-4 pr-1">
                    {turns.map((t) => (
                        <div key={t.id} className="flex flex-col gap-2">
                            <p className="text-sm text-[var(--text-secondary)]">
                                <span className="font-medium text-[var(--text)]">You:</span> {t.q}
                            </p>
                            {t.loading ? (
                                <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                                    <Loader2 size={15} className="animate-spin text-primary-500" /> Thinking…
                                </div>
                            ) : t.error ? (
                                <p className="text-sm text-rose-500">{t.error}</p>
                            ) : (
                                <div className="rounded-2xl rounded-tl-md bg-[var(--bg-muted)] px-4 py-3">
                                    <p className="text-sm text-[var(--text)] whitespace-pre-wrap">{t.a}</p>
                                    {t.sources.length > 0 && (
                                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                                            {t.sources.slice(0, 4).map((s, i) => (
                                                <a
                                                    key={i}
                                                    href={s}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-md bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400 hover:underline"
                                                >
                                                    ◆ {pathOf(s)}
                                                </a>
                                            ))}
                                        </div>
                                    )}
                                    <div className="flex items-center gap-1.5 mt-3">
                                        <span className="text-xs text-[var(--text-muted)] mr-1">Good answer?</span>
                                        {RATINGS.map((r) => (
                                            <button
                                                key={r.v}
                                                type="button"
                                                onClick={() => rate(t.id, r.v)}
                                                aria-label={r.v}
                                                aria-pressed={t.rating === r.v}
                                                className={cn(
                                                    'w-7 h-7 rounded-lg grid place-items-center text-sm transition-colors',
                                                    t.rating === r.v
                                                        ? 'bg-primary-500/15 ring-1 ring-primary-500'
                                                        : 'hover:bg-[var(--bg-card)]'
                                                )}
                                            >
                                                {r.e}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <div className="flex flex-col gap-2.5">
                {turns.length === 0 && <p className="text-sm text-[var(--text-secondary)]">Ask your agent a few real questions:</p>}
                <div className="flex flex-wrap gap-2">
                    {SUGGESTED.map((s) => (
                        <button
                            key={s}
                            type="button"
                            onClick={() => ask(s)}
                            disabled={busy}
                            className="text-xs px-3 py-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] disabled:opacity-50 transition-colors"
                        >
                            {s}
                        </button>
                    ))}
                </div>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        ask();
                    }}
                    className="flex gap-2"
                >
                    <Input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Ask your own question…"
                        disabled={busy}
                        aria-label="Ask a test question"
                    />
                    <Button type="submit" size="md" disabled={busy || !input.trim()} aria-label="Ask">
                        <Send size={15} />
                    </Button>
                </form>
            </div>

            <div>
                <Button size="lg" variant="outline" onClick={() => onDone?.()}>
                    Continue to appearance <ArrowRight size={16} />
                </Button>
            </div>
        </div>
    );
}
