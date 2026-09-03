import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Card, CardBody, CardSection, cn } from '../../ui';
import { useTranslation } from '../../i18n/useTranslation';
import { AuthHeroIllustration } from './AuthHeroIllustration';
import { AuthDotGrid } from './AuthDotGrid';
import { Trans } from '../../i18n/Trans';

export interface AuthShellProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  secondary?: ReactNode;
  footer?: ReactNode;
  back?: { to: string; label: string };
  className?: string;
}

export function AuthShell({
  title,
  description,
  children,
  secondary,
  footer,
  back,
  className,
}: AuthShellProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'min-h-screen bg-canvas xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]',
        className,
      )}
    >
      <aside
        aria-hidden
        className="relative hidden flex-col overflow-hidden bg-rail p-12 text-rail-text xl:flex xl:p-16"
      >
        {/* Subtle dot-grid texture in the lower area, glows around the pointer */}
        <AuthDotGrid />

        {/* Top-left brand mark with generous breathing room */}
        <div className="relative z-10 max-w-md">
          <img
            src="/new_white.png"
            alt=""
            className="h-7 w-auto object-contain"
            draggable={false}
          />
        </div>

        {/* Illustration centered above the headline, sitting in the upper area */}
        <div className="relative z-10 flex flex-1 flex-col items-center justify-start pt-10 text-center">
          <AuthHeroIllustration className="-translate-x-12" />
          <div className="mt-8 max-w-md text-left self-start">
            <p className="font-mono text-2xs uppercase tracking-eyebrow text-rail-accent font-medium">
              {t('auth.oyechats') || 'OYECHATS'}
            </p>
            <h2 className="mt-4 text-2xl font-semibold leading-tight tracking-tight text-rail-text">
              <Trans
                k="auth.anAssistantThatHasRead"
                fallback="An assistant that has read{break}everything you have written."
                values={{ break: <br /> }}
              />
            </h2>
            <p className="mt-4 text-prose text-rail-text-muted">
              {t('auth.uploadWhatYouKnowPaste') || 'Upload what you know. Paste one line into your site.'}
            </p>
          </div>
        </div>
      </aside>

      <main className="flex min-h-screen items-center justify-center px-4 py-10 sm:py-16 xl:min-h-0 xl:py-14">
        <div className="w-full max-w-md">
          {/*
            The mark, for the breakpoints where the panel is gone. Hidden from
            `xl` up so it is not shown twice.
          */}
          <img
            src="/new_dark.png"
            alt={t('auth.oyechats') || 'OyeChats'}
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
