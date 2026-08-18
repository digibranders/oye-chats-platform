import { type ReactElement } from 'react';
import { NavLink } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { OyeChatsMark } from './OyeChatsMark';
import { PRIMARY_NAV, SECONDARY_NAV, navForRole, type NavItem } from './nav.config';
import { cn } from '../design-system';
import { useEntitlements } from '../hooks/useEntitlements';
import { useSelectedBotPlan } from '../hooks/useSelectedBotPlan';
import { usePromoFreePeriod } from '../hooks/usePromoFreePeriod';
import { useUpgradeModal } from '../context/UpgradeModalContext';
import { useWorkspace } from '../context/WorkspaceContext';
import type { UpgradeIntentKey } from '../context/upgradeIntents';

/** Primary-nav routes whose lock is decided per-plan by a predicate. A locked
 *  entry renders as a `LockedNavItem` that opens the upgrade modal (with the
 *  mapped intent's copy) instead of routing. Backend enforces the same gates
 *  (`plan_entitlements_service.py`), so this is UX, not the security boundary.
 *
 *  Each rule declares which feature the route needs; the sidebar checks it
 *  against the live entitlements. Add a rule here to gate a new destination
 *  without touching the render loop.
 *
 *  - `/inbox`    Support / live chat requires the `live_chat` feature (Free
 *                is the only plan without it. Starter and up ship it).
 *  - `/journey`  Journey analytics is Standard+; on the backend it's a slug
 *                gate (`JOURNEY_ANALYTICS_SLUGS = {standard, professional,
 *                enterprise}`), on the frontend the `bant` feature has the
 *                same membership so we key on that. Both Free and Starter see
 *                it locked. */
interface LockRule {
  readonly intent: UpgradeIntentKey;
  readonly requiredFeature: Parameters<ReturnType<typeof useEntitlements>['hasFeature']>[0];
}

const LOCKED_NAV_RULES: Record<string, LockRule> = {
  '/inbox': { intent: 'view_support', requiredFeature: 'live_chat' },
  '/journey': { intent: 'view_journeys', requiredFeature: 'bant' },
};

export interface SidebarProps {
  /** Desktop icon-rail mode. Ignored on mobile (drawer is always full width). */
  collapsed: boolean;
  isMobile: boolean;
  /** Mobile drawer open/closed. */
  mobileOpen: boolean;
  /** Called after navigating (closes the mobile drawer). */
  onNavigate: () => void;
}

interface NavLinkItemProps {
  item: NavItem;
  showLabels: boolean;
  onNavigate: () => void;
}

/** One nav link, shared by the primary and secondary nav lists so their
 *  markup, active-state styling, and collapsed behavior can never drift. */
function NavLinkItem({ item, showLabels, onNavigate }: NavLinkItemProps): ReactElement {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      title={!showLabels ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
          showLabels ? 'w-full' : 'w-11 justify-center',
          isActive
            ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]'
            : 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--ds-accent)]" />
          )}
          <Icon
            size={18}
            className={cn(
              'shrink-0 transition-colors',
              isActive
                ? 'text-[var(--ds-accent)]'
                : 'text-[var(--ds-text-subtle)] group-hover:text-[var(--ds-text-muted)]',
            )}
          />
          {showLabels ? (
            <span className="truncate">{item.label}</span>
          ) : (
            <span className="sr-only">{item.label}</span>
          )}
        </>
      )}
    </NavLink>
  );
}

interface LockedNavItemProps {
  item: NavItem;
  showLabels: boolean;
  onClick: () => void;
}

/**
 * LockedNavItem - the Free-plan-gated stand-in for a primary-nav destination.
 * Renders as a `<button>` (never a `<NavLink>`, since it must not navigate)
 * with the same inactive-state row styling `NavLinkItem` uses, minus any
 * active treatment (a locked destination is never "current"). Clicking opens
 * the upgrade modal instead of routing. A small muted lock glyph sits at the
 * end of the row when labels show; in the collapsed icon rail the lock
 * overlays the corner of the icon and the `title`/`aria-label` carry the same
 * "locked" meaning for a mouse/keyboard or screen-reader user respectively.
 */
function LockedNavItem({ item, showLabels, onClick }: LockedNavItemProps): ReactElement {
  const Icon = item.icon;
  const lockedLabel = `${item.label} - upgrade to unlock`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={!showLabels ? lockedLabel : undefined}
      aria-label={!showLabels ? lockedLabel : undefined}
      className={cn(
        'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]',
        showLabels ? 'w-full' : 'w-11 justify-center',
      )}
    >
      <span className="relative shrink-0">
        <Icon
          size={18}
          className="text-[var(--ds-text-subtle)] transition-colors group-hover:text-[var(--ds-text-muted)]"
        />
        {!showLabels && (
          <Lock
            size={9}
            aria-hidden="true"
            className="absolute -bottom-1 -right-1 rounded-full bg-[var(--ds-sidebar-bg)] text-[var(--ds-text-subtle)]"
          />
        )}
      </span>
      {showLabels ? (
        <>
          <span className="flex-1 truncate text-left">{item.label}</span>
          <Lock
            size={13}
            aria-hidden="true"
            className="shrink-0 text-[var(--ds-text-subtle)]"
          />
        </>
      ) : (
        <span className="sr-only">{lockedLabel}</span>
      )}
    </button>
  );
}

