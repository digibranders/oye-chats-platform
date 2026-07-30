/**
 * OyeChats admin dashboard - Service Worker.
 *
 * Two jobs, deliberately separate:
 *   1. Web Push: receive push events when no tab is open, surface as OS
 *      notifications, and route the operator into the right chat on click.
 *   2. Offline shell: precache built app assets under a version keyed to the
 *      current deploy, and fall back to a cached shell / offline page only
 *      when the network truly fails. Never serve stale JS while online.
 *
 * The two sentinels below are rewritten by plugins/vite-plugin-oyechats-pwa.js
 * during `vite build`. In dev they remain literal - BUILD_ID starts with '__',
 * IS_BUILT is false, and the offline-shell path becomes a passthrough. This
 * keeps HMR clean and prevents a dev laptop from precaching missing assets.
 */

// Rewritten to a 12-char hex hash at build time.
const BUILD_ID = '__OYECHATS_BUILD_ID__';
// Rewritten to a JSON array of URLs at build time.
const PRECACHE_ASSETS = /* @__OYECHATS_PRECACHE__ */ [];
const IS_BUILT = !BUILD_ID.startsWith('__');

const CACHE_PREFIX = 'oyechats-shell-v';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const OFFLINE_URL = '/offline.html';
// Wait this long for the network on navigation before falling back to cache.
// Long enough to ride out mobile-tower jitter, short enough that a truly dead
// link degrades before the user gives up.
const NAVIGATION_NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  if (IS_BUILT && PRECACHE_ASSETS.length > 0) {
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) =>
        // { cache: 'reload' } bypasses the HTTP cache - critical for a fresh
        // deploy so we don't precache the previous version's index.html by
        // accident when the CDN edge is still warm on the old response.
        cache.addAll(PRECACHE_ASSETS.map((url) => new Request(url, { cache: 'reload' }))),
      ),
    );
  }
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (IS_BUILT) {
        const names = await caches.keys();
        await Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        );
      }
      await self.clients.claim();
    })(),
  );
});

/**
 * Navigation-request strategy: network-first with a bounded timeout, cached
 * shell as fallback, offline.html as the last resort.
 *
 * The controlling invariant is that an online user MUST see the current
 * deploy - the previous author explicitly refused to precache the shell for
 * fear of stale JS. Network-first honours that: we only reach for cache when
 * the network genuinely fails or is slower than the visitor's patience.
 */
async function handleNavigation(request) {
  if (!IS_BUILT) return fetch(request);

  const cache = await caches.open(CACHE_NAME);

  try {
    const networkResponse = await Promise.race([
      fetch(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('nav-timeout')), NAVIGATION_NETWORK_TIMEOUT_MS),
      ),
    ]);
    return networkResponse;
  } catch {
    const cachedIndex = await cache.match('/index.html');
    if (cachedIndex) return cachedIndex;
    const cachedOffline = await cache.match(OFFLINE_URL);
    if (cachedOffline) return cachedOffline;
    // Absolute last resort - synthesise a minimal offline page inline. Reached
    // only if the SW installed but somehow neither /index.html nor
    // /offline.html made it into the cache.
    return new Response(
      '<!doctype html><meta charset=utf-8><title>Offline</title><p>OyeChats is offline.</p>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 },
    );
  }
}

/**
 * Static-asset strategy: cache-first for anything in our versioned precache
 * (build-hashed JS/CSS + icons/manifest). Everything else - API calls, WS
 * upgrades, third-party - passes through untouched.
 */
async function handleAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only cache successful, opaque-safe responses that are already in our
  // precache list - never opportunistically balloon the cache with new URLs.
  if (response && response.ok && response.type === 'basic') {
    const url = new URL(request.url);
    if (url.origin === self.location.origin && PRECACHE_ASSETS.includes(url.pathname)) {
      cache.put(request, response.clone()).catch(() => {});
    }
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle same-origin navigations + our own precache list. API calls,
  // WebSocket upgrades, Sentry, and third-party assets all pass through.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (!IS_BUILT) return;

  if (PRECACHE_ASSETS.includes(url.pathname)) {
    event.respondWith(handleAsset(request));
  }
});

// --- Web Push (unchanged behaviour) ------------------------------------------

