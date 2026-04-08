import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

const MeetingBooking = ({ calendlyUrl, sessionId, onBooked, onDismiss }) => {
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        const handleMessage = (event) => {
            // Only accept messages from Calendly's origin to prevent spoofed events
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
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [calendlyUrl, onBooked, sessionId]);

    if (!calendlyUrl) return null;

    return (
        <div className="mx-3 mb-3 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-800">Book a Meeting</h3>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setCollapsed((prev) => !prev)}
                        className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500"
                        aria-label={collapsed ? 'Expand booking widget' : 'Collapse booking widget'}
                    >
                        {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                    </button>
                    <button
                        onClick={onDismiss}
                        className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500"
                        aria-label="Dismiss booking widget"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>
            {!collapsed && (
                <iframe
                    title="Calendly Booking"
                    src={calendlyUrl}
                    width="100%"
                    height="350"
                    frameBorder="0"
                    sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-top-navigation-by-user-activation"
                />
            )}
        </div>
    );
};

export default MeetingBooking;
