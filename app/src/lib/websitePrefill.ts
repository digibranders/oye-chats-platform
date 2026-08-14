/**
 * Website prefill resolution - shared by every "which site should we train on?"
 * field in the product.
 *
 * Signup already asks for the account's website and stores it on the client
 * row (surfaced on `GET /auth/me` as `website`), and the create-chatbot modal
 * stores a website on the bot itself. Neither surface may make the user retype
 * a URL the product already knows.
 *
 * This lives in `lib/` rather than beside either caller on purpose: it is one
 * precedence rule shared by Launch Studio's Train step and the agent Knowledge
 * tab's Add-knowledge panel. Two copies of "which website wins" would drift,
 * and the two screens would start disagreeing about the same bot.
 */

/**
 * Pick the URL to prefill into a website field.
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
 *
 * Callers decide whether a resolved value is APPROPRIATE to show - this
 * function only decides which one it would be. The Knowledge tab, for
 * instance, suppresses a prefill whose site is already trained.
 */
export function resolveWebsitePrefill(
  botWebsite: string | null | undefined,
  clientWebsite: string | null | undefined,
): string {
  return (botWebsite ?? '').trim() || (clientWebsite ?? '').trim() || '';
}
