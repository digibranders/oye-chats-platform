/**
 * The logic behind the signed-out screens, kept out of the components.
 *
 * Everything here is pure or reads one storage key, so the parts that decide
 * where a person lands, whether a password is acceptable, and which sign-in
 * door to knock on are testable without rendering a form. The screens that use
 * it stay markup plus a mutation.
 */
import { getAuthItem } from '../../utils/authStorage';

/** Length of every one-time code the backend issues — verify and reset alike. */
export const OTP_LENGTH = 6;

/**
 * Seconds before a code can be re-sent.
 *
 * One constant for both OTP screens. They drifted before: the verify screen
 * enforced thirty seconds while the password reset had no cooldown at all, so
 * two near-identical flows against the same rate limiter behaved differently
 * and only one of them told the user to wait.
 */
export const RESEND_COOLDOWN_SECONDS = 30;

/**
 * Accept a redirect target only when it is a same-origin relative path.
 *
 * `next` arrives from a query string — an invite airlock, a push notification,
 * or anyone who can get a link in front of the user. `//evil.example` and
 * `https://evil.example` are both absolute despite the leading slash, so the
 * second character is checked as well as the first.
 */
export function safeRelativePath(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value.startsWith('/') || value.startsWith('//')) return '';
  return value;
}

/**
 * `ga***@example.com`.
 *
 * Enough for the reader to recognise their own address and spot that they
 * signed up with the wrong one, without printing it in full on a screen that
 * may be shared or screenshotted.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return email;
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

export interface PasswordRule {
  /** Dictionary key; `label` is the English fallback. */
  key: string;
  id: string;
  label: string;
  test: (value: string) => boolean;
}

/**
 * The server's rule set, mirrored.
 *
 * Shown in full before the first keystroke rather than revealed as an error
 * afterwards — the previous signup form only rendered the checklist once the
 * user had started typing, so the first attempt was always a guess, and the
 * reset screen never showed them at all and failed the submit instead.
 */
// @i18n-exempt: the labels below are FALLBACKS. Each row carries its own `key`
// and the renderer resolves that first; the English only shows on a miss.
export const PASSWORD_RULES: readonly PasswordRule[] = [
  // Keyed beside the English: this is a module constant evaluated at import,
  // before any locale exists, so the label resolves where it is rendered.
  { id: 'length', key: 'auth.ruleLength', label: 'At least 8 characters', test: (v) => v.length >= 8 },
  { id: 'letter', key: 'auth.ruleLetter', label: 'One letter', test: (v) => /[A-Za-z]/.test(v) },
  { id: 'number', key: 'auth.ruleNumber', label: 'One number', test: (v) => /\d/.test(v) },
];

export interface PasswordCheck extends Omit<PasswordRule, 'test'> {
  met: boolean;
}

export function passwordChecks(value: string): PasswordCheck[] {
  return PASSWORD_RULES.map(({ id, key, label, test }) => ({ id, key, label, met: test(value) }));
}

export function passwordMeetsRules(value: string): boolean {
  return PASSWORD_RULES.every((rule) => rule.test(value));
}

/** How many rules a password satisfies. Drives the strength bar only. */
export function passwordScore(value: string): number {
  return PASSWORD_RULES.reduce((total, rule) => total + (rule.test(value) ? 1 : 0), 0);
}

/** Strip everything that is not a digit and cap the length. */
export function digitsOnly(value: string, max = OTP_LENGTH): string {
  return value.replace(/\D/g, '').slice(0, max);
}

/**
 * Which credential store a sign-in is checked against.
 *
 * Customers and team members live behind two different endpoints with two
 * different passwords, and neither can tell you that the other one would have
 * worked: both answer a bad attempt with the same 401.
 */
export type SignInDoor = 'client' | 'operator';

const DOOR_KEY = 'oyechats_signin_door';

/**
 * The door to try first on this device.
 *
 * The screen this replaces tried the customer endpoint, and on any failure
 * tried the operator endpoint too — so every mistyped customer password cost
 * two round trips before the error appeared, and burned a failed-attempt count
 * against the operator account with the same address. Remembering the door that
 * last worked here makes the common case exactly one request, and the screen
 * offers the other door explicitly when a sign-in fails rather than guessing.
 */
export function readPreferredDoor(): SignInDoor {
  try {
    return window.localStorage.getItem(DOOR_KEY) === 'operator' ? 'operator' : 'client';
  } catch {
    // Storage can be unavailable in private modes. The default door is correct
    // for the large majority, and the alternate is one click away either way.
    return 'client';
  }
}

export function rememberDoor(door: SignInDoor): void {
  try {
    window.localStorage.setItem(DOOR_KEY, door);
  } catch {
    /* a forgotten preference costs one extra click, never a failed sign-in */
  }
}

export function otherDoor(door: SignInDoor): SignInDoor {
  return door === 'client' ? 'operator' : 'client';
}

export interface DestinationInputs {
  /** Validated `?next=` — an invite airlock or a notification deep link. */
  next: string;
  /** `?affiliate_token=`, from the partner invite landing page. */
  affiliateToken?: string;
  door: SignInDoor;
}

/**
 * Where a session goes once it is established.
 *
 * A deep link always wins: someone who clicked an invite meant to act on the
 * invite, not to look at their dashboard. Operators have no affiliate surface,
 * so the partner round-trip is only offered to customers.
 */
export function postAuthDestination({ next, affiliateToken, door }: DestinationInputs): string {
  if (next) return next;
  if (affiliateToken && door === 'client') {
    return `/affiliate-invite?token=${encodeURIComponent(affiliateToken)}`;
  }
  return door === 'operator' ? '/inbox' : '/';
}

/** The door a live session in this browser was opened with. */
export function currentSessionDoor(): SignInDoor {
  return getAuthItem('auth_type') === 'operator' ? 'operator' : 'client';
}

interface ApiErrorLike {
  status?: number;
  message?: string;
}

/**
 * The backend's "that address already has an account" rejection.
 *
 * A 409 is the contract; the message match is kept as a belt because the same
 * condition has historically also surfaced as a 400 with prose.
 */
export function isEmailTakenError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const apiError = error as ApiErrorLike;
  if (apiError.status === 409) return true;
  return /already|email exists|registered/i.test(apiError.message ?? '');
}

/** The server's own wording when it has one, and a usable sentence when it does not. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as ApiErrorLike).message;
    if (message) return message;
  }
  return fallback;
}
