import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source-level contract tests.
//
// These assert on the TEXT of two React components, which is a weaker guarantee
// than exercising them, and it is deliberate: the widget has no DOM test
// harness (no jsdom, no testing-library, no react-test-renderer), so a handler
// defined inside a `useCallback` cannot be invoked from `node --test` at all.
// The behaviours below — a caller that must not double-render an error, a
// visitor email that must not skip the server check, an effect that must abort
// its stream on unmount — have no pure core to extract without inventing
// indirection none of the sibling components have. A source contract that
// fails the moment the call disappears is worth more here than no coverage;
// the real end-to-end coverage lives in `tests/e2e`.

const read = (relative) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const CHAT_WINDOW = read('../components/ChatWindow.jsx');
const QUOTATION_FLOW = read('../components/QuotationFlow.jsx');

// ── W1: one stream error, one bubble ─────────────────────────────────────────

test('the outer catch stands down once onError has rendered the failure', () => {
    // `onError` renders a friendly message; the rethrow then reached the outer
    // catch, which appended a second generic bubble. Out of credits read as
    // "We're temporarily over capacity" followed by "I'm sorry, I couldn't
    // generate a response" — one failure, two contradictory answers.
    assert.match(
        CHAT_WINDOW,
        /if \(err\?\.handled\) return;/,
        'ChatWindow must skip its generic bubble for an error onError already showed',
    );
});

test('the outer catch binds the error it is deciding about', () => {
    // A bare `} catch {` cannot inspect the error, which is why the duplicate
    // was unavoidable before.
    assert.doesNotMatch(
        CHAT_WINDOW.slice(CHAT_WINDOW.indexOf('const handleSend')),
        /\}\s*catch\s*\{\s*\n\s*setIsTyping\(false\);\s*\n\s*setMessages/,
        'handleSend must not fall back to an unbound catch that always renders',
    );
});

// ── W2: HTTP 429 ─────────────────────────────────────────────────────────────

test('429 is mapped to its own copy in the stream error handler', () => {
    assert.match(CHAT_WINDOW, /err\?\.status === 429/);
    assert.match(CHAT_WINDOW, /system\.error_rate_limited/);
});

test('every locale carries the new rate-limit string', async () => {
    // Not a source scan: the dictionaries are data, and a key present in one
    // locale and missing in another is how a translated widget falls back to
    // English mid-sentence.
    const en = (await import('../i18n/locales/en.js')).default;
    const hi = (await import('../i18n/locales/hi.js')).default;
    for (const [name, dict] of [['en', en], ['hi', hi]]) {
        const copy = dict.messages.system.error_rate_limited;
        assert.equal(typeof copy, 'string', `${name} is missing messages.system.error_rate_limited`);
        assert.ok(copy.length > 0, `${name}.messages.system.error_rate_limited is empty`);
    }
});

// ── W3: abort the stream when the widget goes away ───────────────────────────

