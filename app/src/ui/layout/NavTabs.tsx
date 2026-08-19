import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '../lib/cn';

export interface NavTabItem {
  to: string;
  label: string;
  /** A count or a state dot rendered after the label. */
  badge?: ReactNode;
  /** Match only the exact path, for a section's index route. */
  end?: boolean;
}

export interface NavTabsProps {
  items: readonly NavTabItem[];
  /** Names the tab set, e.g. "Revenue views". */
  label: string;
  className?: string;
}

/**
 * A tab row whose tabs are links.
 *
 * `Tabs` is the right control when the panels are all mounted and switching is
 * a client-side state change. It is the wrong one when each tab is a *route* —
 * a `tablist` promises that every tab controls a panel in the document, and a
 * routed surface only ever has the current one, so the other tabs point at
 * nothing. Faking it means either mounting every section at once or shipping
 * `aria-controls` targets that do not exist.
 *
 * So these are real links in a `nav`. They keep the tab row's shape, gain
 * middle-click, open-in-new-tab and a real URL to send a colleague, and say what
 * they are: navigation. The current one carries `aria-current="page"`, which is
 * what a screen reader announces instead of "selected".
 *
 * The row scrolls rather than wraps: a wrapped row changes the page height when
 * the active tab changes, shifting content under the reader's cursor.
 */
export function NavTabs({ items, label, className }: NavTabsProps) {
  return (
    <nav aria-label={label} className={cn('border-b border-border', className)}>
      <ul className="flex gap-1 overflow-x-auto">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2.5',
                  'text-base font-medium transition-colors duration-[var(--dur-fast)]',
                  isActive
                    ? // The active marker is an inset shadow rather than a
                      // border, so it sits exactly on the row's own hairline
                      // instead of a pixel above it, nudging the label.
                      'text-text-primary shadow-[inset_0_-2px_0_var(--color-ink)]'
                    : 'text-text-secondary hover:text-text-primary',
                )
              }
            >
              {item.label}
              {item.badge}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
