/**
 * What the console says when a super-admin's own seat cannot read something.
 *
 * One sentence, one place. It had been written out at fourteen call sites in
 * fourteen slightly different wordings, which is how a console ends up telling
 * one person the same thing four different ways in one session. A super-admin's
 * permissions are checked per route on the server, so a single list inside a
 * page they can otherwise read really can come back 403 — and "we could not load
 * this" would send them hunting an outage that is not there.
 */
export const FORBIDDEN_TITLE = 'You do not have access to this';

/** `what` names the thing: "the subscription book", "registered devices". */
export function forbiddenDescription(what: string): string {
  return `Your super-admin account is not permitted to read ${what}.`;
}