/**
 * Sidebar - the one navigation rail. Renders exactly the six primary
 * destinations from `nav.config`. Warm-neutral surface with volt-violet used
 * only for the active state (accent-only per mandate). Responsive: an
 * icon-collapsible rail on desktop, an off-canvas drawer on mobile.
 *
 * Paid destinations (Support / live chat and Leads - see `FREE_LOCKED_NAV`) are
 * Free-plan-gated (backend `plan_entitlements_service.py`): a Free workspace
 * renders them as `LockedNavItem`s that open the upgrade modal instead of
 * navigating; every other item is unaffected.
 */
export function Sidebar({ collapsed, isMobile, mobileOpen, onNavigate }: SidebarProps) {
  const showLabels = isMobile || !collapsed;
  const { hasFeature } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();
  // Operators acting in another workspace get an inbox-scoped rail; owners and
  // admins see the full object-nav. Route-guarded too (`OperatorRouteGuard`).
  const { isOperator } = useWorkspace();
  const primaryNav = navForRole(PRIMARY_NAV, isOperator);
  const secondaryNav = navForRole(SECONDARY_NAV, isOperator);
  // Plan of the agent picked in the shell switcher; sits above the Settings
  // divider as account context. Only rendered in the expanded rail (the
  // collapsed icon rail has no room for a text chip).
  const planName = useSelectedBotPlan();
  const promoFreeUntil = usePromoFreePeriod();

  // When the mobile drawer is closed it's translated off-canvas but its links
  // would still be focusable / in the AX tree - `inert` removes it entirely.
  const drawerClosed = isMobile && !mobileOpen;

  return (
    <aside
      aria-label="Primary navigation"
      // Layout hook for the impersonation bar: the rail is `fixed`, so it has
      // to be pushed down explicitly when the bar owns the top of the viewport
      // (see `.oc-impersonating` in index.css).
      data-app-sidebar=""
      inert={drawerClosed || undefined}
      className={cn(
        'fixed left-0 top-0 z-30 flex h-screen flex-col border-r border-[var(--ds-border)] bg-[var(--ds-sidebar-bg)] transition-[width,transform] duration-300',
        isMobile ? 'w-60' : collapsed ? 'w-[68px]' : 'w-60',
        drawerClosed && '-translate-x-full',
      )}
    >
      {/* Brand */}
      <div className="flex h-16 shrink-0 items-center px-4">
        {showLabels ? (
          // Theme-aware wordmark: dark mark on light theme, white mark on dark
          // theme. Both render; Tailwind's `dark:` variant toggles visibility.
          <>
            <img
              src="/new_dark.png"
              alt="OyeChats"
              draggable={false}
              className="pointer-events-none block h-7 w-auto select-none object-contain object-left dark:hidden"
            />
            <img
              src="/new_white.png"
              alt="OyeChats"
              draggable={false}
              className="pointer-events-none hidden h-7 w-auto select-none object-contain object-left dark:block"
            />
          </>
        ) : (
          // Collapsed 68px rail: a full wordmark can't fit, so keep the glyph.
          <OyeChatsMark size={32} />
        )}
      </div>

      {/* Primary navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {primaryNav.map((item) => {
          const rule = LOCKED_NAV_RULES[item.to];
          const locked = rule ? !hasFeature(rule.requiredFeature) : false;
          return locked && rule ? (
            <LockedNavItem
              key={item.to}
              item={item}
              showLabels={showLabels}
              onClick={() => openUpgradeModal(rule.intent)}
            />
          ) : (
            <NavLinkItem key={item.to} item={item} showLabels={showLabels} onNavigate={onNavigate} />
          );
        })}
      </nav>

      {/* Plan chip - the selected agent's subscription, shown as account
          context directly above the Settings divider. Left-aligned with the nav
          rows; the badge sizes to its own text. */}
      {showLabels && planName && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1 pt-2">
          <span className="text-[12px] font-medium text-[var(--ds-text-muted)]">{planName} Plan</span>
          {promoFreeUntil && (
            <span className="promo-shimmer text-[11px] font-semibold">
              Free until {new Date(promoFreeUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
            </span>
          )}
        </div>
      )}

      {/* Secondary navigation - bottom-anchored, below the primary object-nav.
          Preferences only (e.g. Settings); account/workspace switching stays
          in the TopBar user menu, so this never duplicates that nav. */}
      <nav
        aria-label="Secondary navigation"
        className="shrink-0 space-y-1 border-t border-[var(--ds-border)] px-3 py-2"
      >
        {secondaryNav.map((item) => (
          <NavLinkItem key={item.to} item={item} showLabels={showLabels} onNavigate={onNavigate} />
        ))}
      </nav>
    </aside>
  );
}
