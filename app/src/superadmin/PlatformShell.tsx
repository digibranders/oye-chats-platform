import { Fragment, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { ArrowLeft, Menu as MenuIcon, ShieldAlert } from 'lucide-react';
import {
  Button,
  RailFrame,
  RailGroupLabel,
  RailItem,
  Spinner,
  Toaster,
  TooltipProvider,
  Tooltip,
  cn,
  useMediaQuery,
} from '../ui';
import { getAuthItem } from '../utils/authStorage';
import { isImpersonating } from '../utils/impersonation';
import { ForbiddenPage } from '../app/errors/ForbiddenPage';
import { PLATFORM_NAV, isPlatformItemActive } from './nav';

const MOBILE_QUERY = '(max-width: 1023px)';
/**
 * The width at which the rail collapses to its 60px form.
 *
 * The same query `AppShell` uses, and it has to be: between 1024 and 1279 the
 * customer console's rail is 60px and this one's was 248, so crossing between
 * the two consoles moved the content start by 188px — a larger drift than the
 * 22px one the shared `RailFrame` was introduced to remove.
 */
const AUTO_COLLAPSE_QUERY = '(max-width: 1279px)';

/**
 * The platform console's own frame.
 *
 * A separate shell and a separate URL space, on purpose. A super-admin is not a
 * workspace member: they have no bots, no plan and no inbox, and every screen
 * here acts on somebody else's live account. Retrofitting that persona into a
 * shell built for one customer is how a product ends up with two shells anyway,
 * except tangled together.
 *
 * It shares the design system down to the token, so it is recognisably the same
 * product — what marks it is a permanent notice on the content, not a second
 * palette. `DESIGN.md` has no info hue and one accent; inventing a "danger red
 * admin chrome" would have cost the system its meaning to solve a labelling
 * problem that a sentence solves.
 *
 * **The rail is `RailFrame`'s, the same one the customer console uses.** The two
 * were the same 248px column with two different interiors — a 56px header
 * against a 52px one, a bottom border against none, a 12px inset against 16,
 * 8px of nav padding against 0, and an active state with an accent rule against
 * one without. A super-admin crosses between the consoles constantly, and every
 * crossing moved the content start by 22px and changed what "selected" looks
 * like.
 *
 * It is also responsive now. `grid-cols-[248px_1fr]` was unconditional, so at
 * 375px the rail took 248 of it and left the content 127 — and super-admins
 * triage from phones.
 */
export function PlatformShell() {
  const { pathname } = useLocation();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const forceCollapsed = useMediaQuery(AUTO_COLLAPSE_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Width-driven only. `AppShell` also remembers a manual preference, which this
  // console has no control to set — the drawer is the narrow-screen answer and
  // the rail is otherwise a function of how much room there is.
  const collapsed = forceCollapsed && !isMobile;

  // A support session is somebody else's identity. The platform console acting
  // through an impersonation token would be a super-admin editing plans as the
  // customer they are helping — so it is refused outright rather than gated.
  if (isImpersonating()) {
    return <Navigate to="/" replace />;
  }

  const raw = getAuthItem('is_superadmin');
  const isSuperAdmin = raw === 'true' || raw === '1';
  if (!isSuperAdmin) {
    // Answered, not swallowed. A silent redirect to `/` left the reader with no
    // idea whether the console had moved, been renamed, or was simply not
    // theirs — the exact defect a 404 that redirects causes.
    return (
      <ForbiddenPage
        full
        title="The platform console is not open to this account"
        description="It is for OyeChats staff. If you believe you should have it, ask an OyeChats administrator."
        toLabel="Go to my workspace"
      />
    );
  }

  // The drawer is always the full rail: it is an overlay with the whole
  // `--spacing-rail` width to spend whatever the viewport is doing behind it.
  function renderRail(railCollapsed: boolean) {
    return (
      <RailFrame
        navLabel="Platform console"
        header={
          railCollapsed ? (
            <Tooltip content="Platform console" side="right">
              <span className="mx-auto flex h-8 w-8 items-center justify-center">
                <ShieldAlert aria-hidden className="h-icon-md w-icon-md text-rail-accent" />
                <span className="sr-only">Platform console</span>
              </span>
            </Tooltip>
          ) : (
            <span className="flex h-9 min-w-0 flex-1 items-center gap-2.5 px-2.5">
              <span className="flex h-icon-md w-icon-md shrink-0 items-center justify-center">
                <ShieldAlert aria-hidden className="h-icon-md w-icon-md text-rail-accent" />
              </span>
              <span className="min-w-0 flex-1 truncate text-base font-semibold text-rail-text">
                Platform
              </span>
            </span>
          )
        }
        footer={
          <ul className="flex flex-col gap-0.5">
            {/* `RailItem`, not `RailBackLink`: the back link is the one rail
                child with no collapsed form, so at 60px it renders a clipped
                sentence where every sibling renders a glyph and a tooltip.
                Reported to the system; composed around here meanwhile. */}
            <RailItem
              to="/"
              label="Back to my workspace"
              active={false}
              collapsed={railCollapsed}
              onNavigate={() => setDrawerOpen(false)}
              glyph={<ArrowLeft aria-hidden className="h-icon-md w-icon-md" />}
            />
          </ul>
        }
      >
        {PLATFORM_NAV.map((group, index) => (
          <Fragment key={group.label ?? `group-${index}`}>
            {group.label ? (
              <RailGroupLabel collapsed={railCollapsed}>{group.label}</RailGroupLabel>
            ) : null}
            {group.items.map((item) => (
              <RailItem
                key={item.to}
                to={item.to}
                label={item.label}
                // Several destinations here are prefixes of each other, which
                // `NavLink`'s own matching gets wrong.
                active={isPlatformItemActive(item, pathname)}
                collapsed={railCollapsed}
                onNavigate={() => setDrawerOpen(false)}
                glyph={<item.icon aria-hidden className="h-icon-md w-icon-md" />}
              />
            ))}
          </Fragment>
        ))}
      </RailFrame>
    );
  }

  return (
    <TooltipProvider>
      <div
        className={cn(
          'grid h-dvh overflow-hidden bg-canvas text-text-primary',
          !isMobile &&
            (collapsed
              ? 'grid-cols-[var(--spacing-rail-collapsed)_1fr]'
              : 'grid-cols-[var(--spacing-rail)_1fr]'),
        )}
      >
        {!isMobile ? (
          <aside id="platform-rail" className="h-full overflow-hidden">
            {renderRail(collapsed)}
          </aside>
        ) : (
          <BaseDialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <BaseDialog.Portal>
              <BaseDialog.Backdrop className="motion-overlay fixed inset-0 z-[var(--z-scrim)] bg-overlay" />
              <BaseDialog.Popup className="motion-slide-left fixed inset-y-0 left-0 z-[var(--z-overlay)] w-rail focus:outline-none">
                <BaseDialog.Title className="sr-only">Platform navigation</BaseDialog.Title>
                {renderRail(false)}
              </BaseDialog.Popup>
            </BaseDialog.Portal>
          </BaseDialog.Root>
        )}

        <div className="flex min-w-0 flex-col overflow-hidden">
          {/* The one thing that marks this console. An informational notice in
              this system is neutral with a 3px ink leading rule — no fifth
              colour, and no borrowing the interactive accent. */}
          <div className="flex shrink-0 items-center gap-3 border-b border-border border-l-[3px] border-l-ink bg-surface px-gutter py-2 lg:px-gutter-lg">
            {isMobile ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Open navigation"
                onClick={() => setDrawerOpen(true)}
                className="-ml-1.5"
              >
                <MenuIcon aria-hidden />
              </Button>
            ) : null}
            <p className="min-w-0 text-xs text-text-secondary">
              <span className="font-medium text-text-primary">Platform console.</span> Everything
              here acts on live customer accounts, immediately.
            </p>
          </div>
          <main id="main" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}

/** Shared fallback while a lazily-loaded platform section arrives. */
export function PlatformLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="h-5 w-5" />
    </div>
  );
}
