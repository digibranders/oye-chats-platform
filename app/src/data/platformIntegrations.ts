/**
 * @i18n-exempt-file: the install steps stay ENGLISH, deliberately.
 *
 * They are not dashboard chrome. Every step points at a THIRD-PARTY interface
 * the reader is looking at in English - "Online Store → Themes → Edit code",
 * "Appearance → Theme File Editor", "Insert Headers and Footers". Those menu
 * labels are Shopify's and WordPress's, not ours, and we cannot translate
 * them. A Hindi sentence naming an English menu is harder to follow than an
 * English one, not easier.
 *
 * They are also interleaved with `code` the reader pastes verbatim, and
 * `channels/installPrompt` embeds the same steps into a briefing for the
 * user's coding agent, which must stay English for the same reason that file
 * is exempt.
 *
 * If this is revisited, the render sites in `channels/WebsiteInstall` and
 * `launch-studio/steps/DeployStep` are where a lookup would go, keyed by
 * platform id and step index.
 */

/** Which widget build the generated snippet points at. */
export type PlatformEnv = 'production' | 'development';

/** One numbered instruction in a platform's install guide. */
export interface PlatformStep {
  title: string;
  description: string;
  /** The block the reader pastes, or null for a step that is prose only. */
  code: string | null;
  language?: string;
}

export interface GetStepsOptions {
  /** Include the crawlable attribution anchor. Defaults to true. */
  attribution?: boolean;
}

/**
 * How a platform's attribution anchor is rendered: as JSX for framework
 * snippets, as raw HTML, or as a separate manual step for builders whose
 * editors reject markup.
 */
export type AttributionMode = 'manual' | 'jsx' | 'html';

export interface Platform {
  id: string;
  name: string;
  category: string;
  description: string;
  getSteps: (botKey: string, env: PlatformEnv, options?: GetStepsOptions) => PlatformStep[];
}

/**
 * Platform integration configurations for the OyeChats widget.
 *
 * Each platform provides:
 *  - id, name, category, description  - metadata for the selector grid
 *  - attribution mode                 - how this platform can host a
 *    server-rendered attribution anchor ('html' | 'jsx' | 'manual')
 *  - getSteps(botKey, env, options)   - returns an array of step objects
 *    whose code snippets dynamically reflect the chosen environment.
 *
 * env is 'production' | 'development'.
 */
import {
    ATTRIBUTION_TEXT,
    attributionAnchorHtml,
    attributionAnchorJsx,
    attributionHref,
    MANUAL_ATTRIBUTION_NOTE,
} from './widgetEmbed';

/**
 * The widget bundle URL for an environment. Exported so every surface that
 * quotes the embed (install steps, the AI-agent install prompt) resolves the
 * same source and cannot drift.
 *
 * @param {'production' | 'development'} env
 * @returns {string}
 */
export const widgetScriptUrl = (env: PlatformEnv): string =>
    env === 'production'
        ? 'https://cdn.oyechats.com/oyechats-widget.js'
        : 'http://localhost:4173/oyechats-widget.js';

const cdnUrl = widgetScriptUrl;

/**
 * The attribution step appended to a platform's install steps.
 *
 * Returns an empty array when attribution is off (plans entitled to remove
 * branding), so callers can spread it unconditionally.
 *
 * @param {string} botKey
 * @param {'html' | 'jsx' | 'manual'} mode
 * @param {string} location - where the user should paste it, in their words
 * @param {boolean} attribution
 * @returns {Array<{title: string, description: string, code: string | null, language?: string}>}
 */
const attributionStep = (
    botKey: string,
    mode: AttributionMode,
    location: string,
    attribution: boolean,
): PlatformStep[] => {
    if (!attribution) return [];
    if (mode === 'manual') {
        return [
            {
                title: 'Add the attribution link to your site template',
                description: `${MANUAL_ATTRIBUTION_NOTE} For attribution a crawler can read, paste the link below into ${location}.`,
                code: attributionAnchorHtml(botKey),
                language: 'html',
            },
        ];
    }
    return [
        {
            title: 'Add the attribution link',
            description: `Paste this next to the widget snippet in ${location}. It is a normal visible link, so search engines and AI crawlers can read it - unlike the in-widget badge, which only exists after a visitor opens the chat.`,
            code: mode === 'jsx' ? attributionAnchorJsx(botKey) : attributionAnchorHtml(botKey),
            language: mode === 'jsx' ? 'jsx' : 'html',
        },
    ];
};

