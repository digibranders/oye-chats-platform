/**
 * OyeChats admin dashboard — Service Worker.
 *
 * Sole purpose: receive Web Push events when no dashboard tab is open and
 * surface them as native OS notifications, then route the operator into the
 * waiting chat on click. We deliberately do NOT cache app shell assets —
 * that's a separate decision that would risk serving stale dashboard JS
 * after a deploy.
 *
 * Lifecycle:
 *   install   → skipWaiting so a freshly-deployed SW takes over immediately
 *   activate  → clients.claim so existing tabs get the new SW without reload
 *   push      → showNotification with replace-by-tag semantics
 *   click     → focus an existing tab if one matches the target, else open
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // Log every push for debugging — visible in chrome://serviceworker-internals
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

  const title = payload.title || 'OyeChats — new chat';
  const body = payload.body || 'A visitor needs help.';
  // Same tag → newer notification replaces older one on the device. Drives the
  // "claimed by Sarah" / "moved to offline message" follow-up semantics.
  const tag = payload.tag || `oye:${payload.session_id || Date.now()}`;

  // Asymmetric urgency:
  //   - handoff_request — transient, no requireInteraction. macOS Chrome
  //     silently drops requireInteraction banners on Focus/Banner-style
  //     configs, and we WANT the initial alert to be loud and short so the
  //     operator notices it inside the visitor's ~30s wait window.
  //   - handoff_moved_to_offline / handoff_expired — persistent
  //     (requireInteraction=true). These fire AFTER the visitor's wait
  //     elapsed; they're the late-operator catcher and need to stay visible
  //     until the operator manually engages with them. Even if macOS
  //     silently hides the banner, the notification persists in Notification
  //     Centre — which is the correct UX for "you missed a chat, here's
  //     what's actionable now."
  const persistent =
    payload.type === 'handoff_moved_to_offline' || payload.type === 'handoff_expired';

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
          // Backend-supplied deep-link target — used by notificationclick
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
  // paths are honoured — guards against a poisoned payload trying to
  // open an external URL with the operator's session.
  const backendUrl = typeof data.click_url === 'string' ? data.click_url : '';
  const safeBackendUrl =
    backendUrl.startsWith('/') && !backendUrl.startsWith('//') ? backendUrl : '';
  const targetPath =
    safeBackendUrl ||
    (sessionId ? `/support?session=${encodeURIComponent(sessionId)}` : '/support');
  // Same origin as the SW registration — the admin dashboard.
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
            // without a hard reload — covers both "open chat" and "open
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
      // No existing tab — open one at the target URL directly.
      await self.clients.openWindow(targetUrl);
    })()
  );
});
