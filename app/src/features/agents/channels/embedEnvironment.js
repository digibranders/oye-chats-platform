/**
 * Select the widget source that can communicate with the dashboard's active API.
 * Local API endpoints use the locally served widget preview; all other endpoints
 * use the production CDN widget.
 *
 * @param {string} apiBaseUrl
 * @returns {'production' | 'development'}
 */
export function getEmbedEnvironment(apiBaseUrl) {
  try {
    const hostname = new URL(apiBaseUrl).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
      ? 'development'
      : 'production';
  } catch {
    return 'production';
  }
}
