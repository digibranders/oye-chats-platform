/**
 * Build a `/login?next=…` URL that round-trips the current deep link through
 * authentication. Only same-origin relative paths are preserved (guards against
 * open-redirect via a crafted URL).
 *
 * Shared by the protected-route boundary and the 401 interceptor, so a session
 * that expires mid-session returns the reader to the page they were on rather
 * than dropping them on Home.
 */
export function loginUrlWithNext(pathname: string, search: string): string {
  const next = `${pathname}${search}`;
  const safe = next.startsWith('/') && !next.startsWith('//') && next !== '/login';
  return safe ? `/login?next=${encodeURIComponent(next)}` : '/login';
}
