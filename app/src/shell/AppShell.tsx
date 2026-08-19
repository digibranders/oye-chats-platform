import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Toaster, TooltipProvider, cn } from '../ui';
import { Rail } from './Rail';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { ShellBanners } from './ShellBanners';
import { useNotifications } from '../context/NotificationContext';

const MOBILE_QUERY = '(max-width: 767px)';
const COLLAPSE_KEY = 'oc_rail_collapsed';

/**
 * The application frame: a rail, a top bar, and the page.
 *
 * The breakpoint is a CSS media query read through `matchMedia`, not a `resize`
 * listener maintaining a number in React state. The previous shell recomputed a
 * width on every resize event, unthrottled, and could paint one frame with the
 * wrong layout after a window restore.
 *
 * On desktop the rail is a fixed column that the content sits beside — a grid,
 * not a manually mirrored margin, so the two cannot drift out of step. On mobile
 * it is a real dialog: focus trap, scroll lock, Escape, and a scrim that is
 * genuinely above the top bar. The old scrim shared a z-index with the bar and
 * came earlier in the DOM, so the bar painted over its own overlay and stayed
 * clickable underneath it.
 */
export function AppShell() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  );
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { items } = useNotifications();

  const waiting = items.filter(
    (item) => !item.is_read && item.type === 'handoff_request',
  ).length;

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const toggleRail = useCallback(() => {
    if (isMobile) {
      setDrawerOpen((open) => !open);
      return;
    }
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // A browser with storage disabled still gets the toggle, just not the memory.
      }
      return next;
    });
  }, [isMobile]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      // Guarded, unlike the previous shell's unconditional `preventDefault` — a
      // user typing into a message composer or a search field expects their own
      // browser's shortcut, not ours.
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '');
      if (typing) return;
      event.preventDefault();
      setSearchOpen((open) => !open);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <TooltipProvider>
      <div
        className={cn(
          'min-h-dvh bg-canvas text-text-primary',
          !isMobile && 'grid',
          !isMobile && (collapsed ? 'grid-cols-[var(--spacing-rail-collapsed)_1fr]' : 'grid-cols-[var(--spacing-rail)_1fr]'),
        )}
      >
        {!isMobile ? (
          <aside
            id="app-rail"
            className="sticky top-0 h-dvh overflow-hidden border-r border-rail-border"
          >
            <Rail collapsed={collapsed} inboxCount={waiting} />
          </aside>
        ) : (
          <BaseDialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <BaseDialog.Portal>
              <BaseDialog.Backdrop className="motion-overlay fixed inset-0 z-[var(--z-scrim)] bg-overlay" />
              <BaseDialog.Popup className="motion-slide-left fixed inset-y-0 left-0 z-[var(--z-scrim)] w-64 focus:outline-none">
                <BaseDialog.Title className="sr-only">Navigation</BaseDialog.Title>
                <Rail collapsed={false} onNavigate={() => setDrawerOpen(false)} inboxCount={waiting} />
              </BaseDialog.Popup>
            </BaseDialog.Portal>
          </BaseDialog.Root>
        )}

        <div className="flex min-w-0 flex-col">
          <TopBar
            isMobile={isMobile}
            collapsed={collapsed}
            onToggleRail={toggleRail}
            onOpenSearch={() => setSearchOpen(true)}
          />
          <ShellBanners />
          <main id="main" className="min-w-0 flex-1">
            <Outlet />
          </main>
        </div>
      </div>

      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      <Toaster />
    </TooltipProvider>
  );
}
