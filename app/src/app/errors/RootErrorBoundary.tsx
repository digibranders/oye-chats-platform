import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { Link, useRouteError } from 'react-router-dom';
import { buttonVariants } from '../../design-system';
import { ErrorDetails } from './ErrorDetails';
import { parseRouteError, useReportRouteError } from './parseRouteError';

/**
 * RootErrorBoundary — the app-wide, full-screen error surface.
 *
 * Wired as the `errorElement` on the router root (and the shell route), so it
 * catches anything the in-shell {@link PageErrorBoundary} does not: crashes in
 * the shell itself, in the provider tree, or in a route that renders outside the
 * shell (e.g. Launch Studio). It is intentionally self-contained — it must
 * render correctly even when the tree below it has failed — leaning only on
 * design-system tokens, which stay valid via the `.dark` class on `<html>`.
 */
export function RootErrorBoundary() {
  const error = useRouteError();
  useReportRouteError(error);
  const { status, title, description, detail } = parseRouteError(error);

  return (
    <div className="grid min-h-screen place-items-center bg-[var(--ds-bg-sunken)] px-6">
      <div className="w-full max-w-md rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-8 text-center shadow-[var(--ds-shadow-sm)]">
        <div className="mx-auto mb-5 grid h-12 w-12 place-items-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
          <AlertTriangle size={22} />
        </div>
        {status != null && (
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
            Error {status}
          </p>
        )}
        <h1 className="text-lg font-semibold text-[var(--ds-text)]">{title}</h1>
        <p className="mt-2 text-sm text-[var(--ds-text-muted)]">{description}</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className={buttonVariants({ variant: 'primary' })}
          >
            <RefreshCw size={15} />
            Reload page
          </button>
          <Link to="/" className={buttonVariants({ variant: 'outline' })}>
            <Home size={15} />
            Back to Home
          </Link>
        </div>
        <ErrorDetails detail={detail} />
      </div>
    </div>
  );
}
