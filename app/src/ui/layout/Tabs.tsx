import { type ReactNode } from 'react';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { cn } from '../lib/cn';
import { TAB_IDLE, TAB_ITEM, TAB_LIST, TAB_SELECTED } from './tabStyles';

export interface TabItem {
  value: string;
  label: string;
  /** A count or a state dot rendered after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: readonly TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  /** Names the tab set, e.g. "Analytics views". */
  label: string;
  children: ReactNode;
  className?: string;
}

/**
 * An underline tab row.
 *
 * On Base UI, so arrow-key roving, Home/End and the tab-to-panel relationship
 * are correct by construction, and a disabled tab is genuinely skipped rather
 * than merely styled as such — the previous row fired `onChange` for locked tabs
 * it had already marked `aria-disabled`.
 *
 * **Activation is manual.** Automatic activation selects a tab the moment an
 * arrow key lands on it, which is how the old row popped its upgrade modal at a
 * keyboard user who was only passing through, and how an expensive panel gets
 * mounted three times on the way to the fourth tab.
 *
 * **A routed tab row is `NavTabs`, not this.** If switching tabs changes the
 * URL, the panels are not all in the document and a `tablist` is a promise the
 * surface cannot keep. The largest reporting surface in the app was shipping
 * `Tabs` plus `navigate()`.
 *
 * Its geometry comes from `tabStyles`, shared with `NavTabs`: the two rows have
 * to be indistinguishable, because to the reader they are one control.
 */
export function Tabs({ items, value, onValueChange, label, children, className }: TabsProps) {
  return (
    <BaseTabs.Root
      value={value}
      onValueChange={(next) => onValueChange(String(next))}
      className={className}
    >
      {/* The hairline is on a wrapper, not on the scroller: on the scroller its
          own `overflow-x-auto` clips the rule at both ends. */}
      <div className="border-b border-border">
        <BaseTabs.List aria-label={label} activateOnFocus={false} className={TAB_LIST}>
          {items.map((item) => (
            <BaseTabs.Tab
              key={item.value}
              value={item.value}
              disabled={item.disabled}
              className={cn(
                TAB_ITEM,
                TAB_IDLE,
                'disabled:cursor-not-allowed disabled:text-text-disabled disabled:hover:text-text-disabled',
                TAB_SELECTED,
              )}
            >
              {item.label}
              {item.badge}
            </BaseTabs.Tab>
          ))}
        </BaseTabs.List>
      </div>
      {children}
    </BaseTabs.Root>
  );
}

/** The panel below the row. `pt-6` matches `PageHeader`'s toolbar gap. */
export function TabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseTabs.Panel value={value} className={cn('pt-6 focus:outline-none', className)}>
      {children}
    </BaseTabs.Panel>
  );
}
