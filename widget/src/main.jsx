import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from "@sentry/react";
import './index.css'
import App from './App.jsx'

// Initialize Sentry error tracking (opt-in via env var)
// Lightweight config — widget runs on customer sites, keep bundle impact low
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}

console.log(`[OyeChats] Widget v2.1.0 — build ${import.meta.env.VITE_BUILD_TIMESTAMP || 'dev'}`);

// Extract Bot Key or API Key from the script tag
// Priority: data-bot-key > data-api-key (backward compat)
let scriptTag = document.currentScript;
if (!scriptTag) {
  const scripts = document.getElementsByTagName('script');
  for (let i = 0; i < scripts.length; i++) {
    if (scripts[i].getAttribute('data-bot-key') || scripts[i].getAttribute('data-api-key')) {
      scriptTag = scripts[i];
      console.log('[OyeChats] Found script tag via key attribute search');
      break;
    }
  }
}

if (scriptTag) {
  // Try bot-key first (new multi-bot system)
  const botKey = scriptTag.getAttribute('data-bot-key');
  const apiKey = scriptTag.getAttribute('data-api-key');

  if (botKey) {
    window.OYECHATS_BOT_KEY = botKey;
    console.log('[OyeChats] Bot Key initialized');
  } else if (apiKey) {
    // Backward compatibility — old embed codes still work
    window.OYECHATS_API_KEY = apiKey;
    console.log('[OyeChats] API Key initialized (legacy)');
  } else {
    console.error('[OyeChats] Script tag found but no data-bot-key or data-api-key attribute');
  }
} else {
  console.error('[OyeChats] OyeChats script tag not detected. Integration may fail.');
}

// Find or create the root container for the widget
const CONTAINER_ID = 'oyechats-widget-root';
const RENDER_TARGET_ID = 'oyechats-shadow-inner';
const STYLE_LINK_SELECTOR = 'link[data-oyechats-style="1"]';

const getWidgetCssUrl = () => {
  const scriptSrc = scriptTag?.src;
  if (scriptSrc && /\.js(\?.*)?$/.test(scriptSrc)) {
    return scriptSrc.replace(/\.js(\?.*)?$/, '.css$1');
  }

  const scripts = document.getElementsByTagName('script');
  for (let i = scripts.length - 1; i >= 0; i--) {
    const src = scripts[i].src || '';
    if (src.includes('oyechats-widget') && /\.js(\?.*)?$/.test(src)) {
      return src.replace(/\.js(\?.*)?$/, '.css$1');
    }
  }

  return null;
};

const initWidget = () => {
  console.log('[OyeChats] Attempting to initialize widget container...');
  let container = document.getElementById(CONTAINER_ID);

  if (!container) {
    if (!document.body) {
      console.error('[OyeChats] document.body is not available. Retrying in 100ms...');
      setTimeout(initWidget, 100);
      return;
    }
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    document.body.appendChild(container);
    console.log('[OyeChats] Root container created and appended to body');
  } else {
    console.log('[OyeChats] Root container already exists');
  }

  if (container) {
    // Reuse existing shadow root when re-initialized to avoid attachShadow crashes.
    const shadow = container.shadowRoot || container.attachShadow({ mode: 'open' });

    // Inject widget CSS as a sibling stylesheet (CSP compatible).
    if (!shadow.querySelector(STYLE_LINK_SELECTOR)) {
      const cssUrl = getWidgetCssUrl();
      if (cssUrl) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = cssUrl;
        link.setAttribute('data-oyechats-style', '1');
        shadow.appendChild(link);
        console.log('[OyeChats] Shadow DOM stylesheet attached:', cssUrl);
      } else {
        console.warn('[OyeChats] Could not determine stylesheet URL for shadow root');
      }
    }

    // Create render target inside shadow root only once.
    let renderTarget = shadow.querySelector(`#${RENDER_TARGET_ID}`);
    if (!renderTarget) {
      renderTarget = document.createElement('div');
      renderTarget.id = RENDER_TARGET_ID;
      shadow.appendChild(renderTarget);
    }

    // Skip duplicate mounts when script executes more than once.
    if (renderTarget.dataset.oyechatsMounted === 'true' || renderTarget.hasChildNodes()) {
      renderTarget.dataset.oyechatsMounted = 'true';
      console.log('[OyeChats] Widget already mounted, skipping duplicate initialization');
      return;
    }

    renderTarget.dataset.oyechatsMounted = 'true';
    console.log('[OyeChats] Shadow DOM ready, starting React render');
    createRoot(renderTarget).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } else {
    console.error('[OyeChats] Failed to create or find container element.');
  }
};

// Start initialization
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWidget);
} else {
  initWidget();
}
