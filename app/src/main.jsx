import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from "@sentry/react";
import { isSessionExpired, clearAuthStorage } from './utils/authStorage'
import { isLocalHostname } from './utils/isLocalHostname'
import ErrorFallback from './components/ErrorFallback.jsx'
import './index.css'
import './design-system/tokens.css'
// Admin Platform 2.0 entry. The strangler-fig migration is complete for the
// primary surfaces - the legacy root (./App.jsx) and its dead pages/layouts
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
    // Errors + light tracing only. Session Replay, Profiling and structured
    // Logs are deliberately NOT enabled: we are on the Sentry free plan, where
    // exhausting any one of those quotas pauses ingestion for the whole
    // project — taking error reporting down with it. Do not add
    // replayIntegration / browserProfilingIntegration / enableLogs without a
    // paid plan behind them.
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.3,
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
