import { type ReactNode } from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '../lib/cn';

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
 * On Radix, so arrow-key roving, Home/End, and the tab↔panel `aria-controls`
 * relationship are correct by construction — and so a disabled tab is genuinely
 * skipped rather than merely styled as such (the old row fired `onChange` for
 * locked tabs it had already marked `aria-disabled`).
 *
 * The row scrolls horizontally rather than wrapping. A wrapped tab row changes
 * the page's height when the active tab changes, which shifts the content under
 * the user's cursor.
 */
export function Tabs({ items, value, onValueChange, label, children, className }: TabsProps) {
  return (
    <RadixTabs.Root
      value={value}
      onValueChange={onValueChange}
      // Manual, not Radix's automatic default. Automatic activation selects a
      // tab the moment an arrow key lands on it, which is how the previous tab
      // row fired its upgrade modal at a keyboard user who was only passing
      // through — and how an expensive panel gets mounted three times on the
      // way to the fourth tab.
      activationMode="manual"
      className={className}
    >
      <RadixTabs.List
        aria-label={label}
        className="flex gap-1 overflow-x-auto border-b border-border"
      >
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className={cn(
              'relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2.5',
              'text-base font-medium text-text-secondary',
              'transition-colors duration-[var(--dur-fast)] hover:text-text-primary',
              'disabled:cursor-not-allowed disabled:text-text-disabled disabled:hover:text-text-disabled',
              // The active marker is an inset shadow rather than a border, so it
              // sits exactly on the list's own hairline instead of one pixel
              // above it and nudging the label.
              'data-[state=active]:text-text-primary',
              'data-[state=active]:shadow-[inset_0_-2px_0_var(--color-ink)]',
            )}
          >
            {item.label}
            {item.badge}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}

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
    <RadixTabs.Content value={value} className={cn('pt-6 focus:outline-none', className)}>
      {children}
    </RadixTabs.Content>
  );
}
