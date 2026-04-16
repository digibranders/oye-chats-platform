import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';

/**
 * Validate a meeting URL based on the provider. Only allows HTTPS URLs
 * pointing to the expected domain to prevent arbitrary iframe loads.
 */
const ALLOWED_HOSTS = {
    calendly: (host) => host === 'calendly.com' || host.endsWith('.calendly.com'),
    zcal: (host) => host === 'zcal.co' || host.endsWith('.zcal.co'),
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

const IFRAME_LOAD_TIMEOUT_MS = 15000;

const MeetingBooking = ({ calendlyUrl, sessionId, onBooked, onDismiss, provider = 'calendly' }) => {
    const safeUrl = validateMeetingUrl(calendlyUrl, provider);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

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

    const handleRetry = () => {
        setLoading(true);
        setError(false);
    };

    useEffect(() => {
        const handleMessage = (event) => {
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
                    <button
                        onClick={onDismiss}
                        className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500"
                        aria-label="Close booking widget"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <div className="flex-1 overflow-hidden relative">
                    {loading && !error && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white">
                            <div className="w-8 h-8 border-4 border-gray-200 border-t-blue-500 rounded-full animate-spin" />
                        </div>
                    )}
                    {error && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white gap-3">
                            <p className="text-sm text-gray-600">Could not load booking page</p>
                            <button
                                onClick={handleRetry}
                                className="px-4 py-2 text-sm font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600"
                            >
                                Try again
                            </button>
                        </div>
                    )}
                    <iframe
                        key={error ? 'retry' : 'initial'}
                        title={`${provider === 'zcal' ? 'Zcal' : 'Calendly'} Booking`}
                        src={safeUrl}
                        width="100%"
                        height="100%"
                        frameBorder="0"
                        onLoad={() => setLoading(false)}
                        sandbox="allow-scripts allow-popups allow-forms allow-top-navigation-by-user-activation allow-same-origin"
                    />
                </div>
            </div>
        </div>
    );
};

export default MeetingBooking;
