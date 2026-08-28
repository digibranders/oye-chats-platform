import type { Page, WebSocketRoute } from '@playwright/test';

/**
 * A scripted backend for admin browser tests.
 *
 * The console needs a fair amount of state before it will render an inbox at
 * all - auth, a non-Free plan with the `live_chat` feature, a bot, and an
 * operator profile - so this module concentrates that setup in one place and
 * exposes only the handful of knobs a spec actually varies.
 *
 * Nothing here talks to a real API. `page.route` answers REST and
 * `page.routeWebSocket` plays the operator socket, so the specs are
 * deterministic and run without Postgres, Redis, or a server.
 */

export const API = 'http://oyechats-admin-e2e.test';
export const SESSION_ID = 'sess-e2e-1';
export const BOT_ID = 1;

/** Frames the operator socket can be driven with, from inside a spec. */
export interface OperatorSocket {
  /** How many times the console has connected. Reconnects increment this. */
  opened: number;
  /** The live route object for the most recent connection. */
  ws: WebSocketRoute | null;
  /** Everything the console has sent us, newest last. */
  sent: Array<Record<string, unknown>>;
  /** How many HTTP requests reached the mock origin. Guards a bad build. */
  apiHits: number;
  send(frame: Record<string, unknown>): void;
  /** Drop the socket so the console's reconnect logic runs. */
  drop(): void;
}

export interface HistoryMessage {
  id: number;
  role: 'user' | 'bot' | 'operator' | 'system';
  content: string;
  timestamp: string;
  source_language?: string | null;
  translations?: Record<string, { content?: string; status: 'ok' | 'failed' }> | null;
}

export interface MockOptions {
  /** Rows returned by `GET /chat/history`. */
  history?: HistoryMessage[];
  /** The reading operator's own working language. */
  operatorLocale?: string | null;
  /** Response for `POST /operators/translate`, or an error to simulate. */
  translate?: { ok: true; translated: string } | { ok: false; status: number };
  /** Whether the operator is on duty. `false` means no socket connects. */
  online?: boolean;
  /**
   * Overrides merged into the bot the API serves. Use it to reproduce a stored
   * configuration, such as a locale the widget has no dictionary for.
   */
  bot?: Partial<typeof BOT>;
}

const ENTITLEMENTS = {
  plan_slug: 'professional',
  plan_name: 'Professional',
  subscription_status: 'active',
  limits: { credits: 10000, bots: 3, operators: 5, leads: -1 },
  // `live_chat` gates the whole Live chat tab behind a FeatureGate.
  features: { live_chat: true, bant: false, branding_removable: true, integrations: 'all' },
  usage: {},
  is_free: false,
  topup_allowed: true,
};

/**
 * `GET /locales` (Phase 5A). The console resolves every language name through
 * this now, so without it the conversation badge renders "HI" instead of
 * "Hindi" and the language assertions below fail for the right reason.
 */
const LOCALES = {
  locales: [
    { code: 'en', locale: 'en-IN', name: 'English (India)', native_name: 'English (India)', direction: 'ltr', ui_translated: true },
    { code: 'hi', locale: 'hi-IN', name: 'Hindi (India)', native_name: 'हिन्दी', direction: 'ltr', ui_translated: true },
    // In the catalogue because the AI converses in them, but the widget ships
    // no UI dictionary, so the language picker must not offer them.
    { code: 'fr', locale: 'fr-FR', name: 'French (France)', native_name: 'Français (France)', direction: 'ltr', ui_translated: false },
    { code: 'ur', locale: 'ur-PK', name: 'Urdu (Pakistan)', native_name: 'اردو', direction: 'rtl', ui_translated: false },
  ],
  languages: { en: 'English', hi: 'Hindi', fr: 'French', ur: 'Urdu' },
};

const BOT = {
  id: BOT_ID,
  name: 'Acme Bot',
  bot_key: 'bot-acme',
  is_active: true,
  language_config: {
    enabled: true,
    default_locale: 'en-IN',
    supported_locales: ['en-IN', 'hi-IN'],
    operator_translation_enabled: true,
  },
};

/**
 * Wire up auth, REST and the operator socket, then return the socket handle.
 *
 * Call BEFORE `page.goto`.
 */
