import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Toaster, TooltipProvider, cn, useMediaQuery } from '../ui';
import { Rail } from './Rail';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { FeedbackLauncher } from './FeedbackLauncher';
import { ShellBanners } from './ShellBanners';
import { useWorkspace } from '../context/WorkspaceContext';
import { getMyWaitingCount } from '../services/api';
import { keys } from '../query/keys';
import { useTranslation } from '../i18n/useTranslation';

/**
 * Below this the rail is a drawer.
 *
 * 1024, not 768. Between the two the rail was a fixed 248px column with no
 * drawer and no auto-collapse, so at 768 the content area was 520px — and the
 * inbox is a three-pane console. Three panes in 456px of gutter-adjusted width
 * is not a layout.
 */
const MOBILE_QUERY = '(max-width: 1023px)';
/**
 * Below this the rail is forced collapsed, without overwriting the preference.
 *
 * A user who expands the rail on a 1440 monitor and then docks to a 1152 laptop
 * gets the 188px back automatically, and gets their expanded rail again when
 * they undock. Writing to storage here would have thrown the preference away.
 */
const AUTO_COLLAPSE_QUERY = '(max-width: 1279px)';
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
 * genuinely below its own panel. The old scrim shared a z-index with the bar and
 * came earlier in the DOM, so the bar painted over its own overlay and stayed
 * clickable underneath it — and the first rebuild reproduced that one rung down,
 * with the drawer and its backdrop both on `--z-scrim`.
 *
 * The frame is exactly one viewport tall and `main` is the scroll container,
 * rather than the document scrolling behind a sticky bar. That is what lets a
 * surface ask for the height it has — the inbox is a three-pane console whose
 * list and transcript scroll independently, which is impossible to build
 * honestly on a page that is as tall as its longest column.
 */
export function AppShell() {
  const { t } = useTranslation();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const forceCollapsed = useMediaQuery(AUTO_COLLAPSE_QUERY);
  const [preferCollapsed, setPreferCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { isOperator } = useWorkspace();

  const collapsed = preferCollapsed || (forceCollapsed && !isMobile);

  // Asked of the server, not counted out of the notifications feed.
  //
  // It used to be `items.filter(i => !i.is_read && i.type === 'handoff_request')`,
  // which is history rather than a queue: notifications stay unread until
  // somebody clears them, so the rail read "6" beside Inbox for visitors who
  // had asked for a person weeks earlier and long since left — on the same
  // screen where the inbox itself said `Waiting (0)`.
  //
  // Polled rather than pushed. The live queue arrives on the operator socket
  // as `queue_update`, but that socket is deliberately owned by the inbox page
  // (`InboxSocketProvider`), because being on that page is what "the operator
  // is at their desk" means. Subscribing from the shell would hold a WebSocket
  // open on every screen in the console to keep one badge fresh.
  const { data: waiting = 0 } = useQuery({
    queryKey: keys.inbox.waitingCount(),
    queryFn: () => getMyWaitingCount(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const toggleRail = useCallback(() => {
    if (isMobile) {
      setDrawerOpen((open) => !open);
      return;
    }
    setPreferCollapsed((current) => {
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
    // An operator's palette would list Inbox and Leads — the two rows already in
    // their rail — so the shortcut is not bound for them. It comes back the day
    // the palette searches conversations, which is what they actually hunt for.
    if (isOperator) return undefined;
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
  }, [isOperator]);

  return (
    <TooltipProvider>
      <div
        className={cn(
          'relative grid h-dvh overflow-hidden bg-canvas text-text-primary',
          !isMobile &&
            (collapsed
              ? 'grid-cols-[var(--spacing-rail-collapsed)_1fr]'
              : 'grid-cols-[var(--spacing-rail)_1fr]'),
        )}
      >
        {!isMobile ? (
          // No `border-r`: `--color-rail-border` is 1.14:1 on the rail (so it
          // does nothing where it lives) and a hard near-black rule on the
          // canvas (so it adds a seam where it was not wanted). The 15:1
          // luminance step between ink and paper is the seam.
          <aside id="app-rail" className="h-full overflow-hidden">
            <Rail collapsed={collapsed} onToggle={toggleRail} inboxCount={waiting} />
          </aside>
        ) : (
          <BaseDialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <BaseDialog.Portal>
              <BaseDialog.Backdrop className="motion-overlay fixed inset-0 z-[var(--z-scrim)] bg-overlay" />
              {/* The panel sits a rung above its own backdrop rather than
                  relying on DOM order, which is the failure the ladder exists
                  to prevent. `w-rail` rather than a fixed Tailwind width like
                  `w-64`: every inset inside `Rail` is tuned against the same
                  `--spacing-rail` token, so a fixed pixel class here would
                  drift out of sync the next time that token changes.

                  `h-svh` from the top, not `inset-y-0`. The rail pins its
                  footer (Billing, Settings, the account menu) to its own
                  bottom edge, so the drawer must end where the visitor can
                  see: a `bottom: 0` box on a phone browser with a bottom
                  toolbar, or drawn edge-to-edge under the system bar, ran
                  past the visible area and took the footer with it. The
                  small viewport is the height with every piece of browser
                  chrome showing, which on a page that never scrolls is the
                  only state there is. `index.html` opts into
                  `viewport-fit=cover`, so the bottom inset keeps the account
                  row clear of the home indicator or system bar; it is 0 on
                  every other device, and the popup carries the rail's own
                  colour so that strip reads as the drawer rather than the
                  scrim. */}
              <BaseDialog.Popup className="motion-slide-start fixed start-0 top-0 z-[var(--z-overlay)] h-svh w-rail bg-rail pb-[env(safe-area-inset-bottom)] focus:outline-none">
                <BaseDialog.Title className="sr-only">{t('shell.navigation') || 'Navigation'}</BaseDialog.Title>
                <Rail
                  collapsed={false}
                  inDrawer
                  onNavigate={() => setDrawerOpen(false)}
                  onClose={() => setDrawerOpen(false)}
                  inboxCount={waiting}
                />
              </BaseDialog.Popup>
            </BaseDialog.Portal>
          </BaseDialog.Root>
        )}

        <div className="flex min-w-0 flex-col overflow-hidden">
          {/* Above the bar, not over it: a must-see message is a layout row. */}
          <ShellBanners />
          <TopBar
            isMobile={isMobile}
            onToggleRail={toggleRail}
            onOpenSearch={() => setSearchOpen(true)}
            searchable={!isOperator}
          />
          {/* The scroll container. A routed surface that wants the viewport
              asks for `h-full`; everything else simply scrolls in here.

              `relative` (here and on the shell root) is load-bearing, not
              decoration. `overflow` only clips descendants whose containing
              block runs through this element. An absolutely positioned
              descendant with no positioned ancestor, which is every `sr-only`
              live region and caption a page renders, is positioned against
              the initial containing block instead: it sits at its static spot
              in the page's flow, below the fold on any tall page, and extends
              the document's scrollable area past the viewport. The whole
              shell, rail included, then scrolls away on the first focus or
              trackpad flick (seen on /account, 309px). Making the scroll
              container the containing block keeps those elements inside it. */}
          <main id="main" className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>

      {isOperator ? null : <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />}
      <FeedbackLauncher />
      <Toaster />
    </TooltipProvider>
  );
}
