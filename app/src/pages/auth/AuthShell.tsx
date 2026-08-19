import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Card, CardBody, cn } from '../../ui';

export interface AuthShellProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** A single line under the card: the link to the other side of the flow. */
  footer?: ReactNode;
  /** A way back out of a multi-step flow, above the title. */
  back?: { to: string; label: string };
  className?: string;
}

/**
 * The frame every signed-out screen sits in.
 *
 * One centred column on the console's own paper ground, not the split-screen
 * dark marketing panel these screens used to carry. Three reasons. It is the
 * first thing anyone sees, and it should be the product they are about to use —
 * the panel was a different palette, a different type scale and a different
 * mood from everything behind the sign-in button. It spent half the viewport
 * selling to someone who had already decided, which on a laptop left the actual
 * form in a 400px gutter. And one column needs no `lg:` fork, no second logo
 * for the mobile breakpoint and no separate asset, so it renders identically at
 * 360px and at 1920px.
 *
 * The mark sits above the card rather than inside it, so the card holds exactly
 * one thing: the task.
 */
export function AuthShell({ title, description, children, footer, back, className }: AuthShellProps) {
  return (
    <main className={cn('min-h-screen bg-canvas px-4 py-10 sm:py-16', className)}>
      <div className="mx-auto w-full max-w-md">
        <img
          src="/new_dark.png"
          alt="OyeChats"
          className="mx-auto h-7 w-auto object-contain"
          draggable={false}
        />

        <Card className="mt-8">
          <CardBody className="p-5 sm:p-6">
            {back ? (
              <Link
                to={back.to}
                className="-ml-1 mb-4 inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
              >
                <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
                {back.label}
              </Link>
            ) : null}

            <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
            {description ? (
              <p className="mt-1.5 text-prose text-text-secondary">{description}</p>
            ) : null}

            <div className="mt-5">{children}</div>
          </CardBody>
        </Card>

        {footer ? (
          <p className="mt-5 text-center text-xs text-text-secondary">{footer}</p>
        ) : null}
      </div>
    </main>
  );
}

/**
 * The rule between the primary sign-in path and the email form.
 *
 * A `<span>` rather than an `<hr>` on each side: the word is the content, and a
 * screen reader announcing two separators around it reads as three things where
 * there is one.
 */
export function AuthDivider({ children = 'or' }: { children?: ReactNode }) {
  return (
    <div className="my-5 flex items-center gap-3" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      <span className="font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
        {children}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
