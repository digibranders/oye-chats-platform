import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from "@sentry/react";
import { isSessionExpired, clearAuthStorage } from './utils/authStorage'
import ErrorFallback from './components/ErrorFallback.jsx'
import './index.css'
import './design-system/tokens.css'
// Admin Platform 2.0 foundation entry. The legacy root remains on disk at
// ./App.jsx (with its pages) for the strangler-fig migration — surfaces are
// ported into the new shell one at a time, then the legacy files are deleted.
// The new root (./app/App) owns theming, so the old ThemeProvider wrapper is
// gone from here.
import App from './app/App'

// Enforce the absolute session expiry once, before the app reads auth state.
// Auth lives in localStorage (shared across tabs); "Remember me" controls how
// long it lasts. An expired session is wiped here so ProtectedRoute treats the
// user as logged out and routes to /login on this load.
if (isSessionExpired()) {
  clearAuthStorage();
}

// Initialize Sentry error tracking (opt-in via env var)
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration(),
    ],
    tracesSampleRate: 0.3,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
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
