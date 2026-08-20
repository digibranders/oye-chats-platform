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
 * The frame every signed-out screen sits in: ink on the left, the task on the
 * right.
 *
 * The split earns its half of the viewport by being the product rather than an
 * advert for it. It is the same ink as the navigation rail, at the same
 * near-black, so the first thing anyone sees is the surface they are about to
 * work in — sign in and the rail is already there, in the same place, in the
 * same colour. The panel this replaced was a different palette, a different
 * type scale and a different mood from everything behind the sign-in button:
 * a violet gradient with floating orbs, four generic feature cards and a
 * framer-motion entrance, selling to someone who had already decided.
 *
 * What the panel says is three lines of plain type and nothing else. No
 * gradient, no glow, no animation, no stock iconography. On ink, restraint is
 * the whole effect.
 *
 * Below `lg` the panel is not rendered at all, rather than stacked above the
 * form. A phone that has to scroll past a marketing panel to reach a password
 * field is being asked to pay for someone else's layout.
 */
export function AuthShell({ title, description, children, footer, back, className }: AuthShellProps) {
  return (
    <div className={cn('min-h-screen bg-canvas lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]', className)}>
      {/*
        `aria-hidden`, and deliberately so. Every word in here is decorative
        restatement of the page the form already titles, so to a screen reader
        it is a lot of preamble standing between the landmark and the task.
        The mark inside it is decorative for the same reason -- the visible
        `<h1>` on the right is what names this screen.
      */}
      <aside
        aria-hidden
        className="relative hidden flex-col justify-between bg-rail p-10 text-rail-text lg:flex xl:p-14"
      >
        <img src="/new_dark.png" alt="" className="h-7 w-auto self-start object-contain" draggable={false} />

        <div className="max-w-md">
          <p className="font-mono text-2xs uppercase tracking-eyebrow text-rail-text-muted">
            OyeChats
          </p>
          <p className="mt-4 text-3xl font-semibold leading-tight tracking-tight">
            An assistant that has read everything you have written.
          </p>
          <p className="mt-4 text-prose text-rail-text-muted">
            Upload what you know. Paste one line into your site. Every visitor
            gets an answer from your own documents, and you get to see what they
            asked.
          </p>
        </div>

        <p className="text-2xs text-rail-text-muted">
          Answers come from your documents, not from a guess.
        </p>
      </aside>

      <main className="flex min-h-screen items-center justify-center px-4 py-10 sm:py-16 lg:min-h-0 lg:py-10">
        <div className="w-full max-w-md">
          {/*
            The mark, for the breakpoint where the panel is gone. Hidden from
            `lg` up so it is not shown twice.
          */}
          <img
            src="/new_dark.png"
            alt="OyeChats"
            className="mx-auto h-7 w-auto object-contain lg:hidden"
            draggable={false}
          />

          <Card className="mt-8 lg:mt-0">
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

          {footer ? <p className="mt-5 text-center text-xs text-text-secondary">{footer}</p> : null}
        </div>
      </main>
    </div>
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
