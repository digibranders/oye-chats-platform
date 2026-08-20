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
 * One page did not load. The rest of the console still works.
 *
 * Wired as the `errorElement` on the pathless layout inside `AppShell`, so it
 * renders through the shell's `<Outlet />`: the rail, the top bar and the
 * chatbot switcher all survive a crash in a single routed page. That is the
 * whole distinction from {@link RootErrorBoundary}, and the copy leans on it —
 * "everything else still works" is only worth saying where it is true, and here
 * it is, because the reader can see the navigation next to the sentence.
 *
 * Navigating away is therefore the primary way out, not reloading: a route
 * change unmounts the boundary and re-renders the page from scratch, which is
 * both faster and less destructive than throwing away the whole application.
 */
export function PageErrorBoundary() {
  const error = useRouteError();
  useReportRouteError(error);
  const { status, title, description, detail } = parseRouteError(error);

  return (
    <Page width="default">
      <PageHeader
        eyebrow={status != null ? `Error ${status}` : 'This page'}
        title={title}
        description={description}
        actions={
          <>
            <Link to="/" className={buttonClass('primary', 'md')}>
              Go to Home
            </Link>
            <Button
              variant="secondary"
              onClick={() => window.location.reload()}
              iconLeft={<RefreshCw aria-hidden className="h-4 w-4" />}
            >
              Reload this page
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader
          title="Everything else still works"
          titleAs="h2"
          description="Only this page failed. Your chatbots are unaffected and are still answering visitors, and every other section in the sidebar will open normally."
        />
        <CardBody>
          <p className="text-base text-text-secondary">
            If this page keeps failing, email{' '}
            <a
              href="mailto:developer@oyechats.com"
              className="text-accent-600 underline underline-offset-2"
            >
              developer@oyechats.com
            </a>{' '}
            with the address in your browser bar and what is under Technical details.
          </p>
          <ErrorDetails detail={detail} className="mt-4" />
        </CardBody>
      </Card>
    </Page>
  );
}
