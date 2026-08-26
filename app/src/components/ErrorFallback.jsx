import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';

/**
 * App-wide crash fallback rendered by the top-level Sentry.ErrorBoundary.
 *
 * Deliberately self-contained: it takes no props from React context (it renders
 * when the tree below has already failed) and leans only on the CSS custom
 * properties in index.css, which stay valid via the `.dark` class on <html>. A
 * full reload is the primary recovery because a render crash usually leaves app
 * state inconsistent; resetting the boundary in place would often re-throw.
 */
export default function ErrorFallback() {
  const { t } = useTranslation();
    return (
        <div className="min-h-screen grid place-items-center px-6 bg-[var(--bg-muted)]">
            <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center shadow-sm">
                <div className="mx-auto mb-5 grid h-12 w-12 place-items-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
                    <AlertTriangle size={22} />
                </div>
                <h1 className="text-lg font-semibold text-[var(--text)]">{t('app.somethingWentWrong') || 'Something went wrong'}</h1>
                <p className="mt-2 text-sm text-[var(--text-muted)]">
                    {t('app.unexpectedErrorBody') ||
                        'An unexpected error interrupted the page. Reloading usually fixes it - if it keeps happening, our team can help.'}
                </p>
                <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
                    >
                        <RefreshCw size={15} />
                        {t('app.reloadPage') || 'Reload page'}
                    </button>
                    <a
                        href="mailto:developer@oyechats.com"
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-muted)]"
                    >
                        {t('app.contactSupport') || 'Contact support'}
                    </a>
                </div>
            </div>
        </div>
    );
}
