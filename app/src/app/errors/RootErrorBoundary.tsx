import { RefreshCw } from 'lucide-react';
import { Link, useRouteError } from 'react-router-dom';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Page,
  PageHeader,
  buttonClass,
} from '../../ui';
import { ErrorDetails } from './ErrorDetails';
import { parseRouteError, useReportRouteError } from './parseRouteError';

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
 * see is whether it is their fault, whether their data is gone, and what to do
 * next — so the page answers those three, in that order, and puts both ways out
 * where the eye lands first.
 */
export function RootErrorBoundary() {
  const error = useRouteError();
  useReportRouteError(error);
  const { status, title, description, detail } = parseRouteError(error);

  return (
    <div className="flex min-h-screen items-center bg-canvas">
      <Page width="default">
        <PageHeader
          eyebrow={status != null ? `Error ${status}` : 'OyeChats console'}
          title={title}
          description={description}
          actions={
            <>
              <Button
                onClick={() => window.location.reload()}
                iconLeft={<RefreshCw aria-hidden className="h-4 w-4" />}
              >
                Reload the page
              </Button>
              {/* A route change unmounts this boundary, so this is a real way
                  out and not just a second reload button — unless the crash is
                  in a provider, in which case reloading is the one that works.
                  Both are offered rather than guessing which failed. */}
              <Link to="/" className={buttonClass('secondary', 'md')}>
                Go to Home
              </Link>
            </>
          }
        />

        <Card>
          <CardHeader
            title="Your data is safe"
            titleAs="h2"
            description="This is the console failing to draw, not your workspace. Chatbots on your site keep answering visitors while this screen is up, and nothing you had open has been lost."
          />
          <CardBody>
            <p className="text-base text-text-secondary">
              If reloading does not clear it, email{' '}
              <a
                href="mailto:developer@oyechats.com"
                className="text-accent-600 underline underline-offset-2"
              >
                developer@oyechats.com
              </a>{' '}
              and paste what is under Technical details. It is the fastest route to a fix.
            </p>
            <ErrorDetails detail={detail} className="mt-4" />
          </CardBody>
        </Card>
      </Page>
    </div>
  );
}