/**
 * One added sentence, appended to a script-tag step's own description, so the
 * customer knows - up front, not two steps later - that the block they are
 * about to copy also carries a small visible credit line and how to remove
 * it. Used only where the anchor is folded into the same code block as the
 * script tag (see `withInlineAttribution`).
 */
const INLINE_ATTRIBUTION_NOTE =
    ' This block also includes a small visible "Powered by OyeChats" credit line. Add the branding removal add-on to your plan to remove it.';

/**
 * Folds the attribution anchor into an existing script-tag step's own code
 * block and description, instead of appending it as a separate step. This is
 * how `html`- and `jsx`-mode platforms surface attribution: customers copy
 * one block once, rather than a script tag and then a second, easy-to-skip
 * "attribution link" step - the exact split-step pattern that produced zero
 * backlinks under the old in-widget-only badge.
 *
 * Returns `code`/`description` byte-identical to the input when attribution
 * is off, so the `attribution: false` snippet never changes.
 *
 * @param {string} code - the step's existing code block (already includes the script/Script tag)
 * @param {string} description - the step's existing description
 * @param {string} botKey
 * @param {{attribution: boolean, jsx?: boolean}} options
 * @returns {{code: string, description: string}}
 */
const withInlineAttribution = (
    code: string,
    description: string,
    botKey: string,
    { attribution, jsx = false }: { attribution: boolean; jsx?: boolean },
): { description: string; code: string } => {
    if (!attribution) return { description, code };
    const anchor = jsx ? attributionAnchorJsx(botKey) : attributionAnchorHtml(botKey);
    return {
        description: `${description}${INLINE_ATTRIBUTION_NOTE}`,
        code: `${code}\n${anchor}`,
    };
};

/**
 * Same idea as `withInlineAttribution`, for the platforms whose script tag
 * sits in the middle of a larger code block (a full document, a theme
 * template) rather than at the end of it - the anchor has to be interpolated
 * right after the script line, not appended to the block. Each call site
 * supplies its own leading whitespace so the anchor lines up with the
 * surrounding template's indentation; returns `''` when attribution is off,
 * so callers can interpolate it unconditionally and get back exactly today's
 * code.
 *
 * @param {string} botKey
 * @param {boolean} attribution
 * @param {string} [indent] - leading whitespace to match the surrounding block
 * @returns {string}
 */
const inlineAttributionAnchor = (botKey: string, attribution: boolean, indent = ''): string =>
    attribution ? `\n\n${indent}${attributionAnchorHtml(botKey)}` : '';

/** Appends the one-sentence attribution note to a step description, or returns it unchanged when attribution is off. */
const withAttributionNote = (description: string, attribution: boolean): string =>
    attribution ? `${description}${INLINE_ATTRIBUTION_NOTE}` : description;

/**
 * A standalone WordPress hook block that echoes the attribution anchor from
 * `wp_footer` - the correct WordPress hook for markup that belongs just
 * before `</body>`. This is deliberately its own action, not folded into
 * `oyechats_enqueue_widget()`: that function is hooked to
 * `wp_enqueue_scripts`, an *enqueueing* hook, not an output hook - echoing
 * markup from it can print before `<head>` is even open (theme-dependent),
 * can interfere with `wp_head()`'s own output buffering, can trip
 * "headers already sent" warnings under some caching setups, and risks being
 * stripped or mangled by head-optimisation plugins that rewrite `<head>`
 * content. `wp_footer` has none of those failure modes and is exactly where
 * this markup belongs.
 *
 * The anchor is single-quoted PHP: `attributionAnchorHtml` never contains an
 * unescaped `'` (its `href` is percent-encoded by `URL`/`URLSearchParams`
 * and its `style` uses double quotes), so no escaping is needed. Returns
 * `''` when attribution is off, so callers can append it unconditionally and
 * get back exactly today's code.
 *
 * @param {string} botKey
 * @param {boolean} attribution
 * @returns {string}
 */
const phpFooterAttributionBlock = (botKey: string, attribution: boolean): string =>
    attribution
        ? `\n\n// Add the OyeChats attribution link\nfunction oyechats_attribution_link() {\n    echo '${attributionAnchorHtml(botKey)}';\n}\nadd_action('wp_footer', 'oyechats_attribution_link');`
        : '';

