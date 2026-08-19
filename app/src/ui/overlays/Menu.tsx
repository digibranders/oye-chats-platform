import { type ReactNode } from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
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
 * Base UI supplies typeahead, roving focus, submenu timing, and the collision
 * handling that keeps the panel on screen near a viewport edge.
 */

export const MenuRoot = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;
export const MenuSub = BaseMenu.SubmenuRoot;

const PANEL = cn(
  'motion-pop z-[var(--z-overlay)] min-w-44 rounded-lg border border-border bg-surface p-1 shadow-md',
  // Base UI reports how much room is actually available, so a long menu near
  // the bottom of the screen scrolls instead of being clipped by an ancestor.
  'max-h-[var(--available-height)] overflow-y-auto focus:outline-none',
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
    <BaseMenu.Portal>
      <BaseMenu.Positioner align={align} sideOffset={6} collisionPadding={8}>
        <BaseMenu.Popup className={cn(PANEL, className)}>{children}</BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
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
    <BaseMenu.Item
      disabled={disabled}
      onClick={onSelect}
      className={cn(ITEM, destructive && 'text-danger data-[highlighted]:bg-danger-tint', className)}
    >
      {icon ? <span className="shrink-0 text-text-tertiary">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="shrink-0 font-mono text-2xs text-text-tertiary">{shortcut}</span>
      ) : null}
    </BaseMenu.Item>
  );
}

/** A menu row that reports whether it is on. Use for view and filter switches. */
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
    <BaseMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      // Close-on-select is wrong for a checklist: toggling three columns should
      // not mean reopening the menu three times.
      closeOnClick={false}
      className={cn(ITEM, 'pl-7')}
    >
      <BaseMenu.CheckboxItemIndicator className="absolute left-2 flex items-center">
        <Check aria-hidden className="h-3.5 w-3.5" />
      </BaseMenu.CheckboxItemIndicator>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </BaseMenu.CheckboxItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <BaseMenu.GroupLabel className="px-2 py-1.5 font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
      {children}
    </BaseMenu.GroupLabel>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />;
}

export function MenuSubTrigger({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <BaseMenu.SubmenuTrigger className={cn(ITEM, 'data-[popup-open]:bg-surface-hover')}>
      {icon ? <span className="shrink-0 text-text-tertiary">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
    </BaseMenu.SubmenuTrigger>
  );
}

export function MenuSubContent({ children }: { children: ReactNode }) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner sideOffset={4} collisionPadding={8}>
        <BaseMenu.Popup className={PANEL}>{children}</BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}
