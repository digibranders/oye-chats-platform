/**
 * PWA install prompt hook — a stable interface over the ``beforeinstallprompt``
 * dance that browsers make you do.
 *
 * The browser fires ``beforeinstallprompt`` when it decides the site is
 * installable and the user has crossed its engagement heuristic (visited
 * more than once, spent > N seconds, etc.). We ``preventDefault`` on it so
 * the browser doesn't render its own mini-infobar and stash the event; our
 * own UI then calls ``.prompt()`` at whatever moment makes sense.
 *
 * iOS Safari is the wildcard. It NEVER fires ``beforeinstallprompt`` — Apple
 * doesn't support programmatic install prompts. Instead, users add the site
 * to home screen manually via Share → Add to Home Screen. We surface ``isIOS``
 * so the Settings card can render a different "here's how" affordance for
 * that audience while the floating banner just hides itself.
 *
 * ``isInstalled`` is best-effort: ``display-mode: standalone`` is true when
 * the site was launched from the installed PWA; ``navigator.standalone`` is
 * the older iOS-only equivalent. If either is true we skip the install UI.
 */

import { useCallback, useEffect, useState } from 'react';

function detectStandalone() {
    if (typeof window === 'undefined') return false;
    try {
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
            return true;
        }
        // iOS < 16.4 exposes a non-standard ``standalone`` on navigator.
        // Modern iOS also honours ``matchMedia`` so this is a fallback.
        if (typeof window.navigator.standalone === 'boolean') {
            return window.navigator.standalone;
        }
    } catch {
        // matchMedia can throw in exotic embedded contexts — fall through.
    }
    return false;
}

function detectIOSSafari() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/.test(ua);
    if (!isIOS) return false;
    // Chrome / Firefox on iOS use ``CriOS`` / ``FxiOS`` respectively but still
    // fail to fire beforeinstallprompt (they inherit WebKit under the hood).
    // We treat any iOS browser as "manual add to home screen only" — the
    // guidance is the same regardless of which WebKit shell they used.
    return /Safari/.test(ua) || /CriOS/.test(ua) || /FxiOS/.test(ua);
}

/**
 * @returns {{
 *   canInstall: boolean,      // ``beforeinstallprompt`` has fired and not yet been consumed
 *   isInstalled: boolean,     // launched from installed PWA
 *   isIOS: boolean,           // iOS/iPadOS — needs manual add-to-home-screen instructions
 *   install: () => Promise<{ outcome: 'accepted' | 'dismissed' | 'unavailable' }>
 * }}
 */
export default function useInstallPrompt() {
    const [installEvent, setInstallEvent] = useState(null);
    const [isInstalled, setIsInstalled] = useState(detectStandalone);
    const isIOS = detectIOSSafari();

    useEffect(() => {
        function onBeforeInstall(event) {
            // Stop the browser from rendering its own mini-install-bar so we
            // can drive the timing (banner appears after N seconds of
            // engagement, matches design, etc.). The event is still usable
            // via ``prompt()`` for as long as we hold it.
            event.preventDefault();
            setInstallEvent(event);
        }
        function onInstalled() {
            setIsInstalled(true);
            setInstallEvent(null);
        }
        window.addEventListener('beforeinstallprompt', onBeforeInstall);
        window.addEventListener('appinstalled', onInstalled);
        return () => {
            window.removeEventListener('beforeinstallprompt', onBeforeInstall);
            window.removeEventListener('appinstalled', onInstalled);
        };
    }, []);

    const install = useCallback(async () => {
        if (!installEvent) return { outcome: 'unavailable' };
        try {
            installEvent.prompt();
            const choice = await installEvent.userChoice;
            // The event is single-use; after ``prompt()`` resolves the browser
            // won't re-fire ``beforeinstallprompt`` unless the user reloads.
            // Clear it so UI reflects "no longer installable this session".
            setInstallEvent(null);
            if (choice?.outcome === 'accepted') {
                setIsInstalled(true);
            }
            return { outcome: choice?.outcome === 'accepted' ? 'accepted' : 'dismissed' };
        } catch {
            setInstallEvent(null);
            return { outcome: 'unavailable' };
        }
    }, [installEvent]);

    return {
        canInstall: !!installEvent,
        isInstalled,
        isIOS,
        install,
    };
}
