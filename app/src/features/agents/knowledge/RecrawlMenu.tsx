import { type ReactElement } from 'react';
import { Loader2, RefreshCw, RotateCw, Sparkles } from 'lucide-react';
import { Popover, cn } from '../../../design-system';

export interface RecrawlMenuProps {
  /** Whether the plan can use delta ("updated pages only") recrawl. */
  canUseDelta: boolean;
  /** Fired when the user picks a full re-scrape. */
  onFullRecrawl: () => void;
  /** Fired when an entitled user picks the delta recrawl. */
  onDeltaRecrawl: () => void;
  /** Fired when a non-entitled user clicks the gated delta option. */
  onUpgrade: () => void;
  /** Show a spinner and disable the trigger while a diff/recrawl is in flight. */
  loading?: boolean;
  /** Hard-disable the trigger (e.g. a crawl is already running). */
  disabled?: boolean;
}

/**
 * RecrawlMenu — the two-mode re-crawl action for a website source.
 *
 * A subtle icon trigger opens a popover with two choices:
 *   1. Full recrawl — re-scrape every page, billed per page. Every plan.
 *   2. Updated pages only — skip unchanged pages, billing only what changed.
 *      A Standard+ perk; lower tiers see it dimmed with an upgrade CTA so the
 *      capability stays discoverable.
 *
 * Backend `plan_service` re-enforces the delta gate — this is a UX affordance,
 * not the security boundary.
 */
export function RecrawlMenu({
  canUseDelta,
  onFullRecrawl,
  onDeltaRecrawl,
  onUpgrade,
  loading = false,
  disabled = false,
}: RecrawlMenuProps): ReactElement {
  return (
    <Popover
      align="end"
      role="menu"
      panelClassName="w-72"
      trigger={({ setRef, onClick, ...aria }) => (
        <button
          ref={setRef}
          type="button"
          onClick={() => {
            if (disabled || loading) return;
            onClick();
          }}
          disabled={disabled || loading}
          aria-label="Re-train options"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-accent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] disabled:cursor-not-allowed disabled:opacity-50"
          {...aria}
        >
          {loading ? (
            <Loader2 size={16} className="animate-spin text-[var(--ds-accent)]" aria-hidden="true" />
          ) : (
            <RefreshCw size={16} aria-hidden="true" />
          )}
        </button>
      )}
    >
      {(close) => (
        <div className="py-1">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onFullRecrawl();
            }}
            className="flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:bg-[var(--ds-bg-hover)]"
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
              <RotateCw size={15} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-[var(--ds-text)]">Full re-train</span>
              <span className="mt-0.5 block text-[11px] text-[var(--ds-text-muted)]">
                Re-train every page. Charged for all pages.
              </span>
            </span>
          </button>

          <div className="mx-3.5 h-px bg-[var(--ds-border)]" />

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (!canUseDelta) {
                close();
                onUpgrade();
                return;
              }
              close();
              onDeltaRecrawl();
            }}
            className={cn(
              'flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors focus-visible:outline-none',
              canUseDelta
                ? 'hover:bg-[var(--ds-bg-hover)] focus-visible:bg-[var(--ds-bg-hover)]'
                : 'hover:bg-[var(--ds-warning-soft)] focus-visible:bg-[var(--ds-warning-soft)]',
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                canUseDelta
                  ? 'bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
                  : 'bg-[var(--ds-warning-soft)] text-[var(--ds-warning)]',
              )}
            >
              <Sparkles size={15} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    'text-[13px] font-medium',
                    canUseDelta ? 'text-[var(--ds-text)]' : 'text-[var(--ds-text-muted)]',
                  )}
                >
                  Updated pages only
                </span>
                {!canUseDelta && (
                  <span className="rounded bg-[var(--ds-warning-soft)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--ds-warning)]">
                    Standard
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-[11px] text-[var(--ds-text-muted)]">
                {canUseDelta
                  ? 'Only re-train pages whose content changed since the last training run.'
                  : 'Upgrade to Standard to re-train only pages that changed.'}
              </span>
            </span>
          </button>
        </div>
      )}
    </Popover>
  );
}
