import { useQuery } from '@tanstack/react-query';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

/**
 * The same capability probe `GoogleAuthButton` runs, under the same cache key.
 *
 * TanStack de-duplicates by key, and the key is `staleTime: Infinity`, so the
 * button and this hook share one response and one request — whichever mounts
 * first pays for it.
 *
 * It exists because the button renders `null` when the deployment has no OAuth
 * client, and both sign-in screens drew an "or" divider above it regardless: a
 * rule, the word OR, and nothing above it. A component cannot report "I rendered
 * nothing" to its parent, so the parent has to be able to ask the same question
 * the child asks.
 *
 * The fetch belongs beside the button, and this duplicates it: `src/components/`
 * is outside this pass's scope, so the probe is written out here rather than
 * exported from there. Folding the two together — `useGoogleAuthAvailable` in
 * one module, imported by both — is a one-line change for whoever owns that file
 * next.
 */
async function probeGoogleOAuth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/auth/google/status`, {
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

/** True only once the probe has answered yes. Pending and failed both read false. */
export function useGoogleAuthAvailable(): boolean {
  const status = useQuery({
    queryKey: ['session', 'google-oauth-status'],
    queryFn: probeGoogleOAuth,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return status.data === true;
}
