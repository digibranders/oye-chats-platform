import { useQuery } from '@tanstack/react-query';

/**
 * Where the OAuth round trip starts.
 *
 * Exported because `GoogleAuthButton` navigates to `/auth/google/login` on the
 * same host it probes, and two copies of one base URL is how a deployment ends
 * up probing one origin and redirecting to another.
 */
export const GOOGLE_AUTH_BASE_URL: string =
  import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

/**
 * The capability probe's cache key.
 *
 * It belongs in `src/query/keys.ts` beside the other session keys; that file is
 * owned by another workstream this cycle, so it is written out here and should
 * be folded in as `keys.session.googleOAuth()` when the two land together.
 */
const GOOGLE_OAUTH_STATUS_KEY = ['session', 'google-oauth-status'] as const;

/**
 * Ask the backend whether Google OAuth is configured for this deployment.
 *
 * A deployment with no client id would render a button that redirects into a
 * 503, so the button hides itself instead. Failure is treated as "not
 * available": email and password is always there.
 */
async function probeGoogleOAuth(): Promise<boolean> {
  try {
    const response = await fetch(`${GOOGLE_AUTH_BASE_URL}/auth/google/status`, {
      method: 'GET',
      credentials: 'omit',
    });
    if (!response.ok) return false;
    const data: unknown = await response.json();
    return Boolean((data as { enabled?: boolean } | null)?.enabled);
  } catch {
    return false;
  }
}

/**
 * Whether this deployment can sign anyone in with Google.
 *
 * True only once the probe has answered yes. Pending and failed both read false,
 * so nothing is drawn on the promise of a capability that may not arrive.
 *
 * Two callers ask: `GoogleAuthButton`, which renders itself or nothing, and the
 * two sign-in screens, which draw an "or" divider above it. The divider is the
 * reason this is a hook and not private to the button — a component cannot
 * report "I rendered nothing" to its parent, so both screens drew a rule and the
 * word OR over empty space on every deployment without an OAuth client. The
 * probe lived in both files for a while, under one `staleTime: Infinity` key;
 * TanStack de-duplicated the request, but not the two definitions of what the
 * response meant.
 */
export function useGoogleAuthAvailable(): boolean {
  const status = useQuery({
    queryKey: GOOGLE_OAUTH_STATUS_KEY,
    queryFn: probeGoogleOAuth,
    // A deployment does not gain or lose its OAuth client mid-session.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return status.data === true;
}
