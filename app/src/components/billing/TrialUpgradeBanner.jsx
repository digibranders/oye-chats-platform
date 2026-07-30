import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpRight, Clock, Sparkles, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { daysUntil, formatTrialDate, trialDaysLeft } from '../../utils/trial';

/**
 * TrialUpgradeBanner - the missing "you decided to pay, here's the button"
 * surface for two moments in the free-trial lifecycle:
 *
 *   1. **In-trial** (`subscription.status === 'trialing'`) - nudges the
 *      customer to authorise a paid mandate before the trial expires, so
 *      the chatbot never goes offline. Copy softens for the first few
 *      days, sharpens to warning at ≤2 days left, escalates to alarm on
 *      the day of expiry.
 *
 *   2. **In grace window** (`subscription.status === 'trial_expired'` with
 *      `data_retention_until` still in the future) - the bot is already
 *      showing the offline-message payload to visitors, but the workspace
 *      data is preserved for another 15 days (see `TRIAL_DATA_RETENTION_DAYS`
 *      in the backend). Copy emphasises the deletion deadline instead of
 *      lost service, because at this point restoring service is the pitch.
 *
 * Anything else (active paid, canceled, free tier) → returns null.
 *
 * The banner re-computes its urgency tier every 60s so a page left open
 * across a day boundary transitions from "safe" to "warning" without a
 * refresh. Ticks in tests are frozen via the `nowMs` prop.
 */
