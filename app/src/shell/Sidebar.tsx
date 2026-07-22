import { type ReactElement } from 'react';
import { NavLink } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { PRIMARY_NAV, SECONDARY_NAV, type NavItem } from './nav.config';
import { cn } from '../design-system';

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

/**
 * Sidebar — the one navigation rail. Renders exactly the six primary
 * destinations from `nav.config`. Warm-neutral surface with volt-violet used
 * only for the active state (accent-only per mandate). Responsive: an
 * icon-collapsible rail on desktop, an off-canvas drawer on mobile.
 */
export function Sidebar({ collapsed, isMobile, mobileOpen, onNavigate }: SidebarProps) {
  const showLabels = isMobile || !collapsed;

  // When the mobile drawer is closed it's translated off-canvas but its links
  // would still be focusable / in the AX tree — `inert` removes it entirely.
  const drawerClosed = isMobile && !mobileOpen;

  return (
    <aside
      aria-label="Primary navigation"
      inert={drawerClosed || undefined}
      className={cn(
        'fixed left-0 top-0 z-30 flex h-screen flex-col border-r border-[var(--ds-border)] bg-[var(--ds-sidebar-bg)] transition-[width,transform] duration-300',
        isMobile ? 'w-60' : collapsed ? 'w-[68px]' : 'w-60',
        drawerClosed && '-translate-x-full',
      )}
    >
      {/* Brand */}
      <div className="flex h-16 shrink-0 items-center gap-2.5 px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]">
          <Sparkles size={17} />
        </div>
        {showLabels && (
          <span className="text-[15px] font-bold tracking-tight text-[var(--ds-text)]">
            OyeChats
          </span>
        )}
      </div>

      {/* Primary navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {PRIMARY_NAV.map((item) => (
          <NavLinkItem key={item.to} item={item} showLabels={showLabels} onNavigate={onNavigate} />
        ))}
      </nav>

      {/* Secondary navigation — bottom-anchored, below the primary object-nav.
          Preferences only (e.g. Settings); account/workspace switching stays
          in the TopBar user menu, so this never duplicates that nav. */}
      <nav
        aria-label="Secondary navigation"
        className="shrink-0 space-y-1 border-t border-[var(--ds-border)] px-3 py-2"
      >
        {SECONDARY_NAV.map((item) => (
          <NavLinkItem key={item.to} item={item} showLabels={showLabels} onNavigate={onNavigate} />
        ))}
      </nav>
    </aside>
  );
}
