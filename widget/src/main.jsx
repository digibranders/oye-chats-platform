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

console.log('[OyeChat] Widget script initializing...');

// ── CSS Auto-Injection ──────────────────────────────────────────────
// In production the build outputs oyechat-widget.js + oyechat-widget.css as
// separate files.  Third-party sites only embed the JS via <script>, so
// the CSS never loads and the widget is invisible.
// Fix: detect the script's own URL and load the sibling CSS file.
// Skip in dev mode — Vite HMR already handles CSS injection.
if (import.meta.env.PROD) {
  try {
    const selfScript =
      document.currentScript ||
      (() => {
        const all = document.getElementsByTagName('script');
        for (let i = all.length - 1; i >= 0; i--) {
          if (all[i].src && all[i].src.includes('oyechat-widget')) return all[i];
        }
        return null;
      })();

    if (selfScript && selfScript.src) {
      const cssUrl = selfScript.src.replace(/\.js(\?.*)?$/, '.css');
      if (!document.querySelector(`link[href="${cssUrl}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = cssUrl;
        document.head.appendChild(link);
        console.log('[OyeChat] CSS auto-injected:', cssUrl);
      }
    } else {
      console.warn('[OyeChat] Could not determine script URL for CSS injection');
    }
  } catch (e) {
    console.warn('[OyeChat] CSS auto-injection failed:', e);
  }
}

// Extract Bot Key or API Key from the script tag
// Priority: data-bot-key > data-api-key (backward compat)
let scriptTag = document.currentScript;
if (!scriptTag) {
  const scripts = document.getElementsByTagName('script');
  for (let i = 0; i < scripts.length; i++) {
    if (scripts[i].getAttribute('data-bot-key') || scripts[i].getAttribute('data-api-key')) {
      scriptTag = scripts[i];
      console.log('[OyeChat] Found script tag via key attribute search');
      break;
    }
  }
}

if (scriptTag) {
  // Try bot-key first (new multi-bot system)
  const botKey = scriptTag.getAttribute('data-bot-key');
  const apiKey = scriptTag.getAttribute('data-api-key');

  if (botKey) {
    window.OYECHAT_BOT_KEY = botKey;
    console.log('[OyeChat] Bot Key initialized:', botKey);
  } else if (apiKey) {
    // Backward compatibility — old embed codes still work
    window.OYECHAT_API_KEY = apiKey;
    console.log('[OyeChat] API Key initialized (legacy):', apiKey);
  } else {
    console.error('[OyeChat] Script tag found but no data-bot-key or data-api-key attribute');
  }
} else {
  console.error('[OyeChat] OyeChat script tag not detected. Integration may fail.');
}

// Find or create the root container for the widget
const CONTAINER_ID = 'oyechat-widget-root';

const initWidget = () => {
  console.log('[OyeChat] Attempting to initialize widget container...');
  let container = document.getElementById(CONTAINER_ID);

  if (!container) {
    if (!document.body) {
      console.error('[OyeChat] document.body is not available. Retrying in 100ms...');
      setTimeout(initWidget, 100);
      return;
    }
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    document.body.appendChild(container);
    console.log('[OyeChat] Root container created and appended to body');
  } else {
    console.log('[OyeChat] Root container already exists');
  }

  if (container) {
    console.log('[OyeChat] Starting React render on container:', container);
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } else {
    console.error('[OyeChat] Failed to create or find container element.');
  }
};

// Start initialization
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWidget);
} else {
  initWidget();
}



