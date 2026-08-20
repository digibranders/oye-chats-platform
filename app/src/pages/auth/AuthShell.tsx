import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Card, CardBody, CardSection, cn } from '../../ui';

export interface AuthShellProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /**
   * A secondary row under the card's body — a resend control, a way out.
   *
   * Rendered as a `CardSection`, so its hairline reaches the card's edges.
   * `ForgotPassword` and `VerifyEmail` both drew this rule themselves *inside*
   * `CardBody`'s padding, where it floats as a short line 20–24px short of both
   * edges rather than dividing the card — on the two screens users reach when
   * something has already gone wrong.
   */
  secondary?: ReactNode;
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
 * What the panel says is two lines of plain type and nothing else. No gradient,
 * no glow, no animation, no stock iconography. On ink, restraint is the whole
 * effect.
 *
 * **The split fires at `xl`, not `lg`.** At exactly 1024 the panel took 488px
 * and the form column 536, so a `max-w-md` card sat in 44px gutters — visibly
 * tighter than at 1023, where it is centred in the whole viewport — and the
 * panel's headline wrapped to three lines. That is the most common laptop width
 * in the product's analytics. At 1280 the panel is 610 and the column 670, which
 * is the ratio the design wants; below it, one centred column is strictly
 * better.
 *
 * Below the split the panel is not rendered at all, rather than stacked above
 * the form. A phone that has to scroll past a marketing panel to reach a
 * password field is being asked to pay for someone else's layout.
 */
export function AuthShell({
  title,
  description,
  children,
  secondary,
  footer,
  back,
  className,
}: AuthShellProps) {
  return (
    <div
      className={cn(
        'min-h-screen bg-canvas xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]',
        className,
      )}
    >
      {/*
        `aria-hidden`, and deliberately so. Every word in here is decorative
        restatement of the page the form already titles, so to a screen reader
        it is a lot of preamble standing between the landmark and the task.
        The mark inside it is decorative for the same reason -- the visible
        `<h1>` on the right is what names this screen.
      */}
      <aside
        aria-hidden
        className="relative hidden flex-col justify-between bg-rail p-10 text-rail-text xl:flex xl:p-14"
      >
        {/*
          The white knock-out, not the dark one. `/new_dark.png` is black ink on
          transparent and `--color-rail` is #17171A, so the wordmark at the top
          of this panel rendered black on black — the exact failure
          `OyeChatsMark.onInk` documents, one directory away.

          Boxed to the same measure as the copy below it, so the mark, the
          headline and the paragraph share one left edge instead of the mark
          floating at the panel's own padding.
        */}
        <div className="max-w-md">
          <img
            src="/new_white.png"
            alt=""
            className="h-7 w-auto object-contain"
            draggable={false}
          />
        </div>

        <div className="max-w-md">
          <p className="font-mono text-2xs uppercase tracking-eyebrow text-rail-text-muted">
            OyeChats
          </p>
          {/* `text-2xl`, the top of the seven-rung scale. `text-3xl` is not on it
              at all and compiled only because Tailwind's default survives the
              token reset — a 30px headline in a system whose largest rung is
              28. */}
          <p className="mt-4 text-2xl font-semibold leading-tight tracking-tight">
            An assistant that has read everything you have written.
          </p>
          <p className="mt-4 text-prose text-rail-text-muted">
            Upload what you know. Paste one line into your site.
          </p>
        </div>

        {/* The third slot is deliberately empty: `justify-between` holds the
            headline in the panel's optical centre, and the line that used to sit
            here was a third claim under two that had already made it. */}
        <div aria-hidden />
      </aside>

      <main className="flex min-h-screen items-center justify-center px-4 py-10 sm:py-16 xl:min-h-0 xl:py-14">
        <div className="w-full max-w-md">
          {/*
            The mark, for the breakpoints where the panel is gone. Hidden from
            `xl` up so it is not shown twice.
          */}
          <img
            src="/new_dark.png"
            alt="OyeChats"
            className="mx-auto h-7 w-auto object-contain xl:hidden"
            draggable={false}
          />

          <Card className="mt-8 xl:mt-0">
            <CardBody className="p-5 sm:p-6">
              {back ? (
                <Link
                  to={back.to}
                  className="-ml-1 mb-4 inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
                >
                  <ArrowLeft aria-hidden className="h-icon-sm w-icon-sm" />
                  {back.label}
                </Link>
              ) : null}

              <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
              {description ? (
                <p className="mt-1.5 text-prose text-text-secondary">{description}</p>
              ) : null}

              <div className="mt-5">{children}</div>
            </CardBody>
            {secondary ? <CardSection>{secondary}</CardSection> : null}
          </Card>

          {/* 14px, not 12. "Create an account" / "Sign in" is the most-clicked
              link on the page and it was set at the smallest prose rung in the
              system, below the card. */}
          {footer ? <p className="mt-5 text-center text-base text-text-secondary">{footer}</p> : null}
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
 *
 * **The caller decides whether it renders at all.** `GoogleAuthButton` returns
 * `null` on a deployment with no OAuth client, and both sign-in screens drew
 * this divider unconditionally above it — an "OR" with nothing on one side of
 * it, which is what the running app shows today.
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
