import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from "@sentry/react";
import { t as translateNow } from './i18n/i18n';
import { isSessionExpired, clearAuthStorage } from './utils/authStorage'
import { isLocalHostname } from './utils/isLocalHostname'
import {
  isImpersonating,
  startImpersonationSession,
  takeImpersonationTokenFromUrl,
} from './utils/impersonation'
import { redeemImpersonation } from './services/api'
import { BootCrashScreen } from './app/errors/AppCrashScreen'
import { ImpersonationNotice } from './shell/ImpersonationNotice'
import './index.css'
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
// issues. `PROD` alone is not enough. `vite preview` serves a PROD build from
// localhost.
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;
if (SENTRY_DSN && import.meta.env.PROD && !isLocalHostname(window.location.hostname)) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    // Errors + light tracing only. Session Replay, Profiling and structured
    // Logs are deliberately NOT enabled: we are on the Sentry free plan, where
    // exhausting any one of those quotas pauses ingestion for the whole
    // project. Taking error reporting down with it. Do not add
    // replayIntegration / browserProfilingIntegration / enableLogs without a
    // paid plan behind them.
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.3,
    sendDefaultPii: false,
  });
}

const container = document.getElementById('root');
// Authored directly in index.html, so a null here means the HTML shell itself
// failed to load. Throwing names the fault instead of surfacing later as a
// null dereference from inside React.
if (!container) throw new Error('Root element #root not found in index.html');

const root = createRoot(container);

function renderApp() {
  root.render(
    <StrictMode>
      <Sentry.ErrorBoundary fallback={<BootCrashScreen />}>
        <App />
      </Sentry.ErrorBoundary>
    </StrictMode>,
  );
}

function renderImpersonationNotice(title: string, message: string, busy = false) {
  root.render(
    <StrictMode>
      <ImpersonationNotice title={title} message={message} busy={busy} />
    </StrictMode>,
  );
}

if (impersonationHandoffToken) {
  renderImpersonationNotice(
    translateNow('app.startingSupportSession') || 'Starting support session',
    translateNow('app.verifyingImpersonationLink') || 'Verifying this impersonation link…',
    true,
  );
  redeemImpersonation(impersonationHandoffToken)
    .then((profile) => {
      // sessionStorage, never the shared localStorage bundle - see
      // utils/impersonation.ts for why the two stores must not mix.
      startImpersonationSession(impersonationHandoffToken, profile);
      renderApp();
    })
    .catch((error) => {
      // A dead end on purpose: falling through to the app would land the
      // super-admin on /login, where the only way forward is the customer's
      // own password.
      // The rejection comes from the JS API client, so its shape is not yet
      // proven to the compiler. Read defensively.
      const apiErr = error as { status?: number; message?: string } | null;
      const rejectedByServer = apiErr?.status === 401 || apiErr?.status === 404;
      renderImpersonationNotice(
        translateNow('app.impersonationLinkRejected') || 'Impersonation link not accepted',
        rejectedByServer
          ? translateNow('app.impersonationLinkExpired') || 'This impersonation link has expired or been revoked.'
          : apiErr?.message || translateNow('app.impersonationCouldNotStart') || 'This impersonation session could not be started.',
      );
    });
} else {
  renderApp();
}
