import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from "@sentry/react";
import { isSessionExpired, clearAuthStorage } from './utils/authStorage'
import { isLocalHostname } from './utils/isLocalHostname'
import ErrorFallback from './components/ErrorFallback.jsx'
import './index.css'
import './design-system/tokens.css'
// Admin Platform 2.0 entry. The strangler-fig migration is complete for the
// primary surfaces — the legacy root (./App.jsx) and its dead pages/layouts
// have been removed; reused legacy modules (services, contexts, utils) remain.
// The new root (./app/App) owns theming, so the old ThemeProvider wrapper is
// gone from here.
import App from './app/App'

// Enforce the absolute session expiry once, before the app reads auth state.
// Auth lives in localStorage (shared across tabs); "Remember me" controls how
// long it lasts. An expired session is wiped here so ProtectedLayout treats the
// user as logged out and redirects to /login on this load.
if (isSessionExpired()) {
  clearAuthStorage();
}

// Initialize Sentry error tracking (opt-in via env var, production only).
// Dev builds and anything served from localhost are excluded: the DSN lives in
// developers' local .env too, and without this gate every hot-reload crash and
// half-finished refactor raises a Sentry alert that buries real production
// issues. `PROD` alone is not enough — `vite preview` serves a PROD build from
// localhost.
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;
if (SENTRY_DSN && import.meta.env.PROD && !isLocalHostname(window.location.hostname)) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    integrations: [
      Sentry.browserTracingIntegration(),
      // Session Replay. `maskAllText`/`blockAllMedia` are the SDK defaults but
      // are set explicitly here: this dashboard renders customer lead data,
      // billing details and conversation transcripts, none of which may leave
      // the browser in a replay.
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
      Sentry.browserProfilingIntegration(),
      // Structured logs. Only warn/error — console.log noise is not worth the
      // quota and is what breadcrumbs already cover.
      Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
    ],
    tracesSampleRate: 0.3,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    // UI Profiling (v2): sample whole sessions, then profile for the duration
    // of each sampled trace. Requires `tracesSampleRate` above AND the
    // `Document-Policy: js-profiling` response header (set in vercel.json) —
    // without that header the browser refuses to expose the JS profiler.
    profileSessionSampleRate: 0.1,
    profileLifecycle: 'trace',
    enableLogs: true,
    sendDefaultPii: false,
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
