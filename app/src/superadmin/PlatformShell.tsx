import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { Spinner, Toaster, TooltipProvider, cn } from '../ui';
import { getAuthItem } from '../utils/authStorage';
import { isImpersonating } from '../utils/impersonation';
import { PLATFORM_NAV, isPlatformItemActive } from './nav';

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
 */
export function PlatformShell() {
  const { pathname } = useLocation();

  // A support session is somebody else's identity. The platform console acting
  // through an impersonation token would be a super-admin editing plans as the
  // customer they are helping — so it is refused outright rather than gated.
  if (isImpersonating()) {
    return <Navigate to="/" replace />;
  }

  const raw = getAuthItem('is_superadmin');
  const isSuperAdmin = raw === 'true' || raw === '1';
  if (!isSuperAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <TooltipProvider>
      <div className="grid h-dvh grid-cols-[var(--spacing-rail)_1fr] overflow-hidden bg-canvas text-text-primary">
        <aside className="flex h-full flex-col overflow-hidden border-r border-rail-border bg-rail">
          <div className="flex items-center gap-2 px-4 py-4">
            <ShieldAlert aria-hidden className="h-4 w-4 shrink-0 text-rail-accent" />
            <span className="text-sm font-semibold text-rail-text">Platform</span>
          </div>

          <nav aria-label="Platform console" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {PLATFORM_NAV.map((group) => (
              <div key={group.label} className="mb-4">
                <p className="px-2.5 pb-1.5 font-mono text-2xs uppercase tracking-eyebrow text-rail-text-muted">
                  {group.label}
                </p>
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const active = isPlatformItemActive(item, pathname);
                    return (
                      <li key={item.to}>
                        <NavLink
                          to={item.to}
                          aria-current={active ? 'page' : undefined}
                          className={cn(
                            'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium',
                            'transition-colors duration-[var(--dur-fast)]',
                            active
                              ? 'bg-rail-active text-rail-text'
                              : 'text-rail-text-muted hover:bg-rail-hover hover:text-rail-text',
                          )}
                        >
                          <Icon aria-hidden className="h-4 w-4 shrink-0" />
                          {item.label}
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          <div className="border-t border-rail-border p-2">
            <Link
              to="/"
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium',
                'text-rail-text-muted transition-colors hover:bg-rail-hover hover:text-rail-text',
              )}
            >
              <ArrowLeft aria-hidden className="h-4 w-4 shrink-0" />
              Back to my workspace
            </Link>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col overflow-hidden">
          {/* The one thing that marks this console. An informational notice in
              this system is neutral with a 3px ink leading rule — no fifth
              colour, and no borrowing the interactive accent. */}
          <p className="shrink-0 border-b border-border border-l-[3px] border-l-ink bg-surface px-4 py-2 text-xs text-text-secondary md:px-6">
            <span className="font-medium text-text-primary">Platform console.</span> Everything here
            acts on live customer accounts, immediately.
          </p>
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
