import React from 'react';
import { RotateCcw, Eraser, Globe } from 'lucide-react';

// Hand-rolled rather than imported so it matches the headphones glyph the
// composer's own handoff button draws inline.
//
// `size` MUST be translated into width/height here. The popover renders every
// command icon as `<Icon size={14} />`, which is lucide-react's API: the other
// two commands use real lucide components and honour it. This one is a bare
// <svg>, where an unknown `size` prop lands as an inert SVG attribute and the
// element falls back to filling its container. That shipped: `/human` is the
// only command offered on a fresh chat, so the palette rendered as one
// full-width headphones icon roughly 300px tall with the label squeezed to
// zero width.
const HeadphonesIcon = ({ size = 24, ...props }) =>
    React.createElement(
        'svg',
        {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            ...props,
        },
        React.createElement('path', {
            d: 'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3',
        })
    );

// Visitor-facing slash commands rendered by ChatInput's `/` popover.
// Each entry is picked by exact name (case-insensitive) or by keyboard-navigated
// selection in the popover; the composer never forwards a matched slash command
// as a chat message to the bot. `destructive: true` opts the command into the
// inline confirm bar before its handler runs.
//
// `isAvailable(ctx)` hides a command from the palette when it would be a no-op
// in the current session state. Fresh chats show only `/human`. Running
// `/clear` or `/new` on a transcript that only holds the welcome message
// does nothing visible and confuses visitors who typed a command expecting
// a result. Predicates receive `{ userMessageCount }` (extend as needed).
//
// `name` is the command's IDENTITY: it is what the visitor types, what
// matchSlashCommand/filterSlashCommands compare against, and what the popover
// prints as `/name`. It is deliberately NOT translated, so a Hindi visitor
// still types `/human` and the matcher keeps working.
//
// `descriptionKey` carries the DISPLAY copy instead of a resolved string.
// (`label` is not keyed: the popover renders `/${name}` as the title and only
// `description` beneath it, so a translated label would be copy nobody sees.) This array is a module-level constant evaluated once at import,
// long before a locale is chosen, so calling t() here would freeze whichever
// language happened to be active at load time. ChatInput resolves the keys at
// render, which is also what makes the palette follow a mid-session switch.
export const SLASH_COMMANDS = [
    {
        name: 'new',
        label: 'New chat',
        description: 'Start a fresh conversation',
        descriptionKey: 'commands.new_description',
        icon: RotateCcw,
        destructive: true,
        handlerKey: 'onNewChat',
        isAvailable: (ctx) => (ctx?.userMessageCount ?? 0) >= 1,
    },
    {
        name: 'clear',
        label: 'Clear chat',
        description: 'Hide the messages above',
        descriptionKey: 'commands.clear_description',
        icon: Eraser,
        destructive: false,
        handlerKey: 'onClearMessages',
        isAvailable: (ctx) => (ctx?.userMessageCount ?? 0) >= 1,
    },
    {
        // Offered only when the header menu would offer it too: the bot is
        // multilingual, the customer allows visitors to switch, and there is
        // more than one language to switch between. ChatWindow decides that
        // once and gates this command by withholding the handler, which is the
        // same mechanism `/human` uses when live chat is off.
        name: 'language',
        label: 'Change language',
        description: 'Read this chat in another language',
        descriptionKey: 'commands.language_description',
        icon: Globe,
        destructive: false,
        handlerKey: 'onOpenLanguage',
        isAvailable: () => true,
    },
    {
        name: 'human',
        label: 'Talk to a human',
        description: 'Request a live agent',
        descriptionKey: 'commands.human_description',
        icon: HeadphonesIcon,
        destructive: false,
        handlerKey: 'onHandoff',
        isAvailable: () => true,
    },
];

export const SLASH_HINT_THRESHOLD = 3;

const WHOLE_INPUT_SLASH_RE = /^\/([a-z]+)$/i;

// Returns the command entry that matches the raw composer input, or null.
// Matches only when the input is exactly `/<name>`, never mid-sentence.
// This is what governs whether Enter intercepts execution: "hello /human"
// is deliberately not a match so the visitor's surrounding text is never
// silently discarded when they press Enter.
export function matchSlashCommand(rawInput) {
    const trimmed = (rawInput || '').trim();
    const m = WHOLE_INPUT_SLASH_RE.exec(trimmed);
    if (!m) return null;
    const name = m[1].toLowerCase();
    return SLASH_COMMANDS.find((c) => c.name === name) || null;
}

// Locates the LAST "orphan" slash token in the input, a `/` at the start
// of the string or right after whitespace, followed by [a-z]* letters, and
// terminated by whitespace or end-of-string. The leading-whitespace guard
// stops URLs (`https://`) and words like "and/or" from opening the popover.
// Returns `{ start, end, query }` on the FULL input string, or null.
const ORPHAN_SLASH_TOKEN_RE = /(^|\s)\/([a-z]*)(?=\s|$)/gi;

export function findActiveSlashToken(rawInput) {
    if (!rawInput) return null;
    let last = null;
    ORPHAN_SLASH_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = ORPHAN_SLASH_TOKEN_RE.exec(rawInput)) !== null) {
        const leadingWs = m[1].length; // 0 if start-of-string, 1 if whitespace
        last = {
            start: m.index + leadingWs,
            end: m.index + m[0].length,
            query: m[2].toLowerCase(),
        };
    }
    return last;
}

// Filters the registry by the currently-active slash token, wherever it
// sits in the input. `/` alone returns the full list; `/n` narrows to
// names starting with "n". No slash token → empty list (popover hides).
export function filterSlashCommands(rawInput) {
    const token = findActiveSlashToken(rawInput);
    if (!token) return [];
    if (!token.query) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(token.query));
}

// Splice `/<name>` into the input at the position of the currently-active
// slash token, leaving surrounding text intact. Returns `null` when there
// is no slash token to replace (caller should fall back to normal typing).
export function autocompleteSlashCommand(rawInput, command) {
    const token = findActiveSlashToken(rawInput);
    if (!token) return null;
    const replacement = `/${command.name}`;
    const nextValue = rawInput.slice(0, token.start) + replacement + rawInput.slice(token.end);
    return { value: nextValue, caret: token.start + replacement.length };
}
