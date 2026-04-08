import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from "@sentry/react";
import cssText from './index.css?inline'
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
    // Shadow DOM for complete CSS isolation from host page styles
    const shadow = container.attachShadow({ mode: 'open' });

    // Inject widget CSS into shadow root (bundled inline by Vite)
    const style = document.createElement('style');
    style.textContent = cssText;
    shadow.appendChild(style);

    // Create render target inside shadow root
    const renderTarget = document.createElement('div');
    renderTarget.id = 'oyechats-shadow-inner';
    shadow.appendChild(renderTarget);

    console.log('[OyeChats] Shadow DOM created, starting React render');
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
