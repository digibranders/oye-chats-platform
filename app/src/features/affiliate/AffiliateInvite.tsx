/**
 * AffiliateInvite - the public magic-link landing at `/affiliate-invite?token=`.
 *
 * Rebuilt from the legacy `pages/AffiliateInvite.jsx` in the new design
 * language. It looks the invite up (to show who it's for and when it expires),
 * then routes on auth state:
 *   • not signed in → sign-in / create-account CTAs that carry the token +
 *     invited email back here (both auth pages are invite-aware);
 *   • signed in     → auto-accept as the current client; on an email mismatch
 *     (403) it offers to sign out and use the invited address; an already-
 *     accepted invite (409) is treated as success.
 *
 * A standalone public page (outside the app shell), so it owns a centered
 * card layout built from design-system primitives.
 *
 * Backend reused verbatim (typed in services/api.d.ts): lookupAffiliateInvite,
 * acceptAffiliateInviteExisting.
 */
import { type ReactElement, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Gift, Loader2 } from 'lucide-react';
import { Button, buttonVariants, Card } from '../../design-system';
import { acceptAffiliateInviteExisting, lookupAffiliateInvite } from '../../services/api';
import { clearAuthStorage, getAuthItem } from '../../utils/authStorage';

type LookupPhase =
  | { readonly status: 'loading' }
  | { readonly status: 'invalid'; readonly message: string }
  | { readonly status: 'ready'; readonly email: string; readonly expiresAt: string | null };

type AcceptPhase =
  | { readonly status: 'idle' }
  | { readonly status: 'accepting' }
  | { readonly status: 'accepted' }
  | { readonly status: 'mismatch'; readonly message: string }
  | { readonly status: 'error'; readonly message: string };

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function errStatus(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Shell that centers a single card on the canvas - mirrors the auth pages. */
function InviteShell({ children }: { children: ReactElement }): ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--ds-bg-canvas)] px-4 py-12">
      <Card className="w-full max-w-md p-8">{children}</Card>
    </div>
  );
}

