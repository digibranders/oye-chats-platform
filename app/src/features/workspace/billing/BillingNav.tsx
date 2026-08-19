import { NavLink } from 'react-router-dom';
import { cn } from '../../../ui';

/**
 * The three money destinations, as links.
 *
 * Links rather than a tab row, because these are three routed pages and not
 * three panels: a tablist promises `aria-controls` targets that do not exist,
 * and it takes middle-click, copy-link-address and open-in-new-tab away from a
 * customer who is quite likely trying to send one of these pages to whoever
 * holds the company card.
 */
const SECTIONS = [
  { to: '/billing', label: 'Plan', end: true },
  { to: '/billing/usage', label: 'Usage' },
  { to: '/billing/reports', label: 'Reports' },
] as const;

export function BillingNav() {
  return (
    <nav aria-label="Billing sections">
      <ul className="flex gap-1 overflow-x-auto border-b border-border">
        {SECTIONS.map((section) => (
          <li key={section.to}>
            <NavLink
              to={section.to}
              end={'end' in section ? section.end : false}
              className={({ isActive }) =>
                cn(
                  'relative flex shrink-0 items-center whitespace-nowrap px-3 py-2.5',
                  'text-base font-medium transition-colors duration-[var(--dur-fast)]',
                  isActive
                    ? // An inset shadow, so the marker sits exactly on the list's
                      // own hairline rather than one pixel above it.
                      'text-text-primary shadow-[inset_0_-2px_0_var(--color-ink)]'
                    : 'text-text-secondary hover:text-text-primary',
                )
              }
            >
              {section.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
