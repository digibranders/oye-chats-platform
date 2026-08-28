import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Menu as MenuIcon, Search } from 'lucide-react';
import { Button, Kbd, Skeleton, Tooltip, cn, modifierKey } from '../ui';
import { useBreadcrumbs } from './useBreadcrumbs';
import { useTranslation } from '../i18n/useTranslation';
import { NotificationBell } from './NotificationBell';

export interface TopBarProps {
  isMobile: boolean;
  onToggleRail: () => void;
  onOpenSearch: () => void;
  /** The palette finds chatbots and pages; an operator has neither. */
  searchable?: boolean;
}

/**
 * The top bar: where you are, and the two things you always need.
 *
 * It is deliberately thin. The workspace switcher and the account menu live in
 * the rail, beside what they scope; the previous bar carried both switchers plus
 * breadcrumbs plus four controls, which at 375px needed 350px before the
 * breadcrumb had rendered anything. The collapse control has gone the same way —
 * onto the rail's own header, where Linear, Vercel and Notion all put it —
 * which is what lets the trail start on the page's gutter.
 *
 * **The bar shares the page's gutter.** It was `px-4 md:px-6` against `Page`'s
 * `px-6 md:px-8`, and with a 28px toggle and a 12px gap in front of the trail,
 * the breadcrumb sat 32px right of the page title at every width and 84px right
 * of it at 1920. The trail naming the page and the title of the page were never
 * on the same line. Both now read `--spacing-gutter` / `--spacing-gutter-lg`.
 *
 * **Below 1024 there is no trail**, because below 1024 there is a drawer trigger
 * in front of it and one left edge cannot survive both. Measured at 1000px: the
 * crumb landed at x=58 against a page title at x=24 — the same two-left-edges
 * defect, one breakpoint below where it was fixed. Every link the trail offers
 * is a row in the drawer that button opens, its last crumb is the `h1` forty
 * pixels underneath it, and at 375px "Chatbots › Acme Support › Knowledge"
 * truncates to "Chatbots ›…". Dropping it costs a duplicate; keeping it costs
 * the alignment the bar was rebuilt for.
 */
export function TopBar({ isMobile, onToggleRail, onOpenSearch, searchable = true }: TopBarProps) {
  const crumbs = useBreadcrumbs();
  const { t } = useTranslation();

  return (
    <header
      className={cn(
        'flex h-topbar shrink-0 items-center gap-3 border-b border-border bg-canvas',
        'px-gutter lg:px-gutter-lg',
      )}
    >
      {isMobile ? (
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onToggleRail}
          aria-label={t('shell.openNavigation') || 'Open navigation'}
          className="-ml-1.5"
        >
          <MenuIcon aria-hidden />
        </Button>
      ) : null}

      {isMobile ? (
        <div className="flex-1" />
      ) : (
        <nav aria-label={t('shell.breadcrumbLabel') || 'Breadcrumb'} className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1.5 text-sm">
            {crumbs.map((crumb, index) => (
              <Fragment key={`${crumb.label}-${index}`}>
                {index > 0 ? (
                  <li aria-hidden className="shrink-0">
                    {/* A chevron, optically centred by the flex row. It was a
                        literal `/` at body size in `--text-tertiary` (5.38:1),
                        sitting on the baseline and nearly as heavy as the labels
                        it separated. */}
                    <ChevronRight className="h-3.5 w-3.5 text-border-strong" />
                  </li>
                ) : null}
                <li className="min-w-0">
                  {crumb.pending ? (
                    <Skeleton className="h-3.5 w-28" />
                  ) : crumb.to && index < crumbs.length - 1 ? (
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
      )}

      <div className="flex shrink-0 items-center gap-1">
        {searchable ? (
          // The tooltip only earns its place where the trigger is a bare icon.
          // Above `sm` the control already reads "Search ⌘ K".
          <Tooltip content={t('shell.searchChatbotsAndPages') || 'Search chatbots and pages'} disabled={!isMobile}>
            <button
              type="button"
              onClick={onOpenSearch}
              aria-label={t('shell.searchChatbotsAndPages') || 'Search chatbots and pages'}
              className={cn(
                'flex h-control-sm items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5',
                'text-xs text-text-tertiary transition-colors hover:border-text-tertiary hover:text-text-secondary',
              )}
            >
              <Search aria-hidden className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">{t('common.search') || 'Search'}</span>
              {/* Two keys, two glyphs — and the modifier resolved per platform.
                  The previous bar hardcoded a single "⌘K" chip and showed it to
                  Windows and Linux users, naming a key they do not have. */}
              <span className="hidden items-center gap-1 lg:inline-flex">
                <Kbd>{modifierKey()}</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
          </Tooltip>
        ) : null}
        <NotificationBell />
      </div>
    </header>
  );
}