export function AffiliateInvite(): ReactElement {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const isLoggedIn = Boolean(getAuthItem('admin_token'));

  // Initial phases are derived (not set in an effect): no token → invalid up
  // front; a signed-in visitor lands straight in the "accepting" spinner while
  // the accept effect runs. The effects below only set state after an await.
  const [lookup, setLookup] = useState<LookupPhase>(() =>
    token ? { status: 'loading' } : { status: 'invalid', message: 'This invite link is missing its token.' },
  );
  const [accept, setAccept] = useState<AcceptPhase>(() =>
    isLoggedIn ? { status: 'accepting' } : { status: 'idle' },
  );

  // 1) Resolve the invite.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    lookupAffiliateInvite(token)
      .then((data) => {
        if (!cancelled) {
          setLookup({ status: 'ready', email: data.email, expiresAt: data.expires_at ?? null });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = errStatus(err);
        setLookup({
          status: 'invalid',
          message:
            status === 410
              ? 'This invite has expired or was revoked. Ask your OyeChats contact for a fresh link.'
              : toMessage(err, 'This invite link is invalid.'),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 2) Once resolved AND signed in, accept as the current client.
  useEffect(() => {
    if (lookup.status !== 'ready' || !isLoggedIn || !token) return undefined;
    let cancelled = false;
    acceptAffiliateInviteExisting(token)
      .then(() => {
        if (!cancelled) setAccept({ status: 'accepted' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = errStatus(err);
        if (status === 409) {
          // Already an affiliate - the desired end state.
          setAccept({ status: 'accepted' });
        } else if (status === 403) {
          setAccept({
            status: 'mismatch',
            message: 'This invite was sent to a different email than the account you’re signed in with.',
          });
        } else {
          setAccept({ status: 'error', message: toMessage(err, 'Could not accept the invite.') });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [lookup.status, isLoggedIn, token]);

  // ── Invalid / expired token ──────────────────────────────────────────────────
  if (lookup.status === 'invalid') {
    return (
      <InviteShell>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]">
            <AlertTriangle size={22} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold text-[var(--ds-text)]">Invite unavailable</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">{lookup.message}</p>
          <Link to="/login" className={cnMt('outline')}>
            Go to sign in
          </Link>
        </div>
      </InviteShell>
    );
  }

  // ── Looking up ────────────────────────────────────────────────────────────────
  if (lookup.status === 'loading') {
    return (
      <InviteShell>
        <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-[var(--ds-text-muted)]">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          Checking your invite…
        </div>
      </InviteShell>
    );
  }

  const expiry = formatExpiry(lookup.expiresAt);
  const returnTo = `/affiliate-invite?token=${encodeURIComponent(token)}`;
  const emailParam = `&email=${encodeURIComponent(lookup.email)}`;

  // ── Signed in → accept flow ───────────────────────────────────────────────────
  if (isLoggedIn) {
    if (accept.status === 'accepted') {
      return (
        <InviteShell>
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--ds-success-soft)] text-[var(--ds-success)]">
              <CheckCircle2 size={22} aria-hidden="true" />
            </div>
            <h1 className="text-lg font-semibold text-[var(--ds-text)]">You’re in the affiliate program</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
              Create referral codes, share their links, and earn commission on every signup.
            </p>
            <Button type="button" variant="primary" className="mt-6 w-full" onClick={() => navigate('/workspace/affiliate')}>
              Go to your affiliate dashboard
            </Button>
          </div>
        </InviteShell>
      );
    }

    if (accept.status === 'mismatch') {
      return (
        <InviteShell>
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--ds-warning-soft)] text-[var(--ds-warning)]">
              <AlertTriangle size={22} aria-hidden="true" />
            </div>
            <h1 className="text-lg font-semibold text-[var(--ds-text)]">Wrong account</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
              {accept.message} It was sent to <strong className="text-[var(--ds-text)]">{lookup.email}</strong>.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-6 w-full"
              onClick={() => {
                clearAuthStorage();
                // Reload so the guards re-read the now-empty auth storage and this
                // page falls through to the signed-out CTAs.
                window.location.assign(returnTo);
              }}
            >
              Sign out and use {lookup.email}
            </Button>
          </div>
        </InviteShell>
      );
    }

    if (accept.status === 'error') {
      return (
        <InviteShell>
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]">
              <AlertTriangle size={22} aria-hidden="true" />
            </div>
            <h1 className="text-lg font-semibold text-[var(--ds-text)]">Couldn’t accept the invite</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">{accept.message}</p>
            <Button type="button" variant="outline" className="mt-6 w-full" onClick={() => window.location.assign(returnTo)}>
              Try again
            </Button>
          </div>
        </InviteShell>
      );
    }

    // accepting
    return (
      <InviteShell>
        <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-[var(--ds-text-muted)]">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          Adding you to the affiliate program…
        </div>
      </InviteShell>
    );
  }

  // ── Signed out → sign-in / create-account CTAs ────────────────────────────────
  return (
    <InviteShell>
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
          <Gift size={22} aria-hidden="true" />
        </div>
        <h1 className="text-lg font-semibold text-[var(--ds-text)]">You’re invited to partner with OyeChats</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
          This invite is for <strong className="text-[var(--ds-text)]">{lookup.email}</strong>. Sign in or create your
          account to join the affiliate program and start earning commission on referrals.
        </p>
        {expiry && (
          <p className="mt-1 text-[12px] text-[var(--ds-text-subtle)]">Invite valid until {expiry}.</p>
        )}
        <div className="mt-6 space-y-2">
          <Link
            to={`/login?next=${encodeURIComponent(returnTo)}${emailParam}`}
            className={`w-full ${buttonVariants({ variant: 'primary' })}`}
          >
            Sign in to accept
          </Link>
          <Link
            to={`/register?next=${encodeURIComponent(returnTo)}${emailParam}`}
            className={`w-full ${buttonVariants({ variant: 'outline' })}`}
          >
            Create your account
          </Link>
        </div>
      </div>
    </InviteShell>
  );
}

/** Small helper: a top-margined button-styled link for single-CTA panels. */
function cnMt(variant: 'primary' | 'outline'): string {
  return `mt-6 ${buttonVariants({ variant })}`;
}