/**
 * `wix` / `framer` / `bubble` manual-mode step: these builders' footer text
 * elements accept plain text plus a URL through their own link tool, not
 * markup - pasting `attributionAnchorHtml`'s raw `<a>` tag renders the
 * literal tag as visible text on the customer's live page. So the "code" to
 * copy here is just the destination URL, and the description spells out the
 * link text verbatim.
 *
 * Trade-off, accepted: these builders' link tools do not expose a `rel`
 * attribute, so this variant cannot carry `rel="nofollow"` the way the
 * crawlable-HTML variants do. A handful of manually-placed builder links is
 * a materially different footprint from a sitewide automated one, so this is
 * judged an acceptable trade rather than a gap to close.
 *
 * @param {string} botKey
 * @param {string} location - where the user should paste it, in their words
 * @param {boolean} attribution
 * @returns {Array<{title: string, description: string, code: string | null, language?: string}>}
 */
const manualAttributionLinkStep = (
    botKey: string,
    location: string,
    attribution: boolean,
): PlatformStep[] => {
    if (!attribution) return [];
    return [
        {
            title: 'Add the attribution link to your site footer',
            description: `${MANUAL_ATTRIBUTION_NOTE} These builders' text-element link tools take a URL, not HTML, so add a text link in ${location} reading exactly "${ATTRIBUTION_TEXT}" and point it at the URL below using the builder's own link option. Note: this builder does not let you set rel="nofollow" on the link.`,
            code: attributionHref(botKey),
            language: 'text',
        },
    ];
};

