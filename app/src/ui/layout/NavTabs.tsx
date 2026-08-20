import { type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { cn } from '../lib/cn';
import { TAB_ACTIVE, TAB_IDLE, TAB_ITEM, TAB_LIST } from './tabStyles';

export interface NavTabItem {
  to: string;
  label: string;
  /** A count or a state dot rendered after the label. */
  badge?: ReactNode;
  /** Match only the exact path, for a section's index route. */
  end?: boolean;
  /**
   * The destination exists but this workspace's plan does not include it.
   *
   * Still navigable — the destination is the locked state, which is where the
   * explanation and the upgrade path live. A tab that cannot be clicked cannot
   * tell the reader why.
   */
  locked?: boolean;
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
 * The hairline is on the `nav`, not on the scroller. On the scroller it was
 * clipped by that element's own `overflow-x-auto` at both ends — the rule
 * stopped short of the row and read as an underline on a paragraph rather than
 * as the structural division the tabs sit on. `PageHeader toolbarBleed` runs it
 * the full width of the content area.
 */
export function NavTabs({ items, label, className }: NavTabsProps) {
  return (
    <nav aria-label={label} className={cn('border-b border-border', className)}>
      <ul className={TAB_LIST}>
        {items.map((item) => (
          <li key={item.to} className="flex">
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) => cn(TAB_ITEM, isActive ? TAB_ACTIVE : TAB_IDLE)}
            >
              {item.locked ? (
                <Lock aria-hidden className="h-icon-sm w-icon-sm text-text-tertiary" />
              ) : null}
              {item.label}
              {item.badge}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
