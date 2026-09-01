import { RefreshCw } from 'lucide-react';
import { Link, useRouteError } from 'react-router-dom';
import { Button, buttonClass } from '../../ui';
import { AppCrashScreen } from './AppCrashScreen';
import { parseRouteError, useReportRouteError } from './parseRouteError';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * The console did not start.
 *
 * This is the outermost `errorElement`: it catches a crash in the provider
 * tree, in the shell itself, or on a route that renders outside the shell. By
 * the time it paints there is no rail, no top bar and no data — so it is
 * deliberately self-contained. Nothing here reaches for a context: only `Link`,
 * which is the router's own and is the whole reason this is an `errorElement`
 * rather than a `window.onerror` handler.
 *
 * The screen it replaces opened with a red warning triangle and "Something went
 * wrong", which tells a customer what they can already see. What they cannot
 * see is whether it is their fault and whether their data is gone — so the copy
 * answers both in one breath and puts the ways out where the eye lands.
 *
 * It also used to be `flex min-h-screen items-center`, and a flex item taller
 * than its container overflows *both* ends: with the stack trace open on a
 * 700px window the title and both recovery buttons went above the top of the
 * document, where no amount of scrolling reaches them. `AppCrashScreen` bounds
 * its own height instead.
 */
export function RootErrorBoundary() {
  const { t } = useTranslation();
  const error = useRouteError();
  useReportRouteError(error);
  const { title, description, detail } = parseRouteError(error);

  return (
    <AppCrashScreen
      title={title}
      description={`${description} ${
        t('app.yourDataIsSafe') ||
        'Your data is safe. Your chatbots keep answering visitors while this screen is up.'
      }`}
      detail={detail}
      actions={
        <>
          <Button
            onClick={() => window.location.reload()}
            iconLeft={<RefreshCw aria-hidden />}
          >
            {t('app.reloadThePage') || 'Reload the page'}
          </Button>
          {/* A route change unmounts this boundary, so this is a real way out
              and not just a second reload button — unless the crash is in a
              provider, in which case reloading is the one that works. Both are
              offered rather than guessing which failed. */}
          <Link to="/" className={buttonClass('secondary', 'md')}>
            {t('app.goToHome') || 'Go to Home'}
          </Link>
        </>
      }
    />
  );
}
