import { ShieldAlert } from 'lucide-react';
import { Card, CardBody, Spinner } from '../ui';

export interface ImpersonationNoticeProps {
  title: string;
  message: string;
  /** The session is still being redeemed, rather than having failed. */
  busy?: boolean;
}

/**
 * The full-screen notice for a support session that cannot continue.
 *
 * Three callers, all of them dead ends by design: the bootstrap while an
 * impersonation link is being redeemed, the bootstrap when redemption fails,
 * and the banner when a live session expires or is revoked. It must never fall
 * through to the sign-in page — a super-admin landing there would be asked for
 * the customer's own password.
 *
 * It renders before the app tree exists and after it has been torn down, so it
 * takes nothing from a provider: no router, no query client, no data context.
 * The design system's card and spinner are pure markup and are safe here.
 */
export default function ImpersonationNotice({ title, message, busy = false }: ImpersonationNoticeProps) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[var(--z-banner)] grid place-items-center bg-canvas p-4"
    >
      <Card className="w-full max-w-md">
        <CardBody className="p-6 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-danger-tint text-danger">
            {busy ? (
              <Spinner size="lg" label={null} className="text-danger" />
            ) : (
              <ShieldAlert aria-hidden className="h-5 w-5" />
            )}
          </span>
          <h1 className="mt-4 text-lg font-semibold text-text-primary">{title}</h1>
          <p className="mt-2 text-prose text-text-secondary">{message}</p>
          {busy ? null : (
            <p className="mt-5 text-xs text-text-tertiary">
              Close this tab and issue a new impersonation link from the super-admin console.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
