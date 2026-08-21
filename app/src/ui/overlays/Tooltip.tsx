import { type ReactElement, type ReactNode } from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { cn } from '../lib/cn';
import { PANEL_POSITIONER } from './panelStyles';

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
  /**
   * The single element the tooltip describes.
   *
   * A `ReactElement`, not a `ReactNode`: Base UI clones the trigger to attach
   * its handlers and its ref, and it can only do that to one element. An
   * earlier version typed this as `ReactNode` and wrapped it in a fragment,
   * which React cannot take props — every handler was dropped and no tooltip in
   * the app ever opened.
   */
  children: ReactElement;
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /**
   * Override the shared 400ms open delay.
   *
   * The one case that needs it is a truncated table cell, where the tooltip is
   * the only way to read the value and 400ms feels like the app is thinking.
   * ~150 is right there. Everywhere else the shared delay is what stops a dense
   * toolbar flashing tooltips as the pointer crosses it.
   */
  delay?: number;
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
 *
 * It is a 4px chip. It is the smallest floating thing in the system and it had
 * the second-largest small radius, so against a `Badge` and a `Kbd` — both 4 —
 * it looked inflated. Its leading comes from the `text-xs` rung and nowhere
 * else: `leading-snug` was overriding 12/18 with 12/16.8.
 */
export function Tooltip({
  children,
  content,
  side = 'top',
  align = 'center',
  delay,
  disabled,
}: TooltipProps) {
  const tooltip = (
    <BaseTooltip.Root>
      {/* The child itself is the trigger. Wrapping it in a fragment, or in a
          `span`, either drops the props Base UI attaches or inserts an element
          between the label and the control it names.

          `disabled` used to return a bare `<>{children}</>` here instead of
          reaching this point at all. That swaps the element tree, so React
          unmounts this trigger and mounts a fresh DOM node in its place —
          which breaks anything holding a ref to the old one. `NotificationBell`
          passes `disabled={open}`: the instant its popover opened, its own
          trigger was replaced, the popover's anchor ref went stale, and the
          panel rendered at the positioner's fallback origin instead of under
          the bell. Keeping the trigger mounted and only skipping the popup
          below is what disabled is actually meant to do. */}
      <BaseTooltip.Trigger render={children} />
      {disabled ? null : (
        <BaseTooltip.Portal>
          {/* The z-index belongs on the Positioner; the Popup is static. */}
          <BaseTooltip.Positioner
            className={PANEL_POSITIONER}
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
          >
            <BaseTooltip.Popup
              className={cn(
                'motion-pop max-w-xs rounded-xs bg-ink px-2 py-1',
                'text-xs text-text-inverse shadow-md',
              )}
            >
              {content}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      )}
    </BaseTooltip.Root>
  );

  // The delay is owned by the provider, not by the root, so an override is a
  // nested provider rather than a prop. Nesting one is cheap and keeps the
  // shared timing everywhere it is not overridden — which is the whole reason
  // the provider exists.
  return delay === undefined ? (
    tooltip
  ) : (
    <BaseTooltip.Provider delay={delay} closeDelay={100}>
      {tooltip}
    </BaseTooltip.Provider>
  );
}
