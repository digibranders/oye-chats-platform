import { type ReactNode } from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';
import { EYEBROW_CLASS, Kbd } from '../primitives/Misc';
import { PANEL_LIST, PANEL_POSITIONER } from './panelStyles';

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

/**
 * Every row reserves the indicator column, whether or not it has an indicator.
 *
 * A plain `MenuItem` sat at 8px and a `MenuCheckboxItem` at 28, so any column
 * picker that also carried a "Reset columns" command showed a ragged left edge —
 * and a plain item had no way to say it was the selected one at all, which a
 * sort direction or a density choice needs. macOS, Linear and Stripe all indent
 * the whole menu; so does this.
 *
 * 32px rows at `text-sm`, not 34 at `text-base`. 34 is on no scale — DESIGN.md
 * §4 has 44 and 36 — and 13/20 is the rung the type scale defines for dense UI,
 * which is what a menu is. A `p-1` panel of eight items is 4 + 8 × 32 + 4 = 264.
 */
const ITEM = cn(
  'relative flex h-8 cursor-pointer select-none items-center gap-2 rounded-sm pl-7 pr-2 text-sm',
  'text-text-primary outline-none',
  'data-[highlighted]:bg-surface-hover',
  'data-[disabled]:pointer-events-none data-[disabled]:text-text-disabled',
);

const INDICATOR = 'absolute left-2 flex items-center';

export function MenuContent({
  children,
  align = 'end',
  side = 'bottom',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  /**
   * Which side of the trigger to open on.
   *
   * The rail's own menus are anchored to a full-height element at the edge of
   * the viewport, so the default `bottom` gets collision-flipped and the panel
   * overhangs. They pass `right`.
   */
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}) {
  return (
    <BaseMenu.Portal>
      {/* The z-index belongs on the Positioner: Base UI positions that element
          and renders the Popup as a static child, where `z-index` is ignored. */}
      <BaseMenu.Positioner
        className={PANEL_POSITIONER}
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={8}
      >
        <BaseMenu.Popup
          className={cn(PANEL_LIST, 'max-h-[var(--available-height)] overflow-y-auto', className)}
        >
          {children}
        </BaseMenu.Popup>
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
  /** The current choice in a set of commands — a sort direction, a density. */
  selected = false,
  shortcut,
  className,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  destructive?: boolean;
  selected?: boolean;
  shortcut?: string;
  className?: string;
}) {
  return (
    <BaseMenu.Item
      disabled={disabled}
      onClick={onSelect}
      className={cn(ITEM, destructive && 'text-danger data-[highlighted]:bg-danger-tint', className)}
    >
      {selected ? (
        <span aria-hidden className={INDICATOR}>
          <Check className="h-icon-sm w-icon-sm" />
        </span>
      ) : null}
      {icon ? <span className="shrink-0 text-text-tertiary">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {/* `Kbd`, not a bare mono run: ⌘D in a menu and ⌘K in the top bar were two
          visual languages for the same fact. It is 20px in a 32px row. */}
      {shortcut ? <Kbd className="shrink-0">{shortcut}</Kbd> : null}
    </BaseMenu.Item>
  );
}

/** A menu row that reports whether it is on. Use for view and filter switches. */
export function MenuCheckboxItem({
  children,
  checked,
  onCheckedChange,
  disabled,
  icon,
  shortcut,
  className,
}: {
  children: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  icon?: ReactNode;
  shortcut?: string;
  className?: string;
}) {
  return (
    <BaseMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      // Close-on-select is wrong for a checklist: toggling three columns should
      // not mean reopening the menu three times.
      closeOnClick={false}
      className={cn(ITEM, className)}
    >
      <BaseMenu.CheckboxItemIndicator className={INDICATOR}>
        <Check aria-hidden className="h-icon-sm w-icon-sm" />
      </BaseMenu.CheckboxItemIndicator>
      {icon ? <span className="shrink-0 text-text-tertiary">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <Kbd className="shrink-0">{shortcut}</Kbd> : null}
    </BaseMenu.CheckboxItem>
  );
}

/**
 * A named section of a menu: the label, and the rows it names.
 *
 * `Menu.GroupLabel` is a part of `Menu.Group` and throws
 * `MenuGroupContext is missing` without one. `MenuLabel` used to render the
 * label alone, so opening any menu that used it — including the "Row actions"
 * example in `/dev/ui`, the page `app/CLAUDE.md` #5 makes the official review
 * instrument — threw and unmounted the whole route into the root error boundary.
 * The suite passed because nothing in it opened a menu containing a group label;
 * `overlays.test.tsx` now does.
 *
 * Taking the rows as children is also what makes the grouping real rather than
 * decorative: everything inside is announced as belonging to the label.
 *
 * The label re-uses `EYEBROW_CLASS` rather than `Eyebrow` itself, because Base
 * UI's `render` prop hands the element its own props and ref and `Eyebrow`
 * forwards neither.
 */
export function MenuGroup({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <BaseMenu.Group>
      <BaseMenu.GroupLabel className={cn(EYEBROW_CLASS, 'px-2 py-1.5')}>
        {label}
      </BaseMenu.GroupLabel>
      {children}
    </BaseMenu.Group>
  );
}

/**
 * A group label with no rows under it.
 *
 * Kept because it is what every call site writes, and because a heading followed
 * by loose items is a legitimate shape for a short menu. It is still a real
 * group — that is the whole fix.
 */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <MenuGroup label={children} />;
}

/** Full-bleed: an inset rule leaves two 4px stubs of white against the panel. */
export function MenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-border" />;
}

export function MenuSubTrigger({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <BaseMenu.SubmenuTrigger className={cn(ITEM, 'data-[popup-open]:bg-surface-hover')}>
      {icon ? <span className="shrink-0 text-text-tertiary">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight aria-hidden className="h-icon-sm w-icon-sm shrink-0 text-text-tertiary" />
    </BaseMenu.SubmenuTrigger>
  );
}

/**
 * A submenu opens 4px from its trigger, not the 6 every other panel uses. That
 * is deliberate and named here so nobody "corrects" it: a submenu is attached to
 * the row that opened it, and the pointer has to cross the gap without leaving
 * the trigger.
 */
const SUBMENU_OFFSET = 4;

export function MenuSubContent({ children }: { children: ReactNode }) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        className={PANEL_POSITIONER}
        sideOffset={SUBMENU_OFFSET}
        collisionPadding={8}
      >
        <BaseMenu.Popup
          className={cn(PANEL_LIST, 'max-h-[var(--available-height)] overflow-y-auto')}
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}
