/**
 * Per-address memo for the widget's real-time email check.
 *
 * The gate in every contact form (handoff, pre-chat lead capture, offline
 * message) resolves the address that is in the field AT SUBMIT TIME, not a
 * "we already validated something once" flag. That is what stops a second
 * address inheriting the first one's verdict, and it means the same address
 * gets asked about twice: once on blur, once on submit.
 *
 * This memo makes that free. Keyed on the exact normalized address and held
 * for the life of the page, because the server's answer for one address does
 * not change between two blurs seconds apart (it caches the vendor verdict
 * itself). Storing the PROMISE rather than the value also collapses an
 * in-flight blur check and the submit check into a single request.
 *
 * Entries are keyed on the ADDRESS and nothing else: never the form, never
 * the session. A different address must always get its own answer.
 */

export const EMAIL_VERDICT_CACHE_MAX = 50;

/**
 * @param {number} max Maximum entries retained. Oldest is evicted first.
 * @returns {{resolve: (key: string, fetcher: () => Promise<{verdict: any, cacheable?: boolean}>) => Promise<any>, size: () => number}}
 */
export const createEmailVerdictCache = (max = EMAIL_VERDICT_CACHE_MAX) => {
    const entries = new Map();

    const resolve = (key, fetcher) => {
        const cached = entries.get(key);
        if (cached) return cached;

        const pending = fetcher().then(({ verdict, cacheable = true }) => {
            // A fail-open answer (network error, 429, 5xx) describes our
            // outage, not the address. Drop it so the next attempt retries
            // instead of inheriting the outage for the rest of the visit.
            if (!cacheable) entries.delete(key);
            return verdict;
        });

        if (entries.size >= max) {
            // Map preserves insertion order, so this evicts the oldest entry.
            entries.delete(entries.keys().next().value);
        }
        entries.set(key, pending);
        return pending;
    };

    return { resolve, size: () => entries.size };
};
