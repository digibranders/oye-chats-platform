/**
 * How the app reads an auth failure, kept out of `services/api.ts` so both the
 * response interceptor and its tests can use the same rules.
 */

/**
 * Structured error codes the backend may put on `detail.error` for a 401. The
 * string match below is the fallback for the endpoints that still answer with
 * prose.
 */
const MISSING_CLIENT_CREDENTIAL_CODES = new Set(['missing_api_key', 'client_auth_required']);

/**
 * True when a 401 means "this endpoint wants the account credential", not
 * "your credential is no longer valid".
 *
 * A legacy operator session holds `X-Operator-Key` and nothing else, so every
 * strict endpoint it happens to touch (Billing, account settings) answers
 * `Missing X-API-Key header. This endpoint requires account (admin)
 * authentication.` from `get_current_client_strict`. Treating that as an
 * expired session logged the operator out of a screen they simply may not see.
 *
 * The old test matched the substring `api key`, which the hyphenated header
 * name never contains, so the suppression never fired.
 */
export function isMissingClientCredential(detail: unknown): boolean {
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const code = (detail as { error?: unknown }).error;
    if (typeof code === 'string' && MISSING_CLIENT_CREDENTIAL_CODES.has(code)) return true;
    const message = (detail as { message?: unknown }).message;
    return typeof message === 'string' && mentionsApiKeyHeader(message);
  }
  return typeof detail === 'string' && mentionsApiKeyHeader(detail);
}

function mentionsApiKeyHeader(text: string): boolean {
  const lowered = text.toLowerCase();
  return lowered.includes('x-api-key') || lowered.includes('api key');
}
