import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';

/**
 * Validate a meeting URL based on the provider. Only allows HTTPS URLs
 * pointing to the expected domain to prevent arbitrary iframe loads.
 */
const ALLOWED_HOSTS = {
    calendly: (host) => host === 'calendly.com' || host.endsWith('.calendly.com'),
    zcal: (host) => host === 'zcal.co' || host.endsWith('.zcal.co'),
    // Cal.com org accounts serve booking pages from subdomains (i.cal.com etc.)
    calcom: (host) => host === 'cal.com' || host.endsWith('.cal.com'),
};

const PROVIDER_LABELS = {
    calendly: 'Calendly',
    zcal: 'Zcal',
    calcom: 'Cal.com',
};

const validateMeetingUrl = (url, provider = 'calendly') => {
    if (!url || typeof url !== 'string') return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return null;
        const host = parsed.hostname.toLowerCase();
        const checker = ALLOWED_HOSTS[provider] || ALLOWED_HOSTS.calendly;
        if (!checker(host)) return null;
        return url;
    } catch {
        return null;
    }
};

/**
 * Build the iframe src from a validated URL. Calendly only dispatches
 * postMessage events (including ``calendly.event_scheduled``, which drives our
 * auto-close) when the embed URL carries ``embed_domain`` and
 * ``embed_type=Inline`` — its own widget.js appends these, so a bare URL never
 * fires the event and the panel would stay open after a successful booking.
 * ``hide_gdpr_banner`` also suppresses Calendly's in-frame cookie banner, which
 * otherwise crowds the small widget panel. Other providers load unchanged.
 */
const buildIframeSrc = (safeUrl, provider) => {
    if (provider !== 'calendly') return safeUrl;
    try {
        const url = new URL(safeUrl);
        if (!url.searchParams.has('embed_domain')) {
            url.searchParams.set('embed_domain', window.location.hostname);
        }
        if (!url.searchParams.has('embed_type')) {
            url.searchParams.set('embed_type', 'Inline');
        }
        if (!url.searchParams.has('hide_gdpr_banner')) {
            url.searchParams.set('hide_gdpr_banner', '1');
        }
        return url.toString();
    } catch {
        return safeUrl;
    }
};

const IFRAME_LOAD_TIMEOUT_MS = 15000;

