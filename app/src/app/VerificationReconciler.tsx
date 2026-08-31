import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getCurrentUser } from '../services/api';
import { keys } from '../query/keys';
import { setAuthItem } from '../utils/authStorage';
import { reconcileVerifiedFlag, verifyUrlWithNext } from './emailVerificationGate';

/**
 * Sends a session back to `/verify-email` when the server says it never was.
 *
 * `ProtectedLayout`'s gate is deliberately positive-only — it fires on an
 * explicit `'false'` and never on unknown — so a session is never locked out on
 * a guess. The price is that a stale `'true'` is believed forever. The reverse
 * staleness already had a cure: the verify screen asks `/auth/me` on mount and
 * releases anyone the server considers verified. Nothing closed the loop the
 * other way.
 *
 * That gap strands an account in the state the console cannot explain: through
 * the gate, inside the shell, and refused by every write the server gates on
 * verification. Since the trial is granted at verification rather than at
 * signup, "every write" now starts at creating the first chatbot, so the first
 * thing such a session sees is "an active subscription is required" on a
 * first-run screen it should never have reached.
 *
 * It costs no extra request. `/auth/me` is already fetched in this tree by the
 * account menu and the trial card, so this subscribes to the same cache entry.
 * It renders nothing.
 */
export function VerificationReconciler() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();

  const me = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    retry: false,
    // Same entry the shell already holds, so this is a subscriber rather than a
    // second caller.
    staleTime: 5 * 60_000,
  });

  const serverIsVerified = me.data?.is_verified;

  useEffect(() => {
    if (!reconcileVerifiedFlag(serverIsVerified)) return;
    // Write the truth down before navigating, so the gate itself catches this
    // session on the next render rather than relying on this effect running
    // again.
    setAuthItem('admin_is_verified', 'false');
    navigate(verifyUrlWithNext(pathname, search), { replace: true });
  }, [serverIsVerified, navigate, pathname, search]);

  return null;
}
