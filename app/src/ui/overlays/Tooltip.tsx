import { type ReactNode } from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { cn } from '../lib/cn';

/**
 * Mount once, near the root. Owns the shared open/close timing so moving between
 * two adjacent icon buttons does not re-run the full delay each time.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <BaseTooltip.Provider delay={400} closeDelay={100}>
      {children}
    </BaseTooltip.Provider>
  );
}

export interface TooltipProps {
  /** The element the tooltip describes. Must accept a ref. */
  children: ReactNode;
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** Skip rendering, e.g. when a rail is expanded and the label is visible. */
  disabled?: boolean;
}

/**
 * A hint attached to a control.
 *
 * This exists because the system it replaces did not have one and reached for
 * the native `title` attribute 203 times instead. `title` cannot be reached by
 * keyboard, never appears on touch, cannot be styled, and waits about a second
 * before showing — so on an icon-only button it is, in practice, no label at all.
 *
 * A tooltip is never the only place a fact lives. It explains a control whose
 * icon is already named by `aria-label`; it does not carry information the user
 * needs in order to decide.
 */
export function Tooltip({ children, content, side = 'top', align = 'center', disabled }: TooltipProps) {
  if (disabled) return <>{children}</>;

  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={<>{children}</>} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} align={align} sideOffset={6} collisionPadding={8}>
          <BaseTooltip.Popup
            className={cn(
              'motion-pop z-[var(--z-overlay)] max-w-xs rounded-sm bg-ink px-2 py-1',
              'text-xs leading-snug text-text-inverse shadow-md',
            )}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
