import { type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { FullPageState, buttonClass } from '../../ui';
import { ErrorDetails } from './ErrorDetails';

export interface AppCrashScreenProps {
  title: string;
  /** One or two sentences: what happened, and what is *not* broken. */
  description: string;
  /** Message and stack, folded away. Absent when there is nothing to show. */
  detail?: string;
  /** The ways out. Never fewer than one. */
  actions: ReactNode;
}

/**
 * The console did not draw. One layout, one copy, one recovery path.
 *
 * It exists because the app shipped **two** crash screens and mounted both: a
 * centred 448px card with a red disc under `Sentry.ErrorBoundary`, and a
 * left-aligned 896px page with an eyebrow and two cards under the router's
 * `errorElement`. Which one a customer saw depended on where the throw
 * originated, and neither could tell they were in the same product.
 *
 * Centred and no wider than a card, because there is no shell to anchor to:
 * the rail is gone, the top bar is gone, and a full-width left-aligned column
 * of text with nothing beside it reads as a broken page rather than a
 * considered one. The stack sits in the footnote, folded, where it belongs —
 * it is material for a support email, not an explanation.
 */
export function AppCrashScreen({ title, description, detail, actions }: AppCrashScreenProps) {
  return (
    <FullPageState
      icon={TriangleAlert}
      tone="danger"
      title={title}
      description={description}
      actions={actions}
      footnote={
        <>
          <p>
            If it keeps happening, email{' '}
            <a
              href="mailto:developer@oyechats.com"
              className="text-accent-600 underline underline-offset-2"
            >
              developer@oyechats.com
            </a>
            .
          </p>
          {detail ? <ErrorDetails detail={detail} className="mt-3 text-left" /> : null}
        </>
      }
    />
  );
}

/**
 * The same screen, mounted above the router.
 *
 * `Sentry.ErrorBoundary` sits outside `RouterProvider`, so it catches what the
 * router's own boundary cannot — a crash in the router's construction, or in
 * anything the entry file renders. Its ways out are a plain anchor and a
 * reload, because at this level there is no router to navigate with.
 */
export function BootCrashScreen() {
  return (
    <AppCrashScreen
      title="Something went wrong"
      description="An unexpected error interrupted the console. Reloading usually fixes it. Your data is safe. Your chatbots keep answering visitors while this screen is up."
      actions={
        <>
          <button
            type="button"
            className={buttonClass('primary', 'md')}
            onClick={() => window.location.reload()}
          >
            Reload the page
          </button>
          <a href="/" className={buttonClass('secondary', 'md')}>
            Go to Home
          </a>
        </>
      }
    />
  );
}