test('the chat stream is given an abort signal and is aborted on unmount', () => {
    assert.match(CHAT_WINDOW, /new AbortController\(\)/, 'no controller is created for the chat stream');
    assert.match(CHAT_WINDOW, /signal: abortController\.signal/, 'the signal never reaches sendMessageStream');
    assert.match(
        CHAT_WINDOW,
        /useEffect\(\(\) => \(\) => \{\s*\n\s*streamAbortRef\.current\?\.abort\(\);/,
        'nothing aborts the in-flight stream when ChatWindow unmounts',
    );
});

// ── W4: the offline-form probe must be bounded ───────────────────────────────

test('the offline availability probe runs through the bounded poller', () => {
    assert.match(CHAT_WINDOW, /startBoundedPoll\(\{/, 'the probe is not using the bounded driver');
    assert.doesNotMatch(
        CHAT_WINDOW,
        /setInterval\(poll, 15000\)/,
        'the unbounded 15s handoff re-poll is back',
    );
});

// ── W5: the quotation email is verified like every other visitor email ───────

test('QuotationFlow checks the email with the server before capturing the lead', () => {
    // LeadCaptureForm, HandoffForm and the offline form all gate on the server
    // verdict. The quotation form — the one whose address gets mailed a priced
    // quotation — validated with a local regex and nothing else.
    assert.match(
        QUOTATION_FLOW,
        /validateEmail as checkEmailWithServer/,
        'QuotationFlow does not import the server-side email check',
    );
    const submitAt = QUOTATION_FLOW.indexOf('await submitLeadCapture(');
    const checkAt = QUOTATION_FLOW.indexOf('await checkEmailWithServer(');
    assert.notEqual(checkAt, -1, 'QuotationFlow never calls the server-side check');
    assert.ok(checkAt < submitAt, 'the check must gate the capture, not follow it');
    assert.match(
        QUOTATION_FLOW,
        /if \(!verdict\.valid\)/,
        'the verdict is fetched but never acted on',
    );
});

test('the quotation skip always closes the card, even if the server refuses', () => {
    // The write routes are now plan- and BANT-gated, so a skip can legitimately
    // come back 403 for a visitor whose bot was downgraded mid-flow. Leaving
    // `finish` inside the try would trap them in a card with no way out.
    const skip = QUOTATION_FLOW.slice(
        QUOTATION_FLOW.indexOf('const handleSkip'),
        QUOTATION_FLOW.indexOf('// ── Step 1'),
    );
    assert.match(skip, /finally \{\s*\n\s*finish\('skipped'\);/, 'skip can strand the visitor on an error');
});

// ── W6: the handoff form is not held behind a quotation poll it cannot need ─

test('the explicit handoff skips the quotation poll for a session minted on the spot', () => {
    // "Talk to a human" from the welcome screen mints the session id right in
    // triggerHandoff. The server has no row for it, so GET /chat/quotation can
    // only ever answer `active: false`; polling it five times over 4.5s of
    // spacing was the ten-second gap between the tap and the form on a phone.
    const trigger = CHAT_WINDOW.slice(
        CHAT_WINDOW.indexOf('const triggerHandoff = useCallback'),
        CHAT_WINDOW.indexOf('const handleQuotationFlowComplete'),
    );
    assert.match(trigger, /sessionMintedNow = true;/, 'triggerHandoff no longer records that it minted the session');
    assert.match(
        trigger,
        /sessionMintedNow \? false : await maybeInjectQuotation\(activeSessionId\)/,
        'a freshly minted session must go straight to the handoff form',
    );
});

test('the quotation poll stands down when the server says no quote card can fire', () => {
    // `quotation_enabled: false` on the public settings payload means catalog
    // off/empty or a plan without the flow. The widget cannot tell that apart
    // from "BANT not extracted yet" out of an `active: false` reply, which is
    // why it used to run the full series for every bot on the platform.
    const probe = CHAT_WINDOW.slice(
        CHAT_WINDOW.indexOf('const maybeInjectQuotation = useCallback'),
        CHAT_WINDOW.indexOf('const triggerHandoff = useCallback'),
    );
    assert.match(probe, /settings\?\.quotation_enabled === false/, 'the settings flag is not read');
    assert.match(probe, /quotationProbeSchedule\(\{/, 'the poll is not sized from the stream-close stamp');
    assert.match(probe, /if \(Date\.now\(\) >= deadline\) break;/, 'the poll does not stop at the extraction deadline');
    assert.doesNotMatch(probe, /\[0, 700, 1000, 1300, 1500\]/, 'the unconditional five-poll series is back');
});

test('the stream-close stamp is taken where the answer completes', () => {
    const finalMeta = CHAT_WINDOW.slice(
        CHAT_WINDOW.indexOf('onFinalMetadata: async (finalMeta) => {'),
        CHAT_WINDOW.indexOf('onError: (err) => {'),
    );
    assert.match(finalMeta, /lastStreamClosedAtRef\.current = Date\.now\(\);/, 'onFinalMetadata must stamp the stream close');
});