// ---------------------------------------------------------------------------
// HTML / Generic
// ---------------------------------------------------------------------------
const html: Platform = {
    id: 'html',
    name: 'HTML',
    category: 'generic',
    description: 'Any static HTML website',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Add the script tag to your HTML',
            ...withInlineAttribution(
                `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
                'Paste this snippet just before the closing </body> tag in your HTML file.',
                botKey,
                { attribution },
            ),
            language: 'html',
        },
        {
            title: 'Deploy your website',
            description:
                'Upload the updated HTML file to your hosting provider. The chat widget will appear automatically in the bottom-right corner.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Next.js
// ---------------------------------------------------------------------------
const nextjs: Platform = {
    id: 'nextjs',
    name: 'Next.js',
    category: 'framework',
    description: 'App Router or Pages Router',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Import next/script in your root layout',
            description: 'At the top of your root layout file (app/layout.tsx or pages/_app.tsx), add this import.',
            code: `import Script from 'next/script';`,
            language: 'jsx',
        },
        {
            title: 'Add the widget just before </body>',
            ...withInlineAttribution(
                `<Script
  src="${cdnUrl(env)}"
  data-bot-key="${botKey}"
  strategy="lazyOnload"
/>`,
                'Drop the OyeChats widget inside your <body>, right after {children}.',
                botKey,
                { attribution, jsx: true },
            ),
            language: 'jsx',
        },
        {
            title: 'Deploy your application',
            description:
                'Push your changes to your hosting provider (Vercel, Netlify, etc.). The widget loads lazily after the page becomes interactive.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// React (CRA / Vite)
// ---------------------------------------------------------------------------
const react: Platform = {
    id: 'react',
    name: 'React',
    category: 'framework',
    description: 'Create React App or Vite',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Add the script tag to index.html',
            ...withInlineAttribution(
                `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
                'Open public/index.html (Create React App) or index.html (Vite) and paste this just before </body>. This is the simplest place for it: the widget loads on every route without a component having to mount, and it stays in your served HTML, so anything that reads your page without running JavaScript can still see it.',
                botKey,
                { attribution },
            ),
            language: 'html',
        },
        {
            title: 'Or, if you cannot edit index.html, add a useEffect',
            description:
                'An alternative for setups where index.html is generated. Note that the widget is then created by JavaScript at runtime, so it will not appear in your served HTML and our install check cannot see it from outside.',
            code: `import { useEffect } from 'react';

function App() {
  useEffect(() => {
    const script = document.createElement('script');
    script.src = '${cdnUrl(env)}';
    script.setAttribute('data-bot-key', '${botKey}');
    script.async = true;
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, []);

  return (
    // ... your app content
  );
}

export default App;`,
            language: 'jsx',
        },
        ...attributionStep(
            botKey,
            'html',
            'public/index.html (CRA) or index.html (Vite), just before </body>',
            attribution,
        ),
        {
            title: 'Start your dev server or build for production',
            description:
                'Run npm run dev to test locally, or npm run build to create a production bundle. The widget will appear on every page.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Vue.js
// ---------------------------------------------------------------------------
const vue: Platform = {
    id: 'vue',
    name: 'Vue.js',
    category: 'framework',
    description: 'Vue 3 or Nuxt',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Add the script in your App.vue or index.html',
            ...withInlineAttribution(
                `<!-- Option 1: In index.html (Vue CLI / Vite) -->
<!-- Add before </body> in index.html -->
<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
                'The simplest approach is to add the script tag directly in your index.html. For Nuxt, use the useHead composable instead.',
                botKey,
                { attribution },
            ),
            language: 'html',
        },
        {
            title: 'For Nuxt 3: use useHead in app.vue',
            description: attribution
                ? 'If you are using Nuxt 3, add the script via the useHead composable in your app.vue file. useHead only manages <head> tags, so the attribution anchor cannot ride inside that call - it goes in the template block below instead, which Nuxt server-renders by default. This block also includes a small visible "Powered by OyeChats" credit line. Add the branding removal add-on to your plan to remove it.'
                : 'If you are using Nuxt 3, add the script via the useHead composable in your app.vue file.',
            code: attribution
                ? `<script setup>
useHead({
  script: [
    {
      src: '${cdnUrl(env)}',
      'data-bot-key': '${botKey}',
      defer: true,
    },
  ],
});
</script>

<template>
  <!-- ...your existing app.vue template... -->
  ${attributionAnchorHtml(botKey)}
</template>`
                : `<script setup>
useHead({
  script: [
    {
      src: '${cdnUrl(env)}',
      'data-bot-key': '${botKey}',
      defer: true,
    },
  ],
});
</script>`,
            language: 'vue',
        },
        {
            title: 'Deploy your application',
            description:
                'Push your changes. The chat widget will appear on all pages automatically.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Angular
// ---------------------------------------------------------------------------
const angular: Platform = {
    id: 'angular',
    name: 'Angular',
    category: 'framework',
    description: 'Angular 16+',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Add the script to your index.html',
            description: withAttributionNote(
                'Open src/index.html and paste the script tag just before the closing </body> tag.',
                attribution,
            ),
            code: `<!-- src/index.html -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>My App</title>
</head>
<body>
  <app-root></app-root>

  <script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>${inlineAttributionAnchor(botKey, attribution, '  ')}
</body>
</html>`,
            language: 'html',
        },
        {
            title: 'Build and deploy',
            description:
                'Run ng build and deploy the dist/ folder. The widget works with Angular Universal (SSR) as well - it only runs in the browser.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Svelte / SvelteKit
// ---------------------------------------------------------------------------
const svelte: Platform = {
    id: 'svelte',
    name: 'Svelte',
    category: 'framework',
    description: 'Svelte or SvelteKit',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Add the script in your app.html or layout',
            description: withAttributionNote(
                'For SvelteKit, open src/app.html and add the script before </body>. For plain Svelte, use the onMount lifecycle.',
                attribution,
            ),
            code: `<!-- src/app.html (SvelteKit) -->
<!doctype html>
<html lang="en">
<head>%sveltekit.head%</head>
<body data-sveltekit-preload-data="hover">
  <div style="display: contents">%sveltekit.body%</div>

  <script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>${inlineAttributionAnchor(botKey, attribution, '  ')}
</body>
</html>`,
            language: 'html',
        },
        {
            title: 'Alternative: use onMount in a Svelte component',
            description: attribution
                ? 'If you prefer programmatic loading, add this to your root +layout.svelte file. This only injects the script - the attribution line above still needs to be in src/app.html, so add it there too if you use this path.'
                : 'If you prefer programmatic loading, add this to your root +layout.svelte file.',
            code: `<script>
  import { onMount } from 'svelte';

  onMount(() => {
    const script = document.createElement('script');
    script.src = '${cdnUrl(env)}';
    script.setAttribute('data-bot-key', '${botKey}');
    script.async = true;
    document.body.appendChild(script);
  });
</script>`,
            language: 'svelte',
        },
        {
            title: 'Deploy your app',
            description:
                'Push your changes. The widget will load on every page.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Astro
// ---------------------------------------------------------------------------
const astro: Platform = {
    id: 'astro',
    name: 'Astro',
    category: 'framework',
    description: 'Astro static or SSR sites',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Add the script to your shared layout',
            description: withAttributionNote(
                'Open your base layout (e.g. src/layouts/Layout.astro) and paste the script just before the closing </body> tag. The is:inline directive tells Astro to leave this third-party script untouched, so it loads on every page that uses the layout.',
                attribution,
            ),
            code: `---
// src/layouts/Layout.astro
---
<html lang="en">
  <head>
    <slot name="head" />
  </head>
  <body>
    <slot />

    <script is:inline src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>${inlineAttributionAnchor(botKey, attribution, '    ')}
  </body>
</html>`,
            language: 'astro',
        },
        {
            title: 'Build and deploy',
            description:
                'Run npm run build and deploy your dist/ output (or SSR adapter). The widget only runs in the browser, so it works with both static and server-rendered Astro sites.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// WordPress
// ---------------------------------------------------------------------------
const wordpress: Platform = {
    id: 'wordpress',
    name: 'WordPress',
    category: 'cms',
    description: 'Self-hosted or WordPress.com Business',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Option A: Use a plugin (easiest)',
            ...withInlineAttribution(
                `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
                'Install the "Insert Headers and Footers" plugin (by WPCode). Go to Code Snippets → Header & Footer, paste the script in the "Footer" section, and click Save.',
                botKey,
                { attribution },
            ),
            language: 'html',
        },
        {
            title: 'Option B: Add via functions.php',
            description: withAttributionNote(
                'If you prefer code, open your theme\'s functions.php file (Appearance → Theme File Editor → functions.php) and add:',
                attribution,
            ),
            code: `// Add OyeChats Widget
function oyechats_enqueue_widget() {
    wp_enqueue_script(
        'oyechats-widget',
        '${cdnUrl(env)}',
        array(),
        null,
        true
    );
}
add_action('wp_enqueue_scripts', 'oyechats_enqueue_widget');

// Pass the bot key as a data attribute
function oyechats_add_bot_key($tag, $handle) {
    if ('oyechats-widget' === $handle) {
        return str_replace(' src', ' data-bot-key="${botKey}" src', $tag);
    }
    return $tag;
}
add_filter('script_loader_tag', 'oyechats_add_bot_key', 10, 2);${phpFooterAttributionBlock(botKey, attribution)}`,
            language: 'php',
        },
        {
            title: 'Save and verify',
            description:
                'Save your changes, clear any caching plugin, and visit your site. The chat widget should appear in the bottom-right corner.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------
const shopify: Platform = {
    id: 'shopify',
    name: 'Shopify',
    category: 'cms',
    description: 'Shopify stores',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Open the theme code editor',
            description:
                'Go to Online Store → Themes → click the three dots (⋯) on your current theme → Edit code.',
            code: null,
        },
        {
            title: 'Edit theme.liquid',
            description: withAttributionNote(
                'In the Layout section, open theme.liquid. Paste the script just before the closing </body> tag.',
                attribution,
            ),
            code: `<!-- OyeChats Widget -->
<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>${inlineAttributionAnchor(botKey, attribution, '')}
</body>`,
            language: 'html',
        },
        {
            title: 'Save and preview',
            description:
                'Click Save, then preview your store. The widget will appear on all pages including product pages, cart, and checkout (if supported by your plan).',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Squarespace
// ---------------------------------------------------------------------------
const squarespace: Platform = {
    id: 'squarespace',
    name: 'Squarespace',
    category: 'cms',
    description: 'Squarespace websites',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Open Code Injection settings',
            description:
                'Go to Settings → Advanced → Code Injection.',
            code: null,
        },
        {
            title: 'Paste in the Footer section',
            ...withInlineAttribution(
                `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
                'In the "Footer" field, paste the following script and click Save.',
                botKey,
                { attribution },
            ),
            language: 'html',
        },
        {
            title: 'Verify on your live site',
            description:
                'Visit your site and confirm the chat widget appears. Code Injection is available on Business plan and above.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Webflow
// ---------------------------------------------------------------------------
const webflow: Platform = {
    id: 'webflow',
    name: 'Webflow',
    category: 'builder',
    description: 'Webflow sites and projects',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Open Custom Code settings',
            description:
                'Go to Site Settings → Custom Code tab.',
            code: null,
        },
        {
            title: 'Paste in the Footer Code section',
            ...withInlineAttribution(
                `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
                'In the "Footer Code" field (Before </body> tag), paste the following and click Save Changes.',
                botKey,
                { attribution },
            ),
            language: 'html',
        },
        {
            title: 'Publish your site',
            description:
                'Click Publish to push the changes live. Custom Code requires a paid Webflow site plan.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Wix
// ---------------------------------------------------------------------------
const wix: Platform = {
    id: 'wix',
    name: 'Wix',
    category: 'builder',
    description: 'Wix websites',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Open Custom Code settings',
            description:
                'In the Wix Dashboard, go to Settings → Custom Code (under Advanced).',
            code: null,
        },
        {
            title: 'Add custom code snippet',
            description:
                'Click "+ Add Custom Code", paste the script below, set placement to "Body - end", apply to "All pages", and click Apply.',
            code: `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
            language: 'html',
        },
        ...manualAttributionLinkStep(botKey, 'your site footer', attribution),
        {
            title: 'Publish and verify',
            description:
                'Publish your site. Custom Code is available on Premium plans and above.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Framer
// ---------------------------------------------------------------------------
const framer: Platform = {
    id: 'framer',
    name: 'Framer',
    category: 'builder',
    description: 'Framer sites',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Open site settings',
            description:
                'In Framer, click the gear icon (⚙) to open Site Settings → General → Custom Code.',
            code: null,
        },
        {
            title: 'Add to the End of <body> section',
            description:
                'Paste the following in the "End of <body> tag" section and click Save.',
            code: `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
            language: 'html',
        },
        ...manualAttributionLinkStep(botKey, 'your site footer', attribution),
        {
            title: 'Publish your site',
            description:
                'Click Publish. Custom code is available on paid Framer plans.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Bubble
// ---------------------------------------------------------------------------
const bubble: Platform = {
    id: 'bubble',
    name: 'Bubble',
    category: 'builder',
    description: 'Bubble.io apps',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Open the Settings tab',
            description:
                'In the Bubble editor, go to Settings → SEO / metatags tab.',
            code: null,
        },
        {
            title: 'Add the script to the page header or body',
            description:
                'In the "Script/meta tags in body" section, paste the following code and click Save.',
            code: `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
            language: 'html',
        },
        ...manualAttributionLinkStep(botKey, 'your page footer', attribution),
        {
            title: 'Preview or deploy',
            description:
                'Click Preview to test, then Deploy to Live when ready.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Google Tag Manager
// ---------------------------------------------------------------------------
const gtm: Platform = {
    id: 'gtm',
    name: 'Google Tag Manager',
    category: 'tool',
    description: 'Load via GTM container',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Create a new Custom HTML tag',
            description:
                'In your GTM workspace, click Tags → New → choose "Custom HTML" as the tag type.',
            code: null,
        },
        {
            title: 'Paste the widget script',
            description:
                'In the HTML field, paste the following code.',
            code: `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
            language: 'html',
        },
        {
            title: 'Set the trigger',
            description:
                'Add a trigger: choose "All Pages" so the widget loads site-wide. Name the tag "OyeChats Widget" and click Save.',
            code: null,
        },
        {
            title: 'Submit and publish',
            description:
                'Click Submit → Publish in GTM. Use Preview mode first to verify the widget loads correctly.',
            code: null,
        },
        ...attributionStep(
            botKey,
            'manual',
            "your site's own footer template - not a GTM tag",
            attribution,
        ),
    ],
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** All supported platforms in display order. */
export const platforms: Platform[] = [
    html,
    nextjs,
    react,
    vue,
    angular,
    svelte,
    astro,
    wordpress,
    shopify,
    squarespace,
    webflow,
    wix,
    framer,
    bubble,
    gtm,
];

/** Category labels for the selector grid. */
/**
 * The platform the install panel opens on.
 *
 * HTML because it is the one answer that is never wrong: the snippet it gives
 * is a plain script tag, which every platform in this list ultimately reduces
 * to. A reader who knows their stack changes it in one keystroke.
 */
export const DEFAULT_PLATFORM_ID = 'html';

export const categoryLabels: Record<string, string> = {
    generic: 'Generic',
    framework: 'Frameworks',
    cms: 'CMS',
    builder: 'No-Code Builders',
    tool: 'Tools',
};

/** Ordered list of categories for display. */
export const categoryOrder: string[] = ['generic', 'framework', 'cms', 'builder', 'tool'];
