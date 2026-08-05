/**
 * Type shim for the JS impersonation session store (`utils/impersonation.js`).
 * The `.js` remains the runtime source; this only supplies types to new TS code.
 */

/** The redeem endpoint's 200 payload, as persisted for the tab. */
export interface ImpersonationProfile {
  client_id: number;
  /** Account name shown in the banner. */
  name: string;
  email: string;
  /** ISO-8601 instant at which the token stops being accepted. */
  expires_at: string;
  /** Super-admin who opened the session. */
  actor_email: string;
  is_impersonation: true;
}

export const IMPERSONATION_TOKEN_KEY: string;
export const IMPERSONATION_PROFILE_KEY: string;
export const IMPERSONATION_QUERY_PARAM: string;
export const IMPERSONATION_ENDED_EVENT: string;
export const IMPERSONATION_BODY_CLASS: string;
export const IMPERSONATION_FORBIDDEN_MESSAGE: string;
export const IMPERSONATION_ENDED_MESSAGE: string;
export const IMPERSONATION_EXIT_MESSAGE: string;

export function takeImpersonationTokenFromUrl(): string | null;
export function getImpersonationToken(): string | null;
export function getImpersonationProfile(): ImpersonationProfile | null;
export function isImpersonating(): boolean;
export function isImpersonationSessionEnded(): boolean;
export function startImpersonationSession(token: string, profile: unknown): void;
export function clearImpersonationSession(): void;
export function endImpersonationSession(message?: string): void;
/**
 * Ends an impersonated support session instead of a normal logout.
 * Returns true when it handled the sign-out (caller must NOT then call
 * `clearAuthStorage()`, which would wipe the super-admin's shared credentials).
 */
export function endImpersonationSessionFromSignOut(): boolean;
