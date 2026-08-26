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
 * i18n-exempt-file: this is not dashboard chrome. It is a briefing
 * PASTED INTO the user's own coding agent, carrying markdown, code fences, HTML
 * snippets and API instructions. Translating it would degrade the instructions
 * the agent acts on, and it embeds `platformIntegrations` steps verbatim, which
 * are English by design. The operator reads the dashboard in their language;
 * their coding agent reads this in English.
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
import { attributionAnchorHtml } from '../../../data/widgetEmbed';

export interface BuildInstallPromptOptions {
  /** The agent's public embed key (`data-bot-key`). */
  botKey: string;
  /** Backend the dashboard talks to - the same one the widget will call. */
  apiBaseUrl: string;
  /** Which widget bundle the snippets point at. */
  env: PlatformEnv;
  /** The platform the user picked; when null the prompt asks the agent to detect it. */
  platform?: Platform | null;
  /** Include the crawlable attribution anchor in the briefing. Defaults to true. */
  attribution?: boolean;
}

/** Render one install step as a numbered markdown block with its code fence. */
function renderStep(step: { title: string; description: string; code: string | null; language?: string }, index: number): string {
  const head = `${index + 1}. **${step.title}**\n   ${step.description}`;
  if (!step.code) return head;
  return `${head}\n\n\`\`\`${step.language ?? ''}\n${step.code}\n\`\`\``;
}

/** Steps to use when the user hasn't picked a platform yet. */
function genericSteps(botKey: string, scriptUrl: string, { attribution }: { attribution: boolean }): string {
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
    ...(attribution
      ? [
          '',
          'And directly beside it, this visible attribution link:',
          '',
          '```html',
          attributionAnchorHtml(botKey),
          '```',
        ]
      : []),
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
  attribution = true,
}: BuildInstallPromptOptions): string {
  const scriptUrl = widgetScriptUrl(env);
  const api = apiBaseUrl.replace(/\/+$/, '');
  const target = platform ? platform.name : 'my website';

  const steps = platform
    ? platform.getSteps(botKey, env, { attribution }).map(renderStep).join('\n\n')
    : genericSteps(botKey, scriptUrl, { attribution });

  return `# Task: Install OyeChats AI Chat Widget on ${target}

Install the OyeChats chat widget so it loads on every page of the website.

## Widget Snippet
\`\`\`html
<script src="${scriptUrl}" data-bot-key="${botKey}"></script>
\`\`\`

- **Bot Key:** \`${botKey}\` (Public identifier - safe to commit)
- **Widget Script:** \`${scriptUrl}\`
- **API Base:** \`${api}\`

## Installation Steps${platform ? ` (${platform.name})` : ''}

${steps}

## Guidelines
1. **Load Site-wide:** Include the snippet once in the root layout or main template before \`</body>\`. Do not duplicate it.
2. **Public Key:** \`${botKey}\` is safe to commit in client code.
3. **No Local Bundling:** Do not vendor or npm install the bundle; load directly from \`${scriptUrl}\`.
4. **Attribution Link:** ${
    attribution
      ? 'The anchor text and `rel="nofollow"` must appear in the HTML the server sends, visible to a normal reader - verify with `curl` on the page (before any JavaScript runs) and confirm the text is there. Non-exhaustive examples of what breaks this: CSS that hides an element or its content, the `hidden`/`aria-hidden` attributes or a visually-hidden ("sr-only") class, `next/dynamic(..., { ssr: false })`, lazy-loading, or any client-only component.'
      : 'Do not add an attribution link for this account, and leave any existing one on the site untouched - this only controls what gets added, not what is already there.'
  }
5. **Verification:**
   - Public info probe: \`GET ${api}/bots/settings/public\` (H: X-Bot-Key: ${botKey})
   - AI chat probe (consumes one message credit): \`POST ${api}/chat\` (H: X-Bot-Key: ${botKey}). Do not add an \`Origin\` or \`Referer\` header when testing via curl.
6. **CSP Allowances (if CSP is active):** \`script-src ${new URL(scriptUrl).origin}\` and \`connect-src ${api}\`.`;
}
