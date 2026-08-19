import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { Menu as MenuIcon, PanelLeft, Search } from 'lucide-react';
import { Button, Kbd, Tooltip, cn, modifierKey } from '../ui';
import { useBreadcrumbs } from './useBreadcrumbs';
import { NotificationBell } from './NotificationBell';

export interface TopBarProps {
  isMobile: boolean;
  collapsed: boolean;
  onToggleRail: () => void;
  onOpenSearch: () => void;
}

/**
 * The top bar: where you are, and the two things you always need.
 *
 * It is deliberately thin. The workspace switcher and the account menu live in
 * the rail, beside what they scope; the previous bar carried both switchers plus
 * breadcrumbs plus four controls, which at 375px needed 350px before the
 * breadcrumb had rendered anything.
 */
export function TopBar({ isMobile, collapsed, onToggleRail, onOpenSearch }: TopBarProps) {
  const crumbs = useBreadcrumbs();

  return (
    <header
      className={cn(
        'z-[var(--z-topbar)] flex h-topbar shrink-0 items-center gap-3',
        'border-b border-border bg-canvas px-4 md:px-6',
      )}
    >
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onToggleRail}
        aria-label={isMobile ? 'Open navigation' : collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-expanded={isMobile ? undefined : !collapsed}
        aria-controls="app-rail"
      >
        {isMobile ? (
          <MenuIcon aria-hidden className="h-4 w-4" />
        ) : (
          <PanelLeft aria-hidden className="h-4 w-4" />
        )}
      </Button>

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm">
          {crumbs.map((crumb, index) => (
            <Fragment key={`${crumb.label}-${index}`}>
              {index > 0 ? (
                <li aria-hidden className="shrink-0 text-text-tertiary">
                  /
                </li>
              ) : null}
              <li className="min-w-0">
                {crumb.to && index < crumbs.length - 1 ? (
                  <Link
                    to={crumb.to}
                    className="block truncate text-text-secondary underline-offset-2 transition-colors hover:text-text-primary hover:underline"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                    className="block truncate font-medium text-text-primary"
                  >
                    {crumb.label}
                  </span>
                )}
              </li>
            </Fragment>
          ))}
        </ol>
      </nav>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip content="Search everything">
          <button
            type="button"
            onClick={onOpenSearch}
            className={cn(
              'flex h-control-sm items-center gap-2 rounded-md border border-border bg-surface px-2.5',
              'text-xs text-text-tertiary transition-colors hover:border-border-strong hover:text-text-secondary',
            )}
          >
            <Search aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden sm:inline">Search</span>
            {/* Two keys, two glyphs — and the modifier resolved per platform.
                The previous bar hardcoded a single "⌘K" chip and showed it to
                Windows and Linux users, naming a key they do not have. */}
            <span className="hidden items-center gap-1 lg:inline-flex">
              <Kbd>{modifierKey()}</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
        </Tooltip>
        <NotificationBell />
      </div>
    </header>
  );
}
