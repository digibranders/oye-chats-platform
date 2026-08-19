import type { Department, Operator, OperatorInvite } from '../../types/domain';

/**
 * The team page's data shapes, normalised once.
 *
 * Two of the three list endpoints wrap their rows in an envelope
 * (`{operators: []}`, `{departments: []}`) and the third returns a bare array
 * (`GET /invites`). Every caller in the previous console re-derived that at the
 * point of use, and one of them got it wrong and rendered an empty roster for a
 * workspace that had five people in it. It is decided here, once.
 */
export function unwrapList<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

/**
 * Seats are counted **per chatbot**, not per workspace.
 *
 * `invite_service._require_seat_available` gates against the target bot, so a
 * workspace-wide count would tell a customer they were out of seats while the
 * server happily accepted the invite — or, worse, the other way round. The
 * meter counts what the server counts.
 *
 * Only active operators occupy a seat: `DELETE /me/self-operator` flips
 * `is_active` to false and frees one, which is exactly the difference between
 * leaving live chat and being removed from the team.
 */
export function seatsUsed(operators: readonly Operator[], botId: number | null): number {
  return operators.filter(
    (operator) => operator.is_active !== false && (botId === null || operator.bot_id === botId),
  ).length;
}

/** The roster for one chatbot, deactivated seats included so they can be seen. */
export function rosterFor(operators: readonly Operator[], botId: number | null): Operator[] {
  return operators.filter((operator) => botId === null || operator.bot_id === botId);
}

/** Invitations still outstanding for one chatbot. */
export function pendingInvitesFor(
  invites: readonly OperatorInvite[],
  botId: number | null,
): OperatorInvite[] {
  return invites.filter(
    (invite) =>
      (botId === null || invite.bot_id === botId) &&
      (invite.status === 'pending' || invite.status === 'sent'),
  );
}

/**
 * The caller's own seat on this chatbot, if they have one.
 *
 * Identified by `linked_client_id`, which the backend sets to the client id for
 * an owner who self-added and for anyone who joined through an invite. Matching
 * on email instead would collide with a legacy password operator who happens to
 * share the address.
 */
export function selfSeat(
  operators: readonly Operator[],
  clientId: number | null,
  botId: number | null,
): Operator | null {
  if (clientId == null) return null;
  return (
    operators.find(
      (operator) =>
        operator.linked_client_id === clientId &&
        (botId === null || operator.bot_id === botId) &&
        operator.is_active !== false,
    ) ?? null
  );
}

export type Availability = 'online' | 'offline' | 'deactivated';

export function availability(operator: Operator): Availability {
  if (operator.is_active === false) return 'deactivated';
  return operator.is_online ? 'online' : 'offline';
}

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  online: 'Online',
  offline: 'Offline',
  deactivated: 'Left live chat',
};

/** Sorted the way a person reads a roster: online first, then by name. */
export function byPresenceThenName(a: Operator, b: Operator): number {
  const rank = (operator: Operator): number =>
    operator.is_active === false ? 2 : operator.is_online ? 0 : 1;
  const difference = rank(a) - rank(b);
  if (difference !== 0) return difference;
  return (a.name ?? '').localeCompare(b.name ?? '');
}

/** A department id from a `<select>`, where the empty option means "none". */
export function departmentIdFromSelect(value: string): number | null {
  return value ? Number(value) : null;
}

export function departmentName(
  departments: readonly Department[],
  id: number | null | undefined,
): string | null {
  if (id == null) return null;
  return departments.find((department) => department.id === id)?.name ?? null;
}

/**
 * How long an invite has left, in the terms the person chasing it thinks in.
 *
 * An expiry rendered as a date makes the reader do the arithmetic; the only
 * question they are asking is whether they need to resend it.
 */
export function inviteExpiry(expiresAt: string | null | undefined, now: number): string {
  if (!expiresAt) return 'No expiry';
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return 'No expiry';
  const days = Math.floor((at - now) / 86_400_000);
  if (days < 0) return 'Expired';
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  return `Expires in ${days} days`;
}

export function inviteExpired(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return !Number.isNaN(at) && at < now;
}