export async function mockBackend(page: Page, opts: MockOptions = {}): Promise<OperatorSocket> {
  const { history = [], operatorLocale = 'en-IN', translate, online = true, bot: botOverrides } = opts;
  const bot = { ...BOT, ...botOverrides };

  // Auth lives in localStorage and is read at app startup, so it has to be in
  // place before the bundle evaluates.
  //
  // The API ORIGIN is not settable here: `import.meta.env.VITE_API_URL` is
  // inlined at build time (services/api.js, useOperatorSocket.ts). The suite
  // therefore builds with `VITE_API_URL` pointed at `API` below - see the
  // `webServer.command` in playwright.config.ts, which builds its own bundle
  // into `dist-e2e/` on every run. If that env were missing the app would talk
  // to production instead of the mocks, so the origin assertions below fail
  // the run loudly rather than letting a spec pass against nothing.
  await page.addInitScript(
    ({ botId }) => {
      window.localStorage.setItem('admin_token', 'e2e-token');
      window.localStorage.setItem('auth_type', 'client');
      window.localStorage.setItem('admin_client_id', '1');
      window.localStorage.setItem('admin_name', 'Owner');
      window.localStorage.setItem('admin_is_verified', 'true');
      window.localStorage.setItem('onboarding_complete', 'true');
      window.localStorage.setItem('selected_bot_id', String(botId));
    },
    { botId: BOT_ID },
  );

  // Abort every EXTERNAL origin, registered first so all mocks below win.
  //
  // A regex that matches only foreign origins, deliberately: a `**/*` route
  // would also intercept the preview server's own module chunks, and routing
  // those through Playwright re-issues them in a way WebKit does not survive.
  // Same-origin requests are therefore never intercepted at all.
  //
  // This exists because WebKit leaves an unroutable request pending and blocks
  // the `load` event on it, so one stray URL timed out every navigation the
  // moment WebKit joined the matrix. Chromium failed those fast and hid it.
  await page.route(
    /^https?:\/\/(?!127\.0\.0\.1:4175|oyechats-admin-e2e\.test)/,
    (route) => route.abort(),
  );

  // Belt and braces. The app root used to inject the production chat widget
  // from cdn.oyechats.com, and WebKit blocks the `load` event on it, which
  // timed out every navigation in the suite. The injection is gone, so nothing
  // should request this host any more — but the catch-all above already aborts
  // it, and leaving the specific rule means a re-added embed fails loudly here
  // rather than quietly reaching a real CDN from the tests.
  await page.route('https://cdn.oyechats.com/**', (route) => route.abort());

  // ORDER MATTERS. Playwright tries the most recently registered matching route
  // FIRST, so the catch-all goes down first and the specific handlers below
  // take precedence. Registering it last silently swallows every mock.
  await page.route(`${API}/**`, (route) => route.fulfill({ json: {} }));

  await page.route(`${API}/auth/me/entitlements*`, (route) => route.fulfill({ json: ENTITLEMENTS }));
  await page.route(`${API}/auth/me*`, (route) =>
    route.fulfill({ json: { id: 1, name: 'Owner', email: 'owner@example.com', is_verified: true } }),
  );
  await page.route(`${API}/bots`, (route) => route.fulfill({ json: [bot] }));
  await page.route(`${API}/bots?*`, (route) => route.fulfill({ json: [bot] }));
  // `getClientSettings` reads a single bot. Without this it fell through to the
  // catch-all `{}`, so every agent page in these specs was rendering an empty
  // payload and its defaults rather than the bot above.
  // The `*` glob does not cross `/`, so sub-resources are unaffected.
  await page.route(`${API}/bots/*`, (route) => route.fulfill({ json: bot }));
  await page.route(`${API}/operators/me/status*`, (route) =>
    route.fulfill({ json: { operator_id: 1, operator_name: 'Asha', is_online: online } }),
  );
  await page.route(`${API}/operators/me/language`, (route) =>
    route.fulfill({
      json: {
        preferred_locale: operatorLocale,
        supported_languages: [],
        // What the operator's translation picker may offer (Phase 5A): the
        // locales this bot supports, not the whole platform catalogue.
        available_locales: bot.language_config.supported_locales,
      },
    }),
  );
  await page.route(`${API}/locales`, (route) => route.fulfill({ json: LOCALES }));
  await page.route(`${API}/canned-responses*`, (route) => route.fulfill({ json: [] }));
  await page.route(`${API}/offline-messages*`, (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );
  await page.route(`${API}/operators/qualified-bot-sessions*`, (route) => route.fulfill({ json: [] }));
  await page.route(`${API}/chat/history/**`, (route) => route.fulfill({ json: history }));
  await page.route(`${API}/operators/session/*/details`, (route) =>
    route.fulfill({
      json: {
        session_id: SESSION_ID,
        status: 'live',
        location: null,
        device: null,
        handoff_reason: null,
        created_at: '2026-08-24T10:00:00.000Z',
        last_active_at: '2026-08-24T10:05:00.000Z',
        message_count: history.length,
        bot_name: 'Acme Bot',
        department_name: null,
        operator_name: 'Asha',
        visitor_metadata: null,
        page_url: null,
        referrer: null,
        visitor_rating: null,
        language_code: 'hi',
        locale: 'hi-IN',
        bant: null,
        lead_info: null,
      },
    }),
  );

  if (translate) {
    await page.route(`${API}/operators/translate`, (route) =>
      translate.ok
        ? route.fulfill({
            json: { translated: translate.translated, target_locale: 'en', cached: false, status: 'ok' },
          })
        : route.fulfill({ status: translate.status, json: { detail: 'Translation unavailable' } }),
    );
  }

  const socket: OperatorSocket = {
    opened: 0,
    ws: null,
    sent: [],
    apiHits: 0,
    send(frame) {
      socket.ws?.send(JSON.stringify(frame));
    },
    drop() {
      socket.ws?.close();
    },
  };

  page.on('request', (request) => {
    if (request.url().startsWith(API)) socket.apiHits += 1;
  });

  await page.routeWebSocket(/\/ws\/operator/, (ws) => {
    // Acts as the server: no connectToServer(), so nothing leaves the browser.
    socket.opened += 1;
    socket.ws = ws;
    ws.onMessage((raw) => {
      try {
        socket.sent.push(JSON.parse(String(raw)));
      } catch {
        /* non-JSON frames are not part of this contract */
      }
    });
    // The console expects these three before it will show a conversation.
    ws.send(JSON.stringify({ type: 'init', operator_id: 1, operator_name: 'Asha', is_online: true }));
    ws.send(JSON.stringify({ type: 'queue_update', waiting: [], count: 0 }));
    ws.send(
      JSON.stringify({
        type: 'active_chats_restore',
        chats: [
          {
            session_id: SESSION_ID,
            visitor_name: 'Priya',
            reason: null,
            bot_id: BOT_ID,
            bot_name: 'Acme Bot',
            visitor_online: true,
          },
        ],
      }),
    );
  });

  return socket;
}

/**
 * Fail the run if the built bundle is not pointed at the mock origin.
 *
 * Without this a build made without `VITE_API_URL` sends every request to
 * production, the mocks never fire, and the specs fail with confusing
 * "element not found" errors instead of naming the real cause.
 */
export async function assertApiOrigin(socket: OperatorSocket): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (socket.apiHits === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (socket.apiHits === 0) {
    throw new Error(
      `The app made no request to ${API}. Rebuild with VITE_API_URL=${API} ` +
        '(npm run e2e does this) or the specs are testing against production.',
    );
  }
}

/**
 * The page-level twin of `assertApiOrigin`, for specs that never open a socket.
 *
 * Three of the four spec files exercise the language surfaces and had no origin
 * assertion at all, so a bundle built against the wrong host would have failed
 * them with "element not found" rather than naming the cause.
 */
export async function assertPageHitMock(page: Page): Promise<void> {
  let hits = 0;
  page.on('request', (req) => {
    if (req.url().startsWith(API)) hits += 1;
  });
  const deadline = Date.now() + 15_000;
  while (hits === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (hits === 0) {
    throw new Error(
      `The app made no request to ${API}. The Playwright webServer builds with ` +
        `VITE_API_URL=${API}; if that changed, the specs are testing against nothing.`,
    );
  }
}
