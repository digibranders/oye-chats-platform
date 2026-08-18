import { RotateCcw, Eraser, Headphones } from 'lucide-react';

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
export const SLASH_COMMANDS = [
    {
        name: 'new',
        label: 'New chat',
        description: 'Start a fresh conversation',
        icon: RotateCcw,
        destructive: true,
        handlerKey: 'onNewChat',
        isAvailable: (ctx) => (ctx?.userMessageCount ?? 0) >= 1,
    },
    {
        name: 'clear',
        label: 'Clear chat',
        description: 'Hide the messages above',
        icon: Eraser,
        destructive: false,
        handlerKey: 'onClearMessages',
        isAvailable: (ctx) => (ctx?.userMessageCount ?? 0) >= 1,
    },
    {
        name: 'human',
        label: 'Talk to a human',
        description: 'Request a live agent',
        icon: Headphones,
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
