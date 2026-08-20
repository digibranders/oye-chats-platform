import { ShieldAlert } from 'lucide-react';
import { FullPageState, Spinner } from '../ui';

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
 * `FullPageState` is pure markup and is safe here. It used to hand-build that
 * layout from raw classes inside `src/components/`, alongside two other copies
 * of the same shape — which is the duplication `src/ui/` exists to stop.
 */
export function ImpersonationNotice({ title, message, busy = false }: ImpersonationNoticeProps) {
  return (
    <FullPageState
      // A takeover, not a banner: one of its three callers is the live bar
      // inside the shell, and a session that has ended must not leave the
      // console interactive underneath it.
      className="fixed inset-0 z-[var(--z-banner)]"
      icon={busy ? undefined : ShieldAlert}
      tone="danger"
      busy={busy}
      title={title}
      description={message}
      actions={busy ? <Spinner size="lg" label="Opening the support session" /> : undefined}
      footnote={
        busy
          ? undefined
          : 'Close this tab and issue a new impersonation link from the platform console.'
      }
    />
  );
}

export default ImpersonationNotice;
