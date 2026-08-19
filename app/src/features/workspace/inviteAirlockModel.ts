/**
 * Which of the airlock's states a visitor is actually in.
 *
 * The decision has five inputs — the token, the invite's status, whether a
 * session exists, which kind of session it is, and whose email it belongs to —
 * and getting it wrong either dead-ends the invitee or silently joins the wrong
 * account to a workspace. It is a pure function so it can be tested against all
 * of them, rather than reasoned about while reading JSX.
 */

export interface InviteMeta {
  status?: string;
  workspace_name?: string;
  inviter_name?: string | null;
  email?: string;
  role?: string;
}

export type AirlockState =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  /** The token resolved, but it has already been used, revoked, or run out. */
  | { kind: 'resolved'; status: 'accepted' | 'revoked' | 'expired' }
  /** Nobody is signed in: offer sign-in and sign-up, both carrying the token. */
  | { kind: 'anonymous' }
  /** Waiting on `/auth/me` before deciding match versus mismatch. */
  | { kind: 'identifying' }
  /** A legacy operator key cannot accept — the endpoint needs client auth. */
  | { kind: 'operator-session' }
  | { kind: 'mismatch' }
  | { kind: 'ready' };

export interface AirlockInputs {
  token: string;
  /** `null` while the token is still being resolved. */
  invite: InviteMeta | null;
  inviteFailed: boolean;
  signedIn: boolean;
  /** True for a legacy `X-Operator-Key` session. */
  operatorSession: boolean;
  /** `undefined` while `/auth/me` is in flight; `null` when it failed. */
  currentEmail: string | null | undefined;
}

const RESOLVED = new Set(['accepted', 'revoked', 'expired']);

function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

export function resolveAirlockState({
  token,
  invite,
  inviteFailed,
  signedIn,
  operatorSession,
  currentEmail,
}: AirlockInputs): AirlockState {
  if (!token || inviteFailed) return { kind: 'invalid' };
  if (!invite) return { kind: 'loading' };

  const status = invite.status ?? 'pending';
  if (RESOLVED.has(status)) {
    return { kind: 'resolved', status: status as 'accepted' | 'revoked' | 'expired' };
  }

  if (!signedIn) return { kind: 'anonymous' };

  // Caught before the accept button rather than after it: `POST
  // /invites/by-token/{token}/accept` requires a client identity, so an
  // operator session would have hit a 401 on click with nothing explaining it.
  if (operatorSession) return { kind: 'operator-session' };

  // Deciding before the profile lands would flash "wrong account" at everyone.
  if (currentEmail === undefined) return { kind: 'identifying' };

  return sameEmail(currentEmail, invite.email) ? { kind: 'ready' } : { kind: 'mismatch' };
}

/** What the invitee is being offered, phrased so the role means something. */
export function inviteRoleSentence(role: string | undefined, workspace: string): string {
  const named = workspace || 'this workspace';
  if (role === 'admin') {
    return `You are being invited to ${named} as an admin — you will be able to answer conversations and manage the team and the chatbots.`;
  }
  if (role === 'owner') {
    return `You are being invited to ${named} as an owner — full control, including billing.`;
  }
  return `You are being invited to ${named} as an operator — you will be able to answer live conversations and see leads.`;
}

export const RESOLVED_COPY: Record<
  'accepted' | 'revoked' | 'expired',
  { title: string; description: string }
> = {
  accepted: {
    title: 'This invitation has already been used',
    description:
      'Somebody has accepted it, so it cannot be used again. If that was you, sign in and you are already in the workspace.',
  },
  revoked: {
    title: 'This invitation was withdrawn',
    description:
      'Whoever sent it has since revoked it. Ask them to invite you again if you still need access.',
  },
  expired: {
    title: 'This invitation has expired',
    description:
      'Invitations are short-lived on purpose. Ask whoever invited you to send a fresh one — it takes them a moment.',
  },
};
