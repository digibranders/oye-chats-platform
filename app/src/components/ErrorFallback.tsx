import { TriangleAlert } from 'lucide-react';
import { Button, Card, CardBody, buttonClass } from '../ui';

/**
 * The app-wide crash screen, rendered by the root error boundary.
 *
 * A full reload rather than resetting the boundary in place: a render crash
 * usually leaves state inconsistent, so re-rendering the same tree tends to
 * throw again and the user learns only that the button does nothing.
 *
 * It takes nothing from context, because everything below it has already
 * failed.
 */
export default function ErrorFallback() {
  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-4 py-10">
      <Card className="w-full max-w-md">
        <CardBody className="p-6 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-danger-tint text-danger">
            <TriangleAlert aria-hidden className="h-5 w-5" />
          </span>
          <h1 className="mt-4 text-lg font-semibold text-text-primary">Something went wrong</h1>
          <p className="mt-2 text-prose text-text-secondary">
            An unexpected error interrupted the page. Reloading usually fixes it. If it keeps
            happening, tell us what you were doing and we will look.
          </p>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
            <a href="mailto:developer@oyechats.com" className={buttonClass('secondary', 'md')}>
              Contact support
            </a>
          </div>
        </CardBody>
      </Card>
    </main>
  );
}
