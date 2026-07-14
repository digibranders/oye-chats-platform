import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import OyeChatsMark from '../../components/OyeChatsMark';
import { MILESTONES, milestoneIndex } from './studioMilestones';

/**
 * The Build Studio shell — a dedicated, full-screen guided onboarding mode
 * (no sidebar/topbar) mounted at /build. It renders the milestone spine and a
 * split layout: a guide pane (Otto) on the left and a live-agent preview on the
 * right. The individual milestone steps (Create / Train / Test / Appearance /
 * Go live) are wired in Workstream E; this scaffold provides the frame,
 * navigation, and resumability (the current milestone lives in the ?m= param).
 */
export default function BuildStudio() {
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const current = milestoneIndex(params.get('m'));
    const milestone = MILESTONES[current];
    const pct = MILESTONES.length > 1 ? Math.round((current / (MILESTONES.length - 1)) * 100) : 0;

    const goTo = (i) => {
        const clamped = Math.max(0, Math.min(MILESTONES.length - 1, i));
        setParams({ m: MILESTONES[clamped].key });
    };

    return (
        <div className="min-h-screen flex flex-col bg-white dark:bg-surface-950 text-surface-900 dark:text-surface-50">
            {/* App bar */}
            <header className="h-14 shrink-0 flex items-center gap-3 px-5 border-b border-surface-200 dark:border-surface-800">
                <OyeChatsMark size={28} />
                <span className="font-semibold tracking-tight">Build Studio</span>
                <span className="ml-auto font-mono text-[11px] text-surface-400 dark:text-surface-500">
                    ✓ saved · resume anytime
                </span>
            </header>

            {/* Milestone spine */}
            <div className="px-6 pt-4 pb-3 border-b border-surface-200 dark:border-surface-800">
                <div className="flex items-center justify-between font-mono text-[11px] text-surface-400 dark:text-surface-500 mb-2">
                    <span>
                        Milestone {current + 1} of {MILESTONES.length}
                    </span>
                    <span className="text-surface-600 dark:text-surface-300">{milestone.title}</span>
                </div>
                <div className="relative h-7 max-w-3xl">
                    <div className="absolute top-3 inset-x-0 h-[3px] rounded bg-surface-200 dark:bg-surface-800" />
                    <div
                        className="absolute top-3 left-0 h-[3px] rounded bg-primary-500 transition-[width] duration-500 motion-reduce:transition-none"
                        style={{ width: `${pct}%` }}
                    />
                    <div className="absolute inset-0 flex justify-between">
                        {MILESTONES.map((m, i) => {
                            const done = i < current;
                            const active = i === current;
                            return (
                                <button
                                    key={m.key}
                                    type="button"
                                    onClick={() => goTo(i)}
                                    aria-current={active ? 'step' : undefined}
                                    aria-label={`Milestone ${i + 1}: ${m.label}`}
                                    className="flex flex-col items-center gap-1.5 focus-ring"
                                >
                                    <span
                                        className={[
                                            'w-6 h-6 rounded-full grid place-items-center font-mono text-[11px] border-2 transition-colors',
                                            done
                                                ? 'bg-primary-500 border-primary-500 text-white'
                                                : active
                                                  ? 'border-primary-500 text-primary-600 dark:text-primary-400 ring-4 ring-primary-500/15'
                                                  : 'border-surface-300 dark:border-surface-700 text-surface-400 dark:text-surface-500 bg-white dark:bg-surface-950',
                                        ].join(' ')}
                                    >
                                        {done ? <Check size={12} strokeWidth={3} /> : i + 1}
                                    </span>
                                    <span
                                        className={[
                                            'font-mono text-[10px] tracking-wide hidden sm:inline',
                                            active
                                                ? 'text-surface-900 dark:text-surface-100 font-semibold'
                                                : 'text-surface-400 dark:text-surface-500',
                                        ].join(' ')}
                                    >
                                        {m.label}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* Split body */}
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1.1fr_1fr]">
                {/* Guide pane */}
                <div className="p-6 border-b lg:border-b-0 lg:border-r border-surface-200 dark:border-surface-800 flex flex-col gap-4">
                    <div className="flex gap-3">
                        <div
                            className="w-9 h-9 shrink-0 rounded-xl grid place-items-center text-white font-bold text-sm"
                            style={{ background: 'linear-gradient(135deg, #6366f1, #a21caf)' }}
                            aria-hidden="true"
                        >
                            O
                        </div>
                        <div className="bg-surface-50 dark:bg-surface-900 border border-surface-200 dark:border-surface-800 rounded-xl rounded-tl-sm px-4 py-3 text-sm">
                            <div className="font-mono text-[10px] uppercase tracking-wider text-surface-400 dark:text-surface-500 mb-1">
                                Otto · your setup guide
                            </div>
                            <p className="text-surface-700 dark:text-surface-200">
                                {milestone.title}. This milestone is being wired up next — the shell,
                                progress, and navigation are live.
                            </p>
                        </div>
                    </div>

                    <div className="flex-1 min-h-[180px] rounded-xl border border-dashed border-surface-300 dark:border-surface-700 grid place-items-center text-surface-400 dark:text-surface-500 text-sm">
                        {milestone.label} step
                    </div>

                    <div className="mt-auto flex items-center gap-3 flex-wrap">
                        {current > 0 && (
                            <button
                                type="button"
                                onClick={() => goTo(current - 1)}
                                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-surface-300 dark:border-surface-700 hover:border-surface-400 dark:hover:border-surface-600 focus-ring"
                            >
                                <ArrowLeft size={15} /> Back
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => goTo(current + 1)}
                            disabled={current === MILESTONES.length - 1}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed focus-ring"
                        >
                            {current < MILESTONES.length - 1 ? (
                                <>
                                    Next <ArrowRight size={15} />
                                </>
                            ) : (
                                'Finish'
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={() => navigate('/')}
                            className="ml-auto text-xs font-medium text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 focus-ring"
                        >
                            Skip to dashboard
                        </button>
                    </div>
                </div>

                {/* Live-agent pane */}
                <div className="p-5 bg-surface-50 dark:bg-surface-900/40 flex flex-col gap-3">
                    <div className="font-mono text-[10px] uppercase tracking-wider text-surface-400 dark:text-surface-500">
                        Your live agent
                    </div>
                    <div className="flex-1 min-h-[220px] rounded-2xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 grid place-items-center p-6 text-center">
                        <p className="text-sm text-surface-400 dark:text-surface-500 max-w-[24ch]">
                            Your agent will come alive here as you build it.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
