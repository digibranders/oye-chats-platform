import { type ReactNode } from 'react';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * A dropdown menu: a list of commands hanging off a trigger.
 *
 * Not to be confused with `Popover`, which holds arbitrary content. The
 * distinction is not cosmetic — `role="menu"` obliges every child to be a
 * `menuitem`, so putting a text field inside one (as the old agent switcher did)
 * makes the whole popup unnavigable for a screen-reader user. When the content
 * has a search box or a form, it is a `Popover`.
 *
 * Radix supplies typeahead, roving focus, submenu timing, and the collision
 * handling that keeps the panel on screen near a viewport edge.
 */

export const MenuRoot = RadixMenu.Root;
export const MenuTrigger = RadixMenu.Trigger;
export const MenuSub = RadixMenu.Sub;

const PANEL = cn(
  'z-[var(--z-overlay)] min-w-44 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-md',
  'motion-pop',
);

const ITEM = cn(
  'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base',
  'text-text-primary outline-none',
  'data-[highlighted]:bg-surface-hover',
  'data-[disabled]:pointer-events-none data-[disabled]:text-text-disabled',
);

export function MenuContent({
  children,
  align = 'end',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        sideOffset={6}
        // Radix keeps the panel inside the viewport and exposes the available
        // height, so a long menu near the bottom of the screen scrolls instead
        // of being clipped by an ancestor's overflow.
        collisionPadding={8}
        className={cn(PANEL, 'max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto', className)}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  disabled,
  icon,
  /** Renders in the danger tone. For destructive commands, which still confirm. */
  destructive = false,
  shortcut,
  className,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  destructive?: boolean;
  shortcut?: string;
  className?: string;
}) {
  return (
    <RadixMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        ITEM,
        destructive && 'text-danger data-[highlighted]:bg-danger-tint',
        className,
      )}
    >
      {icon ? <span className="shrink-0 text-text-tertiary">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="shrink-0 font-mono text-2xs text-text-tertiary">{shortcut}</span>
      ) : null}
    </RadixMenu.Item>
  );
}

/** A menu row that reports whether it is on. Use for view/filter switches. */
export function MenuCheckboxItem({
  children,
  checked,
  onCheckedChange,
  disabled,
}: {
  children: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <RadixMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      // Close-on-select is wrong for a checklist: toggling three columns should
      // not mean reopening the menu three times.
      onSelect={(event) => event.preventDefault()}
      className={cn(ITEM, 'pl-7')}
    >
      <RadixMenu.ItemIndicator className="absolute left-2">
        <Check aria-hidden className="h-3.5 w-3.5" />
      </RadixMenu.ItemIndicator>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </RadixMenu.CheckboxItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <RadixMenu.Label className="px-2 py-1.5 font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
      {children}
    </RadixMenu.Label>
  );
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="my-1 h-px bg-border" />;
}

export function MenuSubTrigger({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <RadixMenu.SubTrigger className={cn(ITEM, 'data-[state=open]:bg-surface-hover')}>
      {icon ? <span className="shrink-0 text-text-tertiary">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
    </RadixMenu.SubTrigger>
  );
}

export function MenuSubContent({ children }: { children: ReactNode }) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.SubContent sideOffset={4} className={PANEL}>
        {children}
      </RadixMenu.SubContent>
    </RadixMenu.Portal>
  );
}