self.addEventListener('push', (event) => {
  // Log every push for debugging - visible in chrome://serviceworker-internals
  // and the SW's "inspect" DevTools window. Cheap insurance; helps diagnose
  // "notification didn't appear" reports without instrumentation per call.
  console.log('[OyeChats SW] push received, has data:', !!event.data);

  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch (err) {
    console.warn('[OyeChats SW] push payload parse failed:', err);
    return;
  }
  console.log('[OyeChats SW] payload:', payload);

  const title = payload.title || 'OyeChats - new chat';
  const body = payload.body || 'A visitor needs help.';
  // Same tag → newer notification replaces older one on the device. Drives the
  // "claimed by Sarah" / "moved to offline message" follow-up semantics.
  const tag = payload.tag || `oye:${payload.session_id || Date.now()}`;

  // Asymmetric urgency:
  //   - handoff_request - transient, no requireInteraction. macOS Chrome
  //     silently drops requireInteraction banners on Focus/Banner-style
  //     configs, and we WANT the initial alert to be loud and short so the
  //     operator notices it inside the visitor's ~30s wait window.
  //   - handoff_moved_to_offline / handoff_expired - persistent
  //     (requireInteraction=true). These fire AFTER the visitor's wait
  //     elapsed; they're the late-operator catcher and need to stay visible
  //     until the operator manually engages with them. Even if macOS
  //     silently hides the banner, the notification persists in Notification
  //     Centre - which is the correct UX for "you missed a chat, here's
  //     what's actionable now."
  //   - chat_transferred / offline_message_received - persistent for the
  //     same reason: they're catchers for events the operator wasn't
  //     watching for.
  const persistent =
    payload.type === 'handoff_moved_to_offline' ||
    payload.type === 'handoff_expired' ||
    payload.type === 'chat_transferred' ||
    payload.type === 'offline_message_received';

  event.waitUntil(
    self.registration
      .showNotification(title, {
        body,
        tag,
        renotify: payload.type === 'handoff_request',
        requireInteraction: persistent,
        icon: '/oye_new_final.png',
        badge: '/favicon-192.png',
        data: {
          session_id: payload.session_id || null,
          type: payload.type || 'handoff_request',
          bot_id: payload.bot_id || null,
          // Backend-supplied deep-link target - used by notificationclick
          // below. Always a relative path; the click handler validates it.
          click_url: payload.click_url || null,
          offline_message_id: payload.offline_message_id || null,
        },
      })
      .then(() => console.log('[OyeChats SW] showNotification resolved for tag', tag))
      .catch((err) => console.error('[OyeChats SW] showNotification failed:', err))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const sessionId = data.session_id;

  // Pick the target path. Backend-supplied click_url wins (used by the
  // escalation cleanup to route a late operator to /support?tab=messages
  // when the visitor left an offline message, or to /support when they
  // just walked away). Falls back to the original "open this chat" deep
  // link for handoff_request notifications. Only relative same-origin
  // paths are honoured - guards against a poisoned payload trying to
  // open an external URL with the operator's session.
  const backendUrl = typeof data.click_url === 'string' ? data.click_url : '';
  const safeBackendUrl =
    backendUrl.startsWith('/') && !backendUrl.startsWith('//') ? backendUrl : '';
  const targetPath =
    safeBackendUrl ||
    (sessionId ? `/support?session=${encodeURIComponent(sessionId)}` : '/support');
  // Same origin as the SW registration - the admin dashboard.
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Prefer focusing an existing dashboard tab so we don't pile up
      // duplicate windows for an operator who already has the app open.
      for (const client of allClients) {
        if (client.url.startsWith(self.location.origin)) {
          try {
            await client.focus();
            // Tell the live tab where to navigate. Includes the resolved
            // target path so the in-app listener can route via React Router
            // without a hard reload - covers both "open chat" and "open
            // offline message" cases.
            client.postMessage({
              type: 'oyechats:push-navigate',
              session_id: sessionId,
              push_type: data.type,
              target_path: targetPath,
              offline_message_id: data.offline_message_id || null,
            });
            return;
          } catch {
            // fall through to opening a new tab
          }
        }
      }
      // No existing tab - open one at the target URL directly.
      await self.clients.openWindow(targetUrl);
    })()
  );
});
