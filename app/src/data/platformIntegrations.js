/**
 * Platform integration configurations for the OyeChats widget.
 *
 * Each platform provides:
 *  - id, name, category, description  — metadata for the selector grid
 *  - getSteps(botKey, env)            — returns an array of step objects
 *    whose code snippets dynamically reflect the chosen environment.
 *
 * env is 'production' | 'development'.
 */

const cdnUrl = (env) =>
    env === 'production'
        ? 'https://cdn.oyechats.com/oyechats-widget.js'
        : 'http://localhost:4173/oyechats-widget.js';

// ---------------------------------------------------------------------------
// HTML / Generic
// ---------------------------------------------------------------------------
const html = {
    id: 'html',
    name: 'HTML',
    category: 'generic',
    description: 'Any static HTML website',
    getSteps: (botKey, env) => [
        {
            title: 'Add the script tag to your HTML',
            description:
                'Paste this snippet just before the closing </body> tag in your HTML file.',
            code: `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
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
const nextjs = {
    id: 'nextjs',
    name: 'Next.js',
    category: 'framework',
    description: 'App Router or Pages Router',
    getSteps: (botKey, env) => [
        {
            title: 'Add the Script component to your root layout',
            description:
                'Open your root layout file (app/layout.tsx or pages/_app.tsx) and add the OyeChats widget using the next/script component.',
            code: `import Script from 'next/script';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script
          src="${cdnUrl(env)}"
          data-bot-key="${botKey}"
          strategy="lazyOnload"
        />
      </body>
    </html>
  );
}`,
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
const react = {
    id: 'react',
    name: 'React',
    category: 'framework',
    description: 'Create React App or Vite',
    getSteps: (botKey, env) => [
        {
            title: 'Add a useEffect in your root component',
            description:
                'Open your App.jsx (or App.tsx) and add the following useEffect hook to dynamically load the widget script.',
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
const vue = {
    id: 'vue',
    name: 'Vue.js',
    category: 'framework',
    description: 'Vue 3 or Nuxt',
    getSteps: (botKey, env) => [
        {
            title: 'Add the script in your App.vue or index.html',
            description:
                'The simplest approach is to add the script tag directly in your index.html. For Nuxt, use the useHead composable instead.',
            code: `<!-- Option 1: In index.html (Vue CLI / Vite) -->
<!-- Add before </body> in index.html -->
<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
            language: 'html',
        },
        {
            title: 'For Nuxt 3: use useHead in app.vue',
            description:
                'If you are using Nuxt 3, add the script via the useHead composable in your app.vue file.',
            code: `<script setup>
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
const angular = {
    id: 'angular',
    name: 'Angular',
    category: 'framework',
    description: 'Angular 16+',
    getSteps: (botKey, env) => [
        {
            title: 'Add the script to your index.html',
            description:
                'Open src/index.html and paste the script tag just before the closing </body> tag.',
            code: `<!-- src/index.html -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>My App</title>
</head>
<body>
  <app-root></app-root>

  <script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>
</body>
</html>`,
            language: 'html',
        },
        {
            title: 'Build and deploy',
            description:
                'Run ng build and deploy the dist/ folder. The widget works with Angular Universal (SSR) as well — it only runs in the browser.',
            code: null,
        },
    ],
};

// ---------------------------------------------------------------------------
// Svelte / SvelteKit
// ---------------------------------------------------------------------------
const svelte = {
    id: 'svelte',
    name: 'Svelte',
    category: 'framework',
    description: 'Svelte or SvelteKit',
    getSteps: (botKey, env) => [
        {
            title: 'Add the script in your app.html or layout',
            description:
                'For SvelteKit, open src/app.html and add the script before </body>. For plain Svelte, use the onMount lifecycle.',
            code: `<!-- src/app.html (SvelteKit) -->
<!doctype html>
<html lang="en">
<head>%sveltekit.head%</head>
<body data-sveltekit-preload-data="hover">
  <div style="display: contents">%sveltekit.body%</div>

  <script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>
</body>
</html>`,
            language: 'html',
        },
        {
            title: 'Alternative: use onMount in a Svelte component',
            description:
                'If you prefer programmatic loading, add this to your root +layout.svelte file.',
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
// WordPress
// ---------------------------------------------------------------------------
const wordpress = {
    id: 'wordpress',
    name: 'WordPress',
    category: 'cms',
    description: 'Self-hosted or WordPress.com Business',
    getSteps: (botKey, env) => [
        {
            title: 'Option A: Use a plugin (easiest)',
            description:
                'Install the "Insert Headers and Footers" plugin (by WPCode). Go to Code Snippets → Header & Footer, paste the script in the "Footer" section, and click Save.',
            code: `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
            language: 'html',
        },
        {
            title: 'Option B: Add via functions.php',
            description:
                'If you prefer code, open your theme\'s functions.php file (Appearance → Theme File Editor → functions.php) and add:',
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
add_filter('script_loader_tag', 'oyechats_add_bot_key', 10, 2);`,
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
const shopify = {
    id: 'shopify',
    name: 'Shopify',
    category: 'cms',
    description: 'Shopify stores',
    getSteps: (botKey, env) => [
        {
            title: 'Open the theme code editor',
            description:
                'Go to Online Store → Themes → click the three dots (⋯) on your current theme → Edit code.',
            code: null,
        },
        {
            title: 'Edit theme.liquid',
            description:
                'In the Layout section, open theme.liquid. Paste the script just before the closing </body> tag.',
            code: `<!-- OyeChats Widget -->
<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>
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
const squarespace = {
    id: 'squarespace',
    name: 'Squarespace',
    category: 'cms',
    description: 'Squarespace websites',
    getSteps: (botKey, env) => [
        {
            title: 'Open Code Injection settings',
            description:
                'Go to Settings → Advanced → Code Injection.',
            code: null,
        },
        {
            title: 'Paste in the Footer section',
            description:
                'In the "Footer" field, paste the following script and click Save.',
            code: `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
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
const webflow = {
    id: 'webflow',
    name: 'Webflow',
    category: 'builder',
    description: 'Webflow sites and projects',
    getSteps: (botKey, env) => [
        {
            title: 'Open Custom Code settings',
            description:
                'Go to Site Settings → Custom Code tab.',
            code: null,
        },
        {
            title: 'Paste in the Footer Code section',
            description:
                'In the "Footer Code" field (Before </body> tag), paste the following and click Save Changes.',
            code: `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
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
const wix = {
    id: 'wix',
    name: 'Wix',
    category: 'builder',
    description: 'Wix websites',
    getSteps: (botKey, env) => [
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
const framer = {
    id: 'framer',
    name: 'Framer',
    category: 'builder',
    description: 'Framer sites',
    getSteps: (botKey, env) => [
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
const bubble = {
    id: 'bubble',
    name: 'Bubble',
    category: 'builder',
    description: 'Bubble.io apps',
    getSteps: (botKey, env) => [
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
const gtm = {
    id: 'gtm',
    name: 'Google Tag Manager',
    category: 'tool',
    description: 'Load via GTM container',
    getSteps: (botKey, env) => [
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
    ],
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** All supported platforms in display order. */
export const platforms = [
    html,
    nextjs,
    react,
    vue,
    angular,
    svelte,
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
export const categoryLabels = {
    generic: 'Generic',
    framework: 'Frameworks',
    cms: 'CMS',
    builder: 'No-Code Builders',
    tool: 'Tools',
};

/** Ordered list of categories for display. */
export const categoryOrder = ['generic', 'framework', 'cms', 'builder', 'tool'];
