/**
 * Website prefill resolution for the Train step's URL field.
 *
 * Signup already asks for the account's website and stores it on the client
 * row (surfaced on `GET /auth/me` as `website`), so onboarding must never make
 * the user retype a URL the product already knows. An agent created moments
 * earlier in step 2 has no website of its own, which is exactly the case the
 * account website covers.
 */

/**
 * Pick the URL to prefill into the Train step's website field.
 *
 * The agent's own website wins whenever it is set: a chatbot that has already
 * been pointed at a site must never be silently repointed at the account's
 * website. The account website is the fallback. When neither carries a usable
 * value - `null`, `undefined`, or whitespace - the result is an empty string,
 * never the literal text `"null"` or `"undefined"`.
 *
 * The returned value is the raw stored URL (`https://www.example.com` as often
 * as `example.com`). It is deliberately NOT normalised here: the field feeds
 * the same `normalizeUrl` call every typed value goes through on submit, which
 * is what guarantees the scheme `POST /crawl/discover` requires.
 */
export function resolveWebsitePrefill(
  botWebsite: string | null | undefined,
  clientWebsite: string | null | undefined,
): string {
  return (botWebsite ?? '').trim() || (clientWebsite ?? '').trim() || '';
}
