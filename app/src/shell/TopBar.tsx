import { Menu, PanelLeft, Search } from 'lucide-react';
import { Breadcrumbs } from '../design-system';
import { useBreadcrumbs } from './useBreadcrumbs';
import { NotificationCenter } from './NotificationCenter';
import { ThemeToggle } from './ThemeToggle';
import { ProfileMenu } from './ProfileMenu';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { BotSwitcher } from './BotSwitcher';

export interface TopBarProps {
  isMobile: boolean;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
}

/**
 * Top Navigation - contextual app bar. Left: sidebar toggle + breadcrumb trail
 * (derived from the route architecture). Right: command-palette trigger, theme
 * toggle, notifications, and the account menu. Personal/account controls live
 * here (not in the sidebar) so the rail stays purely destination navigation.
 */
export function TopBar({ isMobile, onToggleSidebar, onOpenSearch }: TopBarProps) {
  const crumbs = useBreadcrumbs();

  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-[var(--ds-border)] bg-[var(--ds-bg-canvas)]/80 px-4 backdrop-blur-md md:px-6">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={isMobile ? 'Open navigation' : 'Toggle sidebar'}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]"
      >
        {isMobile ? <Menu size={18} /> : <PanelLeft size={18} />}
      </button>

      {/* Scope selectors - colocated on the left so the user picks
          workspace → then narrows to a single agent, both persistent. Each
          switcher hides itself when there's nothing to pick between (single
          workspace / single agent). */}
      <WorkspaceSwitcher />
      <BotSwitcher />

      <div className="min-w-0 flex-1">
        <Breadcrumbs items={crumbs} />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/* Command palette trigger */}
        <button
          type="button"
          onClick={onOpenSearch}
          aria-label="Open command palette"
          className="flex h-9 items-center gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-2.5 text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]"
        >
          <Search size={15} />
          <span className="hidden text-[13px] lg:inline">Search</span>
          <kbd className="hidden rounded border border-[var(--ds-border)] px-1.5 py-0.5 text-[10px] font-medium lg:inline">
            ⌘K
          </kbd>
        </button>

        {/* Theme toggle */}
        <ThemeToggle />

        {/* Notifications */}
        <NotificationCenter />

        {/* Account menu */}
        <ProfileMenu />
      </div>
    </header>
  );
}