const MeetingBooking = ({ calendlyUrl, sessionId, onBooked, onDismiss, provider = 'calendly' }) => {
    const safeUrl = validateMeetingUrl(calendlyUrl, provider);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [cspBlocked, setCspBlocked] = useState(false);
    const iframeRef = useRef(null);

    useEffect(() => {
        if (!safeUrl) return;
        const timer = setTimeout(() => {
            setLoading((prev) => {
                if (prev) setError(true);
                return prev;
            });
        }, IFRAME_LOAD_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [safeUrl]);

    useEffect(() => {
        if (!safeUrl) return undefined;
        // When the HOST page's CSP has a frame-src that doesn't allow the
        // booking provider, the browser blocks the iframe and renders its own
        // "content blocked" page — the iframe's load/error events tell us
        // nothing. The document does receive a securitypolicyviolation event,
        // so switch to our error state with the open-in-new-tab escape hatch
        // (new tabs aren't governed by the host page's frame-src).
        const handleViolation = (event) => {
            if (!event.violatedDirective || !event.violatedDirective.startsWith('frame-src')) return;
            try {
                // blockedURI may be the full URL or just the origin.
                if (new URL(event.blockedURI).origin !== new URL(safeUrl).origin) return;
            } catch {
                return;
            }
            setLoading(false);
            setError(true);
            setCspBlocked(true);
        };
        document.addEventListener('securitypolicyviolation', handleViolation);
        return () => document.removeEventListener('securitypolicyviolation', handleViolation);
    }, [safeUrl]);

    const handleRetry = () => {
        setLoading(true);
        setError(false);
    };

    const handleManualConfirm = async () => {
        if (confirming) return;
        setConfirming(true);
        try {
            await onBooked?.({
                session_id: sessionId,
                booking_url: calendlyUrl,
                attendee_email: null,
                meeting_time: null,
            });
        } finally {
            setConfirming(false);
        }
    };

    useEffect(() => {
        const handleMessage = (event) => {
            // Bind the handler to OUR iframe, not just the provider's origin
            // (audit F42). The host page can embed the same provider elsewhere
            // (its own Calendly popup, another widget) — those iframes share
            // event.origin, and without the source check their booking events
            // would flip this session to a false "meeting booked" state.
            if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
            if (provider === 'calendly') {
                if (event.origin !== 'https://calendly.com') return;
                const data = event?.data;
                if (!data || typeof data !== 'object') return;
                if (data.event === 'calendly.event_scheduled') {
                    onBooked?.({
                        session_id: sessionId,
                        booking_url: data.payload?.event?.uri || calendlyUrl,
                        attendee_email: data.payload?.invitee?.email || null,
                        meeting_time: data.payload?.event?.start_time || null,
                    });
                }
            } else if (provider === 'calcom') {
                // Cal.com emits embed events even from a bare booking-page
                // iframe, wrapped as {originator: "CAL", type, data}. Org
                // accounts post from their own subdomain (i.cal.com etc.),
                // so match any *.cal.com origin.
                let host;
                try {
                    host = new URL(event.origin).hostname.toLowerCase();
                } catch {
                    return;
                }
                if (host !== 'cal.com' && !host.endsWith('.cal.com')) return;
                const data = event?.data;
                if (!data || typeof data !== 'object' || data.originator !== 'CAL') return;
                if (data.type === 'bookingSuccessful' || data.type === 'bookingSuccessfulV2') {
                    const payload = data.data || {};
                    const booking = payload.booking || {};
                    const uid = booking.uid || payload.uid || null;
                    onBooked?.({
                        session_id: sessionId,
                        booking_url: uid ? `https://cal.com/booking/${uid}` : calendlyUrl,
                        attendee_email:
                            booking.attendees?.[0]?.email || payload.attendees?.[0]?.email || null,
                        meeting_time: payload.date || payload.startTime || booking.startTime || null,
                    });
                }
            } else if (provider === 'zcal') {
                if (event.origin !== 'https://zcal.co') return;
                const data = event?.data;
                if (!data || typeof data !== 'object') return;
                // Zcal's postMessage API is not publicly documented.
                // We check known patterns; if none match, any message from
                // zcal.co origin with a truthy "booked"/"confirmed" signal
                // is treated as a successful booking.
                const isBooking =
                    data.type === 'zcal:booking_confirmed' ||
                    data.event === 'zcal.booking_confirmed' ||
                    data.event === 'booking.confirmed' ||
                    data.booked === true;
                if (isBooking) {
                    onBooked?.({
                        session_id: sessionId,
                        booking_url: data.payload?.booking_url || data.url || calendlyUrl,
                        attendee_email: data.payload?.email || data.email || null,
                        meeting_time: data.payload?.start_time || data.start_time || null,
                    });
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [calendlyUrl, onBooked, sessionId, provider]);

    if (!safeUrl) return null;

    return (
        <div
            className="absolute inset-0 z-40 flex flex-col"
            style={{ animation: 'fadeUp 0.3s ease-out' }}
        >
            {/* Tap-to-dismiss backdrop (top ~15%) */}
            <div className="flex-[0.15]" onClick={onDismiss} />

            {/* Modal panel — slides up from bottom, ~85% of widget */}
            <div className="flex-[0.85] bg-white rounded-t-2xl border-t border-gray-200 shadow-xl flex flex-col overflow-hidden">
                <div className="px-4 py-3 flex items-center justify-between border-b border-gray-100 shrink-0">
                    <h3 className="text-sm font-semibold text-gray-800">Book a Meeting</h3>
                    <div className="flex items-center gap-1">
                        <a
                            href={safeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500"
                            aria-label="Open booking page in new tab"
                            title="Open in new tab"
                        >
                            <ExternalLink className="w-4 h-4" />
                        </a>
                        <button
                            onClick={onDismiss}
                            className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500"
                            aria-label="Close booking widget"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>
                <div className="flex-1 overflow-hidden relative">
                    {loading && !error && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white">
                            <div className="w-8 h-8 border-4 border-gray-200 border-t-blue-500 rounded-full animate-spin" />
                        </div>
                    )}
                    {error && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white gap-3 px-6 text-center">
                            <p className="text-sm text-gray-600">
                                {cspBlocked
                                    ? "This website's security settings don't allow embedded booking. Please open it in a new tab."
                                    : 'Could not load the booking page. An ad or privacy blocker may be preventing it.'}
                            </p>
                            <div className="flex items-center gap-2">
                                {/* Retry is pointless for a CSP block — the policy won't change. */}
                                {!cspBlocked && (
                                    <button
                                        onClick={handleRetry}
                                        className="px-4 py-2 text-sm font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600"
                                    >
                                        Try again
                                    </button>
                                )}
                                <a
                                    href={safeUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={
                                        cspBlocked
                                            ? 'px-4 py-2 text-sm font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600'
                                            : 'px-4 py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50'
                                    }
                                >
                                    Open in new tab
                                </a>
                            </div>
                        </div>
                    )}
                    <iframe
                        ref={iframeRef}
                        key={error ? 'retry' : 'initial'}
                        title={`${PROVIDER_LABELS[provider] || 'Calendly'} Booking`}
                        src={buildIframeSrc(safeUrl, provider)}
                        width="100%"
                        height="100%"
                        frameBorder="0"
                        onLoad={() => setLoading(false)}
                        sandbox="allow-scripts allow-popups allow-forms allow-top-navigation-by-user-activation allow-same-origin"
                    />
                </div>
                {/* Manual finish bar — always available. Calendly auto-closes
                    the panel via its ``event_scheduled`` postMessage (see the
                    embed params in buildIframeSrc), but postMessage can be
                    stripped by ad/privacy blockers, Zcal's event API is
                    undocumented, and external-tab bookings never post back to
                    this frame. This button is the guaranteed way to confirm the
                    booking and close the panel in every one of those cases. On a
                    successful booking the parent unmounts this panel, so no
                    explicit hide is needed here. */}
                <div className="px-4 py-2.5 border-t border-gray-100 bg-white flex items-center justify-between gap-3 shrink-0">
                    <p className="text-xs text-gray-500">Finished booking your meeting?</p>
                    <button
                        onClick={handleManualConfirm}
                        disabled={confirming}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 disabled:opacity-60 shrink-0"
                    >
                        {confirming ? 'Confirming…' : 'Done'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default MeetingBooking;