export default function TrialUpgradeBanner({
  subscription,
  planName,
  onUpgradeClick,
  // Test hook - freeze the reference "now" for deterministic snapshots.
  nowMs: nowMsProp,
}) {
  const [now, setNow] = useState(() => nowMsProp ?? Date.now());
  useEffect(() => {
    if (nowMsProp !== undefined) return undefined;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [nowMsProp]);

  // Session-scoped dismissal for the LOW-urgency in-trial banner only.
  // High-urgency (≤3 days left, or any post-trial grace state) intentionally
  // ignores this - that banner is a "your data is about to be deleted"
  // notice, not a marketing nudge, so it must not be dismissable.
  const [dismissed, setDismissed] = useState(false);

  const status = subscription?.status || null;
  const trialEndIso = subscription?.trial_end || null;
  const retentionIso = subscription?.data_retention_until || null;

  const view = useMemo(() => {
    if (!status) return null;
    if (status === 'trialing' && trialEndIso) {
      const daysLeft = trialDaysLeft(trialEndIso, now);
      if (daysLeft === null) return null;
      // 7-day trial: banner is visible for the full window (there is no
      // "way too early" phase to hide it in). Info tone at 4–7 days left,
      // warning at ≤2, alarm on the day of. "Trial technically over but
      // the flip cron hasn't fired yet" still shows the trialing copy
      // because the retention window hasn't started; we can't yet quote
      // a deletion date.
      const TRIAL_BANNER_DAYS = 7;
      if (daysLeft > TRIAL_BANNER_DAYS) return null;
      const urgency = daysLeft <= 0 ? 'alarm' : daysLeft <= 2 ? 'warning' : 'info';
      return { kind: 'trialing', daysLeft, deadlineIso: trialEndIso, urgency };
    }
    if (status === 'trial_expired' && retentionIso) {
      const daysLeft = daysUntil(retentionIso, now);
      if (daysLeft === null) return null;
      // Once the retention window has itself elapsed, the purge cron will
      // fire on its next tick - nothing to upsell, hide the banner.
      if (daysLeft < 0) return null;
      const urgency = daysLeft <= 3 ? 'alarm' : daysLeft <= 7 ? 'warning' : 'warning';
      return { kind: 'trial_expired', daysLeft, deadlineIso: retentionIso, urgency };
    }
    return null;
  }, [status, trialEndIso, retentionIso, now]);

  if (!view) return null;

  // Dismissal only affects the informational (>3 days remaining) in-trial
  // variant. Everything else must remain visible until the customer either
  // upgrades or the banner condition itself changes.
  const canDismiss = view.kind === 'trialing' && view.urgency === 'info';
  if (canDismiss && dismissed) return null;

  const theme = THEMES[view.urgency];
  const Icon = view.kind === 'trialing' ? Clock : AlertTriangle;

  const { headline, body } = copyFor(view, planName);

  return (
    <div
      role={view.urgency === 'alarm' ? 'alert' : 'status'}
      aria-live={view.urgency === 'alarm' ? 'assertive' : 'polite'}
      className={cn(
        'mb-4 rounded-xl border px-4 py-3 sm:px-5 sm:py-3.5 flex flex-col sm:flex-row sm:items-center gap-2.5 sm:gap-4',
        theme.container,
      )}
    >
      <div className={cn('flex-shrink-0 rounded-lg p-1.5', theme.iconBg)}>
        <Icon className={cn('w-4 h-4', theme.iconColor)} />
      </div>

      <div className="flex-1 min-w-0">
        <div className={cn('font-semibold text-[13px] leading-tight', theme.headline)}>
          {headline}
        </div>
        <div className={cn('mt-0.5 text-[12px] leading-relaxed', theme.body)}>
          {body}
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          type="button"
          onClick={onUpgradeClick}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold',
            'transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-2',
            'focus-visible:ring-offset-transparent',
            theme.button,
          )}
        >
          <Sparkles className="w-3.5 h-3.5" />
          Upgrade to Paid
          <ArrowUpRight className="w-3 h-3" />
        </button>
        {canDismiss && (
          <button
            type="button"
            aria-label="Dismiss for this session"
            onClick={() => setDismissed(true)}
            className={cn(
              'rounded-md p-1.5 transition-colors',
              theme.dismiss,
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-1',
              'focus-visible:ring-offset-transparent',
            )}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Copy ─────────────────────────────────────────────────────────────────────
// Extracted so the JSX above stays a layout, not a wall of ternaries. Each
// branch quotes an absolute date (not just "in X days") so a customer who
// glances at the banner without reading closely still walks away with the
// deadline in mind.

function copyFor(view, planName) {
  const planLabel = planName ? ` ${planName}` : '';
  const deadline = formatTrialDate(view.deadlineIso);

  if (view.kind === 'trialing') {
    if (view.daysLeft <= 0) {
      return {
        headline: `Your${planLabel} trial ends today.`,
        body:
          `Add a payment method now to keep your chatbot answering visitors ` +
          `past ${deadline}. You won't be charged until the trial actually ends.`,
      };
    }
    if (view.daysLeft === 1) {
      return {
        headline: `1 day left in your${planLabel} trial.`,
        body:
          `Authorise your card or UPI before ${deadline} and your chatbot ` +
          `stays live without interruption. Billing only starts when the trial ends.`,
      };
    }
    if (view.daysLeft <= 3) {
      return {
        headline: `${view.daysLeft} days left in your${planLabel} trial.`,
        body:
          `Set up your paid subscription now so your bot keeps serving visitors ` +
          `after ${deadline}. We only start charging when the trial ends.`,
      };
    }
    return {
      headline: `You're on a free${planLabel} trial.`,
      body:
        `Enjoying it? Lock in your paid subscription now so nothing pauses on ` +
        `${deadline} when the trial ends. First charge only fires at that point.`,
    };
  }

  // trial_expired - grace window
  if (view.daysLeft <= 0) {
    return {
      headline: 'Your workspace is scheduled for deletion today.',
      body:
        `Your${planLabel} trial ended and the retention window is up. Upgrade ` +
        `now to keep your knowledge base, leads and bot settings.`,
    };
  }
  if (view.daysLeft <= 3) {
    return {
      headline: `Your data will be deleted in ${view.daysLeft} ${view.daysLeft === 1 ? 'day' : 'days'}.`,
      body:
        `Your${planLabel} trial has ended, and your chatbot is offline on ` +
        `visitor sites. Upgrade before ${deadline} to keep your knowledge base, ` +
        `leads and settings - after that, everything is permanently deleted.`,
    };
  }
  return {
    headline: 'Your trial has ended - your chatbot is offline.',
    body:
      `Visitors currently see your offline message. Your workspace (knowledge ` +
      `base, leads, bot settings) stays intact until ${deadline}, then gets ` +
      `permanently deleted. Upgrade to bring the bot back live.`,
  };
}

// ── Theme tokens ─────────────────────────────────────────────────────────────
// Tailwind class strings kept in one object so a designer can retint the
// whole banner from a single spot instead of hunting through JSX. Dark-mode
// tokens use the surface- palette elsewhere in the app; here we lean on
// Tailwind's own colour ramp with /10 backgrounds for subtle-in-dark.

const THEMES = {
  info: {
    container:
      'border-primary-200 bg-primary-50 text-primary-900 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-100',
    iconBg: 'bg-primary-100 dark:bg-primary-500/20',
    iconColor: 'text-primary-600 dark:text-primary-300',
    headline: 'text-primary-900 dark:text-primary-50',
    body: 'text-primary-900/80 dark:text-primary-100/80',
    button:
      'bg-primary-600 text-white hover:bg-primary-700 focus-visible:ring-[var(--focus-ring)] ' +
      'dark:bg-primary-500 dark:hover:bg-primary-400',
    dismiss:
      'text-primary-700 hover:bg-primary-100 focus-visible:ring-[var(--focus-ring)] ' +
      'dark:text-primary-200 dark:hover:bg-primary-500/20',
  },
  warning: {
    container:
      'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100',
    iconBg: 'bg-amber-100 dark:bg-amber-500/20',
    iconColor: 'text-amber-600 dark:text-amber-300',
    headline: 'text-amber-950 dark:text-amber-50',
    body: 'text-amber-900/85 dark:text-amber-100/85',
    button:
      'bg-amber-600 text-white hover:bg-amber-700 focus-visible:ring-amber-500 ' +
      'dark:bg-amber-500 dark:hover:bg-amber-400',
    dismiss:
      'text-amber-700 hover:bg-amber-100 focus-visible:ring-amber-500 ' +
      'dark:text-amber-200 dark:hover:bg-amber-500/20',
  },
  alarm: {
    container:
      'border-rose-200 bg-rose-50 text-rose-950 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100',
    iconBg: 'bg-rose-100 dark:bg-rose-500/20',
    iconColor: 'text-rose-600 dark:text-rose-300',
    headline: 'text-rose-950 dark:text-rose-50',
    body: 'text-rose-900/85 dark:text-rose-100/85',
    button:
      'bg-rose-600 text-white hover:bg-rose-700 focus-visible:ring-rose-500 ' +
      'dark:bg-rose-500 dark:hover:bg-rose-400',
    dismiss:
      'text-rose-700 hover:bg-rose-100 focus-visible:ring-rose-500 ' +
      'dark:text-rose-200 dark:hover:bg-rose-500/20',
  },
};
