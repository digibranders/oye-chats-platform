import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Right-to-left layout, guarded at the source.
 *
 * `app-entry` sets `dir` on the shadow container from the locale, which makes
 * the whole panel an RTL paragraph in Arabic. That is correct and it is not
 * sufficient: the strings inside it are not all Arabic. The customer's launcher
 * text, their chatbot's name, their welcome copy and the visitor's own messages
 * are in whatever language those people wrote them, and a run of English inside
 * an RTL paragraph gets reordered by the bidi algorithm unless it is told not
 * to be.
 *
 * What that looked like in production, all in Arabic:
 *
 *   "Have Questions?"  ->  "?Have Questions"    trailing punctuation jumps
 *   "Hi there!"        ->  "!Hi there"                    same
 *   "/new"             ->  "new/"               a command nobody can type
 *   "OyeChats"         ->  "stahCeyO"           the name, backwards
 *
 * The last one is the interesting one and the reason this file exists rather
 * than a note in a review. The header renders the bot's name one `<span>` per
 * character for a hover animation. Each character then becomes its own bidi
 * run, so the browser lays them out right-to-left individually and the name
 * comes out reversed. Nothing about that is visible in the diff that adds the
 * animation, and nothing catches it but looking at the widget in Arabic.
 *
 * These read source rather than render, deliberately. The bug is an attribute
 * that has to be present at a specific place, and a jsdom render proves nothing
 * about bidi anyway: jsdom does no layout, so it will happily "render" a
 * reversed name correctly.
 */

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('rtl: a name split into per-character spans declares its direction', () => {
    // The reversal bug. Splitting a string gives every character its own bidi
    // run; without an explicit direction on the wrapper the browser orders
    // those runs by the PARAGRAPH's direction and the name renders backwards.
    const source = read('../components/ChatWindow.jsx');
    const split = source.indexOf('Array.from(botName)');
    assert.notEqual(split, -1, 'the per-letter bot pill moved; re-point this test');

    // The wrapper is the element opened just before the split.
    const wrapper = source.lastIndexOf('<span', split);
    const between = source.slice(wrapper, split);
    assert.match(
        between,
        /dir="auto"/,
        'the span wrapping per-character bot-name letters must set dir, or the name renders reversed in Arabic',
    );
});

test('rtl: a slash command renders left-to-right whatever the panel does', () => {
    // `/new` is a literal token the visitor types. Bidi moves the leading
    // slash to the far side in an RTL paragraph and it reads "new/", which is
    // not a command. It is never translated, so it is always LTR.
    const source = read('../components/ChatInput.jsx');
    const at = source.indexOf('/{cmd.name}');
    assert.notEqual(at, -1, 'the slash-command row moved; re-point this test');

    const wrapper = source.lastIndexOf('<span', at);
    assert.match(
        source.slice(wrapper, at),
        /dir="ltr"/,
        'the slash-command name must be dir="ltr" or it renders as "new/" in Arabic',
    );
});

test('rtl: text whose language we cannot know declares dir="auto"', () => {
    // Each of these renders a string written by the customer, the visitor or
    // the model. None of their languages follow from the interface language.
    for (const file of [
        '../components/Launcher.jsx',
        '../components/WelcomeScreen.jsx',
        '../components/MessageBubble.jsx',
    ]) {
        assert.match(
            read(file),
            /dir="auto"/,
            `${file} renders text of unknown language and must isolate its direction`,
        );
    }
});

test('rtl: the launcher uses no physical direction utilities', () => {
    // A physical inset or margin does not mirror, so in Arabic the tooltip,
    // the greeting bubble and the unread badge all anchored to the far side
    // from the launcher and ran off the edge of the screen.
    //
    // The first version of this test checked only the tooltip, and the greeting
    // bubble beside it was still pinned with `right-0`. Checking the whole file
    // rather than one element is what found that, so it checks the whole file.
    const source = read('../components/Launcher.jsx');

    const offenders = source
        .split('\n')
        .map((line, i) => [i + 1, line])
        // Comments name these utilities in order to explain why they are gone.
        .filter(([, line]) => !/^\s*(\/\/|\*|\{\/\*)/.test(line))
        .filter(([, line]) => /(^|[\s"'`])-?(right|left)-[\d.]|(^|[\s"'`])m[rl]-[\d.]|text-(left|right)\b/.test(line));

    assert.deepEqual(
        offenders.map(([n, line]) => `${n}: ${line.trim().slice(0, 80)}`),
        [],
        'use logical utilities (start-/end-/ms-/me-/text-start) so the launcher mirrors in Arabic',
    );
});
