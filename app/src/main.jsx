import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from "@sentry/react";
import { isSessionExpired, clearAuthStorage } from './utils/authStorage'
import { isLocalHostname } from './utils/isLocalHostname'
import {
  isImpersonating,
  startImpersonationSession,
  takeImpersonationTokenFromUrl,
} from './utils/impersonation'
import { redeemImpersonation } from './services/api'
import ErrorFallback from './components/ErrorFallback.jsx'
import ImpersonationNotice from './components/ImpersonationNotice.jsx'
import './index.css'
import './design-system/tokens.css'
// Admin Platform 2.0 entry. The strangler-fig migration is complete for the
// primary surfaces - the legacy root (./App.jsx) and its dead pages/layouts
// have been removed; reused legacy modules (services, contexts, utils) remain.
// The new root (./app/App) owns theming, so the old ThemeProvider wrapper is
// gone from here.
import App from './app/App'

// ── Impersonation hand-off ─────────────────────────────────────────────────
// FIRST statement of the bootstrap, ahead of the session-expiry guard and of
// every network call in the app.
//
// SECURITY: `takeImpersonationTokenFromUrl` strips `?impersonation=` via
// history.replaceState in the same synchronous step in which it reads it. The
// raw value is a live credential; leaving it in the address bar for even one
// request leaks it into browser history, into the `Referer` header of every
// outbound request the page makes, and into every access log in front of this
// app. The ordering is the mitigation - nothing below may run before it.
const impersonationHandoffToken = takeImpersonationTokenFromUrl();

// Enforce the absolute session expiry once, before the app reads auth state.
// Auth lives in localStorage (shared across tabs); "Remember me" controls how
// long it lasts. An expired session is wiped here so ProtectedLayout treats the
// user as logged out and redirects to /login on this load.
//
// Skipped entirely for an impersonated tab: that tab is authenticated by a
// tab-scoped token and has no business reading - let alone clearing - the
// SHARED localStorage bundle, which belongs to the super-admin's own session in
// every other tab of this browser.
if (!impersonationHandoffToken && !isImpersonating() && isSessionExpired()) {
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

const root = createRoot(document.getElementById('root'));

function renderApp() {
  root.render(
    <StrictMode>
      <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
        <App />
      </Sentry.ErrorBoundary>
    </StrictMode>,
  );
}

function renderImpersonationNotice(title, message, busy = false) {
  root.render(
    <StrictMode>
      <ImpersonationNotice title={title} message={message} busy={busy} />
    </StrictMode>,
  );
}

if (impersonationHandoffToken) {
  renderImpersonationNotice(
    'Starting support session',
    'Verifying this impersonation link…',
    true,
  );
  redeemImpersonation(impersonationHandoffToken)
    .then((profile) => {
      // sessionStorage, never the shared localStorage bundle - see
      // utils/impersonation.js for why the two stores must not mix.
      startImpersonationSession(impersonationHandoffToken, profile);
      renderApp();
    })
    .catch((error) => {
      // A dead end on purpose: falling through to the app would land the
      // super-admin on /login, where the only way forward is the customer's
      // own password.
      const rejectedByServer = error?.status === 401 || error?.status === 404;
      renderImpersonationNotice(
        'Impersonation link not accepted',
        rejectedByServer
          ? 'This impersonation link has expired or been revoked.'
          : error?.message || 'This impersonation session could not be started.',
      );
    });
} else {
  renderApp();
}
