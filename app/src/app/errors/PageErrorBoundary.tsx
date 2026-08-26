import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { Link, useRouteError } from 'react-router-dom';
import { PageContainer, buttonVariants } from '../../design-system';
import { ErrorDetails } from './ErrorDetails';
import { parseRouteError, useReportRouteError } from './parseRouteError';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * PageErrorBoundary - the in-shell error surface for a single routed page.
 *
 * Wired as the `errorElement` on the pathless layout that wraps every page
 * inside the app shell. Because it renders through the shell's `<Outlet />`, a
 * crash in one page (e.g. a `ReferenceError` while rendering Billing) leaves the
 * sidebar and top bar intact, so the user can simply navigate elsewhere instead
 * of losing the whole app.
 */
export function PageErrorBoundary() {
  const { t } = useTranslation();
  const error = useRouteError();
  useReportRouteError(error);
  const { status, title, description, detail } = parseRouteError(error);

  return (
    <PageContainer>
      <div className="mx-auto flex max-w-lg flex-col items-center rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-6 py-14 text-center">
        <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-400">
          <AlertTriangle size={22} />
        </div>
        {status != null && (
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
            {t('app.errorStatus', { status }) || `Error ${status}`}
          </p>
        )}
        <h2 className="text-base font-semibold text-[var(--ds-text)]">{title}</h2>
        <p className="mt-1.5 max-w-sm text-sm text-[var(--ds-text-muted)]">{description}</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className={buttonVariants({ variant: 'primary', size: 'sm' })}
          >
            <RefreshCw size={14} />
            {t('app.tryAgain') || 'Try again'}
          </button>
          <Link to="/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <Home size={14} />
            {t('app.backToHome') || 'Back to Home'}
          </Link>
        </div>
        <ErrorDetails detail={detail} className="w-full" />
      </div>
    </PageContainer>
  );
}
