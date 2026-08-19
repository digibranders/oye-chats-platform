import { type ReactNode } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { cn } from '../lib/cn';

/**
 * Mount once, near the root. Owns the shared open/close timing so moving between
 * two adjacent icon buttons does not re-run the full delay each time.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  /** The element the tooltip describes. Must accept a ref. */
  children: ReactNode;
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** Skip rendering, e.g. when a sidebar is expanded and the label is visible. */
  disabled?: boolean;
}

/**
 * A hint attached to a control.
 *
 * This exists because the previous system did not have one and reached for the
 * native `title` attribute 203 times instead. `title` cannot be reached by
 * keyboard, never appears on touch, cannot be styled, and waits about a second
 * before showing — so on an icon-only button it is, in practice, no label at all.
 *
 * A tooltip is never the only place a fact lives. It explains a control whose
 * icon is already labelled by `aria-label`; it does not carry information the
 * user needs in order to decide.
 */
export function Tooltip({ children, content, side = 'top', align = 'center', disabled }: TooltipProps) {
  if (disabled) return <>{children}</>;

  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-50 max-w-xs rounded-sm bg-ink px-2 py-1 text-xs leading-snug text-text-inverse shadow-md',
            'motion-pop',
          )}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
