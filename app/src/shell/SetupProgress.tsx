import { NavLink } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { cn, Tooltip } from '../ui';
import { useSetupChecklist } from '../onboarding/useSetupChecklist';

/**
 * The onboarding checklist, reduced to a ring.
 *
 * Onboarding lives in the shell rather than in a wizard, so its progress lives
 * where the user already looks. It is **collapsible, never dismissible** — the
 * people who dismiss a setup checklist are the people who most need it — and it
 * removes itself once complete.
 *
 * Progress is derived from server state and is monotonic, so deleting a document
 * cannot un-complete "train" and cancelling a crawl cannot make the ring go
 * backwards. See `useSetupChecklist`.
 */
export function SetupProgress({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const { done, total, complete, loading } = useSetupChecklist();

  if (loading || complete) return null;

  const fraction = total === 0 ? 0 : done / total;
  const circumference = 2 * Math.PI * 7;

  const ring = (
    <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
      <svg aria-hidden viewBox="0 0 18 18" className="h-full w-full -rotate-90">
        <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2" className="stroke-rail-border" />
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
    </span>
  );

  return (
    <Tooltip content={`Setup — ${done} of ${total} done`} side="right" disabled={!collapsed}>
      <NavLink
        to="/setup"
        onClick={onNavigate}
        className={cn(
          'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium',
          'text-rail-text-muted transition-colors hover:bg-rail-hover hover:text-rail-text',
          collapsed && 'justify-center px-0',
        )}
      >
        {done === total ? (
          <CheckCircle2 aria-hidden className="h-5 w-5 shrink-0 text-success-fill" />
        ) : (
          ring
        )}
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1 truncate">Setup</span>
            <span className="figure shrink-0 text-2xs text-rail-text-muted">
              {done}/{total}
            </span>
          </>
        ) : null}
      </NavLink>
    </Tooltip>
  );
}
