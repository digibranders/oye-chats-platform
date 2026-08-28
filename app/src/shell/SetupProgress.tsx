import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { RailItem } from '../ui';
import { useSetupChecklist } from '../onboarding/useSetupChecklist';
import { useTranslation } from '../i18n/useTranslation';

const DONE_KEY = 'oc_setup_done';

/**
 * The onboarding checklist, reduced to a ring on a nav row.
 *
 * Onboarding lives in the shell rather than in a wizard, so its progress lives
 * where the user already looks — directly under the destinations, not in the
 * footer under a hairline between the platform link and Settings, which is the
 * part of the chrome people learn to ignore.
 *
 * It is **collapsible, never dismissible** while there is work left: the people
 * who dismiss a setup checklist are the people who most need it. Once every
 * step is done it says so, for one session, and then removes itself. The
 * version this replaces returned `null` the moment `complete` went true, which
 * left an unreachable branch of a green check somebody had written, and meant
 * the customer who finished the sixth step got no confirmation at all — the row
 * simply vanished on the next poll.
 *
 * Progress is derived from server state and is monotonic, so deleting a
 * document cannot un-complete "train" and cancelling a crawl cannot make the
 * ring go backwards. See `useSetupChecklist`.
 */
export function SetupProgress({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const { done, total, complete, loading } = useSetupChecklist();
  // Read once, at mount: the effect below writes the flag as soon as the
  // checklist completes, and reading it live would hide the confirmation in the
  // same frame it was earned.
  const [alreadySeen] = useState(() => {
    try {
      return localStorage.getItem(DONE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!complete || alreadySeen) return;
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      // Storage disabled: the row returns next session, which is the harmless
      // direction to fail in.
    }
  }, [complete, alreadySeen]);

  if (loading || (complete && alreadySeen)) return null;

  const fraction = total === 0 ? 0 : done / total;
  const circumference = 2 * Math.PI * 7;

  // Inside the shared 16px glyph box, like every other leading mark in the
  // rail. It used to be a 20px ring in a 16px column, which is one of the six
  // left edges the rail had.
  const ring = (
    <svg aria-hidden viewBox="0 0 18 18" className="h-icon-md w-icon-md -rotate-90">
      {/* `--color-rail-track`, not `--color-rail-border`: the border measures
          1.14:1 on the rail, so the unfilled portion of the ring — the whole
          point of the affordance — could not be seen. */}
      <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2" className="stroke-rail-track" />
      <circle
        cx="9"
        cy="9"
        r="7"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-rail-accent transition-[stroke-dashoffset] duration-[var(--dur-slow)]"
        style={{
          strokeDasharray: circumference,
          strokeDashoffset: circumference * (1 - fraction),
        }}
      />
    </svg>
  );

  return (
    <RailItem
      to="/setup"
      label={complete ? t('shell.setupComplete') || 'Setup complete' : t('shell.finishSetup') || 'Finish setup'}
      collapsed={collapsed}
      onNavigate={onNavigate}
      glyph={
        complete ? (
          <CheckCircle2 aria-hidden className="h-icon-md w-icon-md text-rail-success" />
        ) : (
          ring
        )
      }
      trailing={
        <span className="figure text-2xs text-rail-text-muted">
          {done}/{total}
        </span>
      }
    />
  );
}
