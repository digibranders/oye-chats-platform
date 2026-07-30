import type { CSSProperties, ReactElement } from 'react';
import { Progress } from '../primitives/Progress';
import { cn } from '../lib/cn';

/** Sentinel meaning "no limit" - mirrors `plan_entitlements_service.py::UNLIMITED`. */
const UNLIMITED = -1;
const WARNING_THRESHOLD = 80;

export interface QuotaMeterProps {
  /** What this meter measures, e.g. "Agents", "Documents". */
  label: string;
  /** Current usage count. */
  used: number;
  /** Configured ceiling. `-1` means unlimited. */
  limit: number;
  className?: string;
}

/**
 * QuotaMeter - a labeled "used / limit" meter built on the `Progress`
 * primitive (mandate shared component). `limit === -1` renders an
 * "Unlimited" pill instead of a bar. The fill color escalates via a scoped
 * `--ds-accent` override - the `Progress` primitive itself is untouched -
 * to `--ds-warning` at 80% and `--ds-danger` at 100%, so a glance at any
 * usage panel tells you whether an upgrade conversation is coming.
 */
export function QuotaMeter({ label, used, limit, className }: QuotaMeterProps): ReactElement {
  const isUnlimited = limit === UNLIMITED;
  const percent = isUnlimited || limit <= 0 ? 0 : Math.min(100, (used / limit) * 100);
  const fillVar = percent >= 100 ? 'var(--ds-danger)' : percent >= WARNING_THRESHOLD ? 'var(--ds-warning)' : 'var(--ds-accent)';
  const fillOverride = { '--ds-accent': fillVar } as CSSProperties;

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between text-[12px]">
        <span className="font-medium text-[var(--ds-text)]">{label}</span>
        <span className="text-[var(--ds-text-muted)]">
          {isUnlimited ? `${used.toLocaleString()} used` : `${used.toLocaleString()} / ${limit.toLocaleString()}`}
        </span>
      </div>
      {isUnlimited ? (
        <p className="text-[11px] font-medium text-[var(--ds-success)]">Unlimited</p>
      ) : (
        <div style={fillOverride}>
          <Progress value={percent} label={`${label}: ${used} of ${limit} used`} />
        </div>
      )}
    </div>
  );
}
