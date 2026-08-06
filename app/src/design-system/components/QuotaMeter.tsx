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
 * "Unlimited" pill instead of a bar.
 *
 * The state is carried primarily by the *fraction* (muted → amber near the
 * ceiling → red only when genuinely over), with the bar colour following via a
 * scoped `--ds-accent` override. Being exactly at the limit is amber, not red -
 * a full plan is not an error - and going over adds an explicit "Over by N"
 * note so the red reads as a clear signal, never a broken-looking slab.
 */
export function QuotaMeter({ label, used, limit, className }: QuotaMeterProps): ReactElement {
  const isUnlimited = limit === UNLIMITED;
  const hasLimit = !isUnlimited && limit > 0;
  const percent = hasLimit ? Math.min(100, (used / limit) * 100) : 0;
  const over = hasLimit && used > limit;
  const near = hasLimit && !over && percent >= WARNING_THRESHOLD;

  const stateColor = over ? 'var(--ds-danger)' : near ? 'var(--ds-warning)' : null;
  const fillOverride = stateColor ? ({ '--ds-accent': stateColor } as CSSProperties) : undefined;
  const valueTone = over
    ? 'text-[var(--ds-danger)]'
    : near
      ? 'text-[var(--ds-warning)]'
      : 'text-[var(--ds-text-muted)]';

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between text-[12px]">
        <span className="font-medium text-[var(--ds-text)]">{label}</span>
        <span className={cn('font-medium tabular-nums', valueTone)}>
          {isUnlimited
            ? `${used.toLocaleString()} used`
            : `${used.toLocaleString()} / ${limit.toLocaleString()}`}
        </span>
      </div>
      {isUnlimited ? (
        <p className="text-[11px] font-medium text-[var(--ds-success)]">Unlimited</p>
      ) : (
        <div style={fillOverride}>
          <Progress value={percent} label={`${label}: ${used} of ${limit} used`} />
        </div>
      )}
      {over && (
        <p className="text-[11px] font-medium text-[var(--ds-danger)]">
          Over by {(used - limit).toLocaleString()}
        </p>
      )}
    </div>
  );
}
