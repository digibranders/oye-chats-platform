/**
 * buildInstallPrompt - turns the install screen into a single briefing a user
 * can paste into their own coding agent (Claude Code, Cursor, Copilot, ...).
 *
 * The user's agent has no context about OyeChats, so the prompt has to carry
 * everything it needs in one paste: what the widget is, the exact snippet with
 * the live key, the install steps FOR THE SELECTED PLATFORM (verbatim from
 * `platformIntegrations`, so the prompt can never drift from what the UI shows),
 * how to verify against the API, and the failure modes we already know about.
 *
 * Verification deliberately leads with `GET /bots/settings/public` because it is
 * free; the `/chat` probe is called out as costing a credit so an agent doesn't
 * loop on it. Neither call may spoof an `Origin` header - the backend stamps
 * `Bot.widget_installed_at` off a real browser origin, and a forged one would
 * report the agent installed before it actually is.
 */
import {
  widgetScriptUrl,
  type Platform,
  type PlatformEnv,
} from '../../../data/platformIntegrations';

export interface BuildInstallPromptOptions {
  /** The agent's public embed key (`data-bot-key`). */
  botKey: string;
  /** Backend the dashboard talks to - the same one the widget will call. */
  apiBaseUrl: string;
  /** Which widget bundle the snippets point at. */
  env: PlatformEnv;
  /** The platform the user picked; when null the prompt asks the agent to detect it. */
  platform?: Platform | null;
}

/** Render one install step as a numbered markdown block with its code fence. */
function renderStep(step: { title: string; description: string; code: string | null; language?: string }, index: number): string {
  const head = `${index + 1}. **${step.title}**\n   ${step.description}`;
  if (!step.code) return head;
  return `${head}\n\n\`\`\`${step.language ?? ''}\n${step.code}\n\`\`\``;
}

/** Steps to use when the user hasn't picked a platform yet. */
function genericSteps(botKey: string, scriptUrl: string): string {
  return [
    'This prompt was generated without a platform selected, so **detect the stack yourself** by inspecting the repository, then install the snippet the way that stack expects:',
    '',
    '- **Static HTML** - paste the tag just before `</body>` in every page (or in the shared layout/partial).',
    '- **Next.js** - render `next/script` with `strategy="lazyOnload"` in the root layout (`app/layout.tsx`) or `pages/_app.tsx`.',
    '- **React (Vite/CRA)** - append the script element to `document.body` from a `useEffect` in the root component, and remove it on cleanup.',
    '- **Vue/Nuxt** - add it to `index.html`, or use `useHead({ script: [...] })` in `app.vue` for Nuxt 3.',
    '- **Angular** - paste the tag before `</body>` in `src/index.html`.',
    '- **SvelteKit** - paste the tag before `</body>` in `src/app.html`.',
    '- **Astro** - paste it in the shared layout with the `is:inline` directive so Astro leaves it untouched.',
    '- **A CMS or site builder** (WordPress, Shopify, Squarespace, Webflow, Wix, Framer, Bubble) - there is no repository to edit; tell me which one it is and stop, so I can copy the platform-specific steps from my dashboard.',
    '',
    'Whichever path applies, the tag that must end up on the page is:',
    '',
    '```html',
    `<script src="${scriptUrl}" data-bot-key="${botKey}"></script>`,
    '```',
  ].join('\n');
}

/**
 * Build the paste-ready prompt. Pure string assembly - no clipboard, no DOM -
 * so it stays unit-testable.
 */
export function buildInstallPrompt({
  botKey,
  apiBaseUrl,
  env,
  platform,
}: BuildInstallPromptOptions): string {
  const scriptUrl = widgetScriptUrl(env);
  const api = apiBaseUrl.replace(/\/+$/, '');
  const target = platform ? platform.name : 'my website';

  const steps = platform
    ? platform.getSteps(botKey, env).map(renderStep).join('\n\n')
    : genericSteps(botKey, scriptUrl);

  return `# Task: install the OyeChats AI chat widget on ${target}

You are working in the codebase for my website. Install the OyeChats chat widget so it loads on every page, verify it actually works, and change nothing else.

## What you are installing

OyeChats is a hosted AI chat widget. It is **one script tag** - there is no npm package to add, no environment variable to set, and no backend work. The bundle finds its own \`<script>\` tag, reads \`data-bot-key\`, injects its own CSS, creates \`<div id="oyechats-widget-root">\`, and renders an isolated React app inside it. It runs in the browser only, so it is safe on server-rendered and statically generated pages.

| | |
|---|---|
| Widget bundle | \`${scriptUrl}\` |
| Bot key (public identifier - safe to commit) | \`${botKey}\` |
| API base URL | \`${api}\` |
| Platform | ${platform ? platform.name : 'detect from the repository'} |

## Install steps${platform ? ` (${platform.name})` : ''}

${steps}

## Rules

- Load the widget **exactly once**, site-wide. Two copies render two launchers.
- Load it from the URL above. Do not vendor, bundle, self-host, or proxy the file - it is versioned on our CDN and updates itself.
- \`${botKey}\` is a **public** key, like a Google Analytics ID. Do not move it into a secret, a server-only env var, or a \`.env\` file that isn't shipped to the browser.
- Do not restyle, wrap, or reposition the widget, and do not touch \`#oyechats-widget-root\`. Appearance is configured from my OyeChats dashboard.
- If the site sends a \`Content-Security-Policy\`, it must allow \`script-src ${new URL(scriptUrl).origin}\`, \`connect-src ${api}\`, and inline styles for the injected stylesheet. If the CSP needs changing, make the minimal edit and tell me exactly what you changed.
- Keep the change to the smallest possible diff. Do not upgrade dependencies or reformat unrelated files.

## Verify with the API

Run these from your shell. **Do not add an \`Origin\` or \`Referer\` header** - my dashboard detects a real install from the browser's own origin, and a forged one would mark the agent "installed" before it is.

1. **Check the key is live** (free, no credits used):

\`\`\`bash
curl -sS -i "${api}/bots/settings/public" -H "X-Bot-Key: ${botKey}"
\`\`\`

   Expect \`200\` and a JSON body with the agent's display settings. A \`401\`/\`403\` means the key is wrong - stop and tell me.

2. **Check the AI answers** (this consumes one message credit from my plan - run it **once**, do not loop):

\`\`\`bash
curl -sS -X POST "${api}/chat" \\
  -H "X-Bot-Key: ${botKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"question":"What do you do?"}'
\`\`\`

   Expect \`200\` with an answer in the JSON body.

3. **Check it renders.** Run the site locally (or open the deployed page) and confirm all of:
   - the request to \`${scriptUrl}\` returns \`200\`
   - \`document.getElementById('oyechats-widget-root')\` exists
   - \`window.OYECHATS_BOT_KEY === '${botKey}'\`
   - the launcher is visible in the bottom-right, opens on click, and replies to a message
   - the browser console shows no errors prefixed \`[OyeChats]\`

## If something is wrong

- **\`401\`/\`403\` from the API** - the bot key is wrong or was truncated. Report it; do not guess another key.
- **Script 404s** - the URL was altered. Restore it exactly as given above.
- **Nothing renders and the console shows CSP violations** - apply the CSP allowances listed under Rules.
- **Widget loads but every reply says we're away, or it never appears on the live domain** - that is account-side (subscription state, or domain restrictions that don't list this site's domain). Tell me the exact domain you tested on and stop; it is fixed in my dashboard, not in the code.

## Done when

The snippet is committed in the right place, all three verification checks above pass, and you have told me: which file(s) you changed, the domain you tested on, and the actual reply text the AI returned.`;
}
