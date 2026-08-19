import type { PlatformEnv } from '../../../data/platformIntegrations';

/**
 * Which widget bundle the install snippets should point at.
 *
 * Tied to the API the dashboard is talking to, not to the dashboard's own
 * origin: a snippet quoting the production CDN while the console is pointed at a
 * local backend would install a widget that cannot answer, and the customer
 * would have no way to tell why.
 */
export function getEmbedEnvironment(apiBaseUrl: string): PlatformEnv {
  try {
    const hostname = new URL(apiBaseUrl).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
      ? 'development'
      : 'production';
  } catch {
    return 'production';
  }
}
