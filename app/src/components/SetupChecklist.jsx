import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Check, Bot, BookOpen, Palette, Code2, Headphones, ArrowRight, X, Sparkles, Lock } from 'lucide-react';
import { getDocuments } from '../services/api';
import { cn } from '../lib/utils';

// Default bot brand color assigned at creation (CreateBotWizard). If the bot's
// primary_color still equals this, the user hasn't customized their look yet.
const DEFAULT_BOT_COLOR = '#a21caf';
const HIDDEN_KEY = 'oc_setup_hidden';

// Some steps can't be derived from server state yet (there's no widget
// install-detection heartbeat, and "customize" has no single flag), so we let
// the user assert them. These self-reports are stored PER BOT and are the only
// persisted state — the create/train/handoff steps are always re-derived from
// live data so the checklist can never drift from the truth.
const ackKey = (botId) => `oc_setup_ack_${botId}`;
function readAcks(botId) {
  if (!botId) return {};
  try {
    return JSON.parse(localStorage.getItem(ackKey(botId)) || '{}');
  } catch {
    return {};
  }
}
function writeAcks(botId, acks) {
  if (!botId) return;
  try {
    localStorage.setItem(ackKey(botId), JSON.stringify(acks));
  } catch {
    /* localStorage unavailable / quota — the checklist just stays derived-only */
  }
}

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
};

/**
 * Persistent, real-state-driven setup guide shown on the Dashboard. Replaces
 * the old modal OnboardingWizard: it never blocks the app, reflects what the
 * account has actually done, and stays available until setup is complete.
 */
