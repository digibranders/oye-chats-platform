import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import PageHeader from '../../components/PageHeader';
import OyeChatsMark from '../../components/OyeChatsMark';
import { Button } from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import { cn } from '../../lib/utils';
import { MILESTONES, milestoneIndex } from './studioMilestones';
import CreateStep from './steps/CreateStep';
import TrainStep from './steps/TrainStep';
import TestStep from './steps/TestStep';
import AppearanceStep from './steps/AppearanceStep';
import GoLiveStep from './steps/GoLiveStep';
import LiveAgentPreview from './LiveAgentPreview';

const EASE = [0.16, 1, 0.3, 1];

// Scripted Otto guidance per milestone (an AI-driven Otto is a future upgrade).
const OTTO = {
    create: "Welcome! Let's build your first agent. Give it a name and point me at your website — I'll take it from there.",
    train: "Now let's train it on your site — I'll find your pages first, then you pick which ones to crawl.",
    test: "Before it talks to real customers, let's pressure-test it with a few real questions.",
    appearance: 'I pulled your brand colours from your site, so it already looks on-brand. Tweak it or skip — no pressure.',
    golive: "Last step — put it on your site. I'll tell you the moment it's live.",
};

function Stepper({ current, onStep }) {
    return (
        <div className="relative">
            <div className="absolute top-[13px] left-0 right-0 h-[2px] rounded-full bg-[var(--border)]" />
            <motion.div
                className="absolute top-[13px] left-0 h-[2px] rounded-full bg-primary-500"
                animate={{ width: `${MILESTONES.length > 1 ? (current / (MILESTONES.length - 1)) * 100 : 0}%` }}
                transition={{ duration: 0.6, ease: EASE }}
            />
            <ol className="relative flex justify-between">
                {MILESTONES.map((m, i) => {
                    const done = i < current;
                    const active = i === current;
                    return (
                        <li key={m.key}>
                            <button
                                type="button"
                                onClick={() => onStep(i)}
                                aria-current={active ? 'step' : undefined}
                                aria-label={`Step ${i + 1}: ${m.label}`}
                                className="group flex flex-col items-center gap-2"
                            >
                                <span
                                    className={cn(
                                        'w-7 h-7 rounded-full grid place-items-center text-xs font-semibold border-2 transition-colors',
                                        done
                                            ? 'bg-primary-500 border-primary-500 text-white'
                                            : active
                                              ? 'border-primary-500 text-primary-600 dark:text-primary-400 bg-[var(--bg-card)] ring-4 ring-primary-500/12'
                                              : 'border-[var(--border)] text-[var(--text-muted)] bg-[var(--bg-card)] group-hover:border-[var(--border-hover)]'
                                    )}
                                >
                                    {done ? <Check size={13} strokeWidth={3} /> : i + 1}
                                </span>
                                <span
                                    className={cn(
                                        'text-[11px] font-medium hidden sm:block transition-colors',
                                        active ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'
                                    )}
                                >
                                    {m.label}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

/**
 * The Build Studio shell — a dedicated, full-screen guided onboarding mode
 * (no sidebar/topbar). Milestone stepper on top; a guide column (Otto + the
 * active step) beside a live preview of the agent as it comes together.
 */
export default function BuildStudio() {
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const current = milestoneIndex(params.get('m'));
    const milestone = MILESTONES[current];
    // Live override so the Appearance step can recolour the preview in real time.
    const [previewColor, setPreviewColor] = useState(null);

    const goTo = (i) => {
        const clamped = Math.max(0, Math.min(MILESTONES.length - 1, i));
        setPreviewColor(null);
        setParams({ m: MILESTONES[clamped].key });
    };
    const goNext = () => goTo(current + 1);

    const renderStep = () => {
        switch (milestone.key) {
            case 'create':
                return <CreateStep onCreated={goNext} />;
            case 'train':
                return <TrainStep onDone={goNext} />;
            case 'test':
                return <TestStep onDone={goNext} />;
            case 'appearance':
                return <AppearanceStep onDone={goNext} onPreviewColor={setPreviewColor} />;
            case 'golive':
                return <GoLiveStep />;
            default:
                return (
                    <div className="flex flex-col gap-5">
                        <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-muted)]/40 px-5 py-8 text-center text-sm text-[var(--text-muted)]">
                            The <span className="text-[var(--text-secondary)] font-medium">{milestone.label}</span> step is coming
                            next.
                        </div>
                        <Button size="lg" className="self-start" onClick={goNext} disabled={current === MILESTONES.length - 1}>
                            {current < MILESTONES.length - 1 ? 'Next' : 'Finish'}
                            <ArrowRight size={16} />
                        </Button>
                    </div>
                );
        }
    };

    return (
        <>
            <PageHeader
                crumbs={[
                    { label: 'Home', to: '/' },
                    { label: 'Set up your agent' },
                ]}
                title="Set up your agent"
                actions={
                    <div className="flex items-center gap-2 sm:gap-3">
                        <Badge variant="soft" color="success" size="sm" dot>
                            Progress saved
                        </Badge>
                        <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
                            Skip to dashboard
                        </Button>
                    </div>
                }
            />
            <MotionConfig reducedMotion="user">
                {/* Stepper */}
                <div className="max-w-2xl mx-auto pt-1 pb-8">
                    <Stepper current={current} onStep={goTo} />
                </div>

                {/* Body */}
                <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] gap-10 lg:gap-14 items-start pb-6">
                    {/* Guide column */}
                    <div className="flex flex-col gap-6 min-h-[420px]">
                            <div>
                                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)] mb-1.5">
                                    Step {current + 1} of {MILESTONES.length}
                                </div>
                                <h1 className="text-2xl font-semibold tracking-tight text-balance">{milestone.title}</h1>
                            </div>

                            <div className="flex gap-3">
                                <div
                                    className="w-9 h-9 shrink-0 rounded-xl grid place-items-center overflow-hidden bg-[var(--bg-card)] border border-[var(--border)]"
                                    aria-hidden="true"
                                >
                                    <OyeChatsMark size={28} />
                                </div>
                                <div className="rounded-2xl rounded-tl-md bg-[var(--bg-muted)] px-4 py-3 text-sm text-[var(--text-secondary)] max-w-prose">
                                    {OTTO[milestone.key]}
                                </div>
                            </div>

                            <div className="flex-1">
                                <AnimatePresence mode="wait">
                                    <motion.div
                                        key={milestone.key}
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -6 }}
                                        transition={{ duration: 0.3, ease: EASE }}
                                    >
                                        {renderStep()}
                                    </motion.div>
                                </AnimatePresence>
                            </div>

                            {current > 0 && (
                                <div>
                                    <Button variant="ghost" size="sm" onClick={() => goTo(current - 1)}>
                                        <ArrowLeft size={15} /> Back
                                    </Button>
                                </div>
                            )}
                        </div>

                        {/* Live preview column */}
                        <div className="w-full lg:sticky lg:top-28">
                            <LiveAgentPreview previewColor={previewColor} />
                        </div>
                    </div>
            </MotionConfig>
        </>
    );
}
