/**
 * True when a hostname belongs to a developer machine rather than a deployed
 * environment. Used to keep local runs out of shared observability tooling
 * (Sentry) even when a production bundle is served locally via `vite preview`.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  );
}