export default function SetupChecklist({ bots, selectedBot, botsLoading }) {
  const navigate = useNavigate();
  const botId = selectedBot?.id ?? null;
  const hasBot = (bots?.length ?? 0) > 0;

  // null = not yet known (loading or fetch error) — we never treat "unknown"
  // as either trained or untrained.
  const [docCount, setDocCount] = useState(null);
  const [acks, setAcks] = useState(() => readAcks(botId));
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) === 'true');

  useEffect(() => {
    setAcks(readAcks(botId));
  }, [botId]);

  useEffect(() => {
    if (!botId) {
      setDocCount(hasBot ? null : 0);
      return;
    }
    let cancelled = false;
    getDocuments(botId)
      .then((docs) => {
        if (!cancelled) setDocCount(Array.isArray(docs) ? docs.length : 0);
      })
      .catch(() => {
        if (!cancelled) setDocCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, hasBot]);

  const setAck = useCallback(
    (key) => {
      setAcks((prev) => {
        const next = { ...prev, [key]: true };
        writeAcks(botId, next);
        return next;
      });
    },
    [botId],
  );

  const hide = useCallback(() => {
    setHidden(true);
    try {
      localStorage.setItem(HIDDEN_KEY, 'true');
    } catch { /* ignore */ }
  }, []);

  const resume = useCallback(() => {
    setHidden(false);
    try {
      localStorage.removeItem(HIDDEN_KEY);
    } catch { /* ignore */ }
  }, []);

  const customized = !!(
    (selectedBot?.primary_color &&
      selectedBot.primary_color.toLowerCase() !== DEFAULT_BOT_COLOR) ||
    acks.customize
  );

  const steps = useMemo(
    () => [
      {
        key: 'create',
        title: 'Create your chatbot',
        desc: 'Spin up your first AI assistant.',
        icon: Bot,
        done: hasBot,
        actionLabel: 'Create bot',
        to: '/chatbot',
      },
      {
        key: 'train',
        title: 'Train it on your content',
        desc: 'Crawl your website or upload docs so it answers from your material.',
        icon: BookOpen,
        done: (docCount ?? 0) > 0,
        locked: !hasBot,
        actionLabel: 'Add sources',
        to: '/knowledge',
      },
      {
        key: 'customize',
        title: 'Customize its look',
        desc: 'Match your brand color and avatar.',
        icon: Palette,
        optional: true,
        done: customized,
        locked: !hasBot,
        actionLabel: 'Customize',
        to: '/chatbot?tab=appearance',
        ack: 'customize',
      },
      {
        key: 'install',
        // Auto-detected: the backend stamps widget_installed_at the first time
        // the widget loads on a real external site. The manual ack stays as a
        // fallback for sites whose CSP strips the Origin header.
        title: 'Add the widget to your site',
        desc: "Paste one script tag — we'll detect it once it's live.",
        icon: Code2,
        done: !!selectedBot?.widget_installed_at || !!acks.install,
        locked: !hasBot,
        actionLabel: 'Get embed code',
        to: '/chatbot',
        ack: 'install',
      },
      {
        key: 'handoff',
        title: 'Turn on live handoff',
        desc: 'Let a human jump in for hot leads.',
        icon: Headphones,
        optional: true,
        done: !!selectedBot?.live_chat_enabled,
        locked: !hasBot,
        actionLabel: 'Set up team',
        to: '/team',
      },
    ],
    [hasBot, docCount, customized, acks.install, selectedBot?.widget_installed_at, selectedBot?.live_chat_enabled],
  );

  const completed = steps.filter((s) => s.done).length;
  const total = steps.length;
  const requiredDone = steps.filter((s) => !s.optional).every((s) => s.done);
  const allDone = completed === total;

  // Nothing to show while the very first bot list is still loading, or once the
  // account is fully set up.
  if (!hasBot && botsLoading) return null;
  if (allDone) return null;

  // Dismissed mid-setup (only once a bot exists) — offer a quiet way back.
  if (hidden && hasBot) {
    return (
      <motion.button
        variants={fadeUp}
        initial="initial"
        animate="animate"
        onClick={resume}
        className="flex w-full items-center gap-2 rounded-xl border border-dashed border-surface-300 dark:border-surface-700 bg-surface-50/60 dark:bg-surface-900/40 px-4 py-2.5 text-sm font-medium text-surface-600 dark:text-surface-300 transition-colors hover:border-primary-400 hover:text-primary-600 dark:hover:text-primary-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40"
      >
        <Sparkles size={15} className="text-primary-500" />
        Resume setup — {completed} of {total} steps done
        <ArrowRight size={14} className="ml-auto" />
      </motion.button>
    );
  }

  const goTo = (step) => {
    if (step.locked) return;
    navigate(step.to);
  };

  return (
    <motion.section
      variants={fadeUp}
      initial="initial"
      animate="animate"
      aria-labelledby="setup-checklist-heading"
      className="overflow-hidden rounded-2xl border border-surface-200 dark:border-surface-700 bg-[var(--bg-card)] dark:bg-surface-900 shadow-sm"
    >
      <div className="flex items-start gap-4 border-b border-surface-100 dark:border-surface-800 p-5 sm:p-6">
        <div className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-lg shadow-primary-500/20">
          <Sparkles size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="setup-checklist-heading" className="text-base font-bold text-surface-900 dark:text-surface-100">
            {requiredDone ? "You're live — a couple of optional touches left" : 'Get your bot live'}
          </h2>
          <p className="mt-0.5 text-sm text-surface-500 dark:text-surface-400">
            {requiredDone
              ? 'Your bot is trained and installable. These extras sharpen the experience.'
              : 'A few quick steps to a working chatbot on your site.'}
          </p>
          <div className="mt-3 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-100 dark:bg-surface-800">
              <div
                className="h-full rounded-full bg-primary-500 transition-all duration-500"
                style={{ width: `${(completed / total) * 100}%` }}
              />
            </div>
            <span className="flex-none text-xs font-semibold tabular-nums text-surface-500 dark:text-surface-400">
              {completed}/{total}
            </span>
          </div>
        </div>
        {hasBot && (
          <button
            onClick={hide}
            aria-label="Hide setup guide"
            className="flex-none rounded-lg p-1.5 text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-600 dark:text-surface-500 dark:hover:bg-surface-800 dark:hover:text-surface-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <ul role="list" className="divide-y divide-surface-100 dark:divide-surface-800">
        {steps.map((step) => {
          const Icon = step.icon;
          const isNext = !step.done && !step.locked && steps.find((s) => !s.done && !s.locked)?.key === step.key;
          return (
            <li
              key={step.key}
              className={cn(
                'flex items-center gap-3.5 px-5 py-3.5 sm:px-6',
                isNext && 'bg-primary-50/40 dark:bg-primary-500/[0.06]',
              )}
            >
              {/* Status indicator */}
              <span
                aria-hidden="true"
                className={cn(
                  'flex h-8 w-8 flex-none items-center justify-center rounded-full border transition-colors',
                  step.done
                    ? 'border-emerald-500 bg-emerald-500 text-white'
                    : step.locked
                      ? 'border-surface-200 bg-surface-50 text-surface-300 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-600'
                      : 'border-surface-300 bg-transparent text-surface-400 dark:border-surface-600 dark:text-surface-500',
                )}
              >
                {step.done ? <Check size={16} /> : step.locked ? <Lock size={13} /> : <Icon size={15} />}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p
                    className={cn(
                      'truncate text-sm font-semibold',
                      step.done
                        ? 'text-surface-400 line-through decoration-surface-300 dark:text-surface-500'
                        : 'text-surface-900 dark:text-surface-100',
                    )}
                  >
                    {step.title}
                  </p>
                  {step.optional && !step.done && (
                    <span className="flex-none rounded-full bg-surface-100 px-1.5 py-0.5 text-[11px] font-medium text-surface-500 dark:bg-surface-800 dark:text-surface-400">
                      Optional
                    </span>
                  )}
                </div>
                {!step.done && (
                  <p className="mt-0.5 truncate text-xs text-surface-500 dark:text-surface-400">{step.desc}</p>
                )}
              </div>

              {/* Action */}
              {step.done ? (
                <span className="flex-none text-xs font-medium text-emerald-600 dark:text-emerald-400">Done</span>
              ) : (
                <div className="flex flex-none items-center gap-2">
                  {step.ack && (
                    <button
                      onClick={() => setAck(step.ack)}
                      className="hidden rounded-lg px-2 py-1 text-xs font-medium text-surface-500 transition-colors hover:text-primary-600 dark:text-surface-400 dark:hover:text-primary-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 sm:inline-block"
                    >
                      Mark done
                    </button>
                  )}
                  <button
                    onClick={() => goTo(step)}
                    disabled={step.locked}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                      isNext
                        ? 'bg-primary-600 text-white shadow-sm hover:bg-primary-700'
                        : 'border border-surface-200 text-surface-700 hover:bg-surface-50 dark:border-surface-700 dark:text-surface-300 dark:hover:bg-surface-800',
                      step.locked && 'cursor-not-allowed opacity-50 hover:bg-transparent dark:hover:bg-transparent',
                    )}
                  >
                    {step.actionLabel}
                    {!step.locked && <ArrowRight size={13} />}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </motion.section>
  );
}
