/**
 * Tells a deliberate customer override apart from copy the backend seeded.
 *
 * THE PROBLEM
 * -----------
 * Customer-authored copy beats the translated default, by design: a greeting
 * somebody wrote should not be replaced by a generic one. The widget implements
 * that as `settings.welcome_title || t('...')`.
 *
 * But the backend does not leave these fields empty. `bots.welcome_title`,
 * `bots.welcome_subtitle`, `bots.waiting_message` and `bots.widget_messages`
 * all carry a `server_default` (api/app/db/models.py), and
 * `GET /bots/settings/public` coerces the nullable ones a second time
 * (`bot.welcome_title or "Hi there 👋"`). So EVERY bot arrives at the widget
 * with these fields populated, whether or not a human ever typed in them.
 *
 * The result: `settings.welcome_title` was always truthy, the `|| t(...)` was
 * dead code, and the entire welcome screen rendered in English on a bot
 * configured for Hindi. The admin's own notice promises "leave a field empty to
 * keep the translated default", which was impossible.
 *
 * THE RULE
 * --------
 * A configured value only counts as authored when it DIFFERS from the seeded
 * default. Byte-identical means nobody chose it.
 *
 * The trade is that a customer who deliberately retypes the default string
 * exactly gets it translated. That is the right way to be wrong: they asked for
 * the default wording, and a translated default is what the default means on a
 * multilingual bot.
 *
 * Keep SEEDED in step with models.py. The parity is asserted by
 * api/tests/test_seeded_copy_contract.py, which reads this file.
 */

/** Verbatim copies of the backend's server_default values. */
export const SEEDED = {
    welcome_title: 'Hi there 👋',
    welcome_subtitle: 'How can we help you today?',
    waiting_message: 'Connecting you to support...',
    input_placeholder: 'Write a message...',
    rating_prompt: 'How was your experience?',
    welcome_suggestions: ['Our Services', 'About us', 'Contact us'],
};

/**
 * The customer's own wording, or null when the field is empty or still holds
 * the seeded default. A null return is the caller's signal to use `t()`.
 */
export function authoredCopy(configured, seeded) {
    if (typeof configured !== 'string') return null;
    const trimmed = configured.trim();
    if (!trimmed) return null;
    return trimmed === seeded.trim() ? null : configured;
}

/** Array form, for `welcome_suggestions`. Order is part of the identity. */
export function authoredList(configured, seeded) {
    if (!Array.isArray(configured) || configured.length === 0) return null;
    const same =
        configured.length === seeded.length &&
        configured.every((v, i) => typeof v === 'string' && v.trim() === seeded[i]);
    return same ? null : configured;
}
