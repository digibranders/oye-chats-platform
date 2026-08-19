import { createContext, useContext } from 'react';

/**
 * The support-session (impersonation) ledger this console keeps for itself.
 *
 * `POST /superadmin/clients/{id}/impersonate` mints a token and returns it once;
 * `POST /superadmin/impersonation/{token_id}/revoke` kills it by row id. There is
 * **no endpoint that lists impersonation tokens** — grep `ImpersonationToken` in
 * `api/app/`: it is constructed at `superadmin_routes_v2.py:494`, fetched by id at
 * `:543`, and read by hash at `auth.py:170`. Nothing enumerates it.
 *
 * So this ledger is what this console minted, in this tab, since it loaded. That
 * is a real limitation and every surface that renders it says so: a token minted
 * by another super-admin, or in another browser, cannot be seen or revoked here.
 * The alternative — showing nothing at all — would leave a live credential with
 * no visible off switch, which is worse.
 *
 * The raw token never leaves this module's state and is never rendered. It is
 * held only as the hand-off URL, and dropped the moment the session is opened.
 */
export interface SupportSession {
  /** `impersonation_tokens.id`. The only handle revocation needs. */
  tokenId: number;
  clientId: number;
  clientName: string;
  clientEmail: string;
  /** ISO-8601. The server mints a 30-minute window. */
  expiresAt: string;
  mintedAt: string;
  revokedAt: string | null;
  /**
   * `${APP_URL}/?impersonation=<raw>` — a live credential in a query string.
   * Never rendered, never copied to the clipboard, and cleared once opened.
   */
  handoffUrl: string | null;
}

export type SupportSessionState = 'ready' | 'open' | 'expired' | 'revoked';

/** What the row is, right now. Order matters: revocation beats expiry beats use. */
export function sessionState(session: SupportSession, now: number): SupportSessionState {
  if (session.revokedAt) return 'revoked';
  const expiry = Date.parse(session.expiresAt);
  if (Number.isFinite(expiry) && expiry <= now) return 'expired';
  return session.handoffUrl ? 'ready' : 'open';
}

/** A session that can still be used to act as the customer, and so still needs a revoke control. */
export function isLive(session: SupportSession, now: number): boolean {
  const state = sessionState(session, now);
  return state === 'ready' || state === 'open';
}

/** Whole minutes left, floored, never negative. `null` when the expiry is unparseable. */
export function minutesRemaining(session: SupportSession, now: number): number | null {
  const expiry = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiry)) return null;
  return Math.max(0, Math.floor((expiry - now) / 60_000));
}

export interface SupportSessionsValue {
  sessions: readonly SupportSession[];
  /** Records a freshly minted token. */
  open: (session: SupportSession) => void;
  /** Drops the hand-off URL once the support tab has been opened with it. */
  markOpened: (tokenId: number) => void;
  /** Revokes server-side, then records the outcome. Throws the platform error on failure. */
  revoke: (tokenId: number) => Promise<void>;
}

export const SupportSessionsContext = createContext<SupportSessionsValue | null>(null);

export function useSupportSessions(): SupportSessionsValue {
  const value = useContext(SupportSessionsContext);
  if (!value) {
    throw new Error('useSupportSessions must be used inside a SupportSessionsProvider.');
  }
  return value;
}
