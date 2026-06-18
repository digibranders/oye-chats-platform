import React, { useEffect, useState } from 'react';
import { UserCheck, X } from 'lucide-react';
import { sanitizeColor } from '../services/sanitize';

/**
 * OperatorJoinedToast — non-blocking notification shown when an operator
 * becomes available WHILE the visitor is mid-way through the offline form.
 *
 * UX choice: we don't silently swap the offline form for a live chat
 * (jarring, loses what the user typed). Instead we offer an inline switch
 * via this toast. Visitor decides: keep typing the form, or jump to chat.
 *
 * Auto-dismisses after ``autoDismissMs`` (default 10s) — assumption is
 * "no action" means "I'm committed to the form, leave me alone".
 *
 * Props:
 *   - operatorName     : display name of the now-available operator
 *   - onSwitchToChat   : callback when visitor clicks "Switch to chat"
 *   - onDismiss        : callback when visitor dismisses (manual or auto)
 *   - primaryColor     : brand accent
 *   - autoDismissMs    : ms before auto-dismiss fires (default 10000)
 */
const OperatorJoinedToast = ({
    operatorName,
    onSwitchToChat,
    onDismiss,
    primaryColor: rawPrimary,
    autoDismissMs = 10_000,
}) => {
    const primaryColor = sanitizeColor(rawPrimary, '#3A0CA3');
    const [exiting, setExiting] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            // Trigger the exit animation, then fire dismiss after the
            // transition completes so the toast slides away cleanly.
            setExiting(true);
            setTimeout(() => onDismiss?.(), 250);
        }, autoDismissMs);
        return () => clearTimeout(timer);
    }, [autoDismissMs, onDismiss]);

    const handleManualDismiss = () => {
        setExiting(true);
        setTimeout(() => onDismiss?.(), 250);
    };

    return (
        <div
            className="mx-3 mb-2 rounded-xl border border-emerald-200 bg-emerald-50 shadow-sm overflow-hidden"
            style={{
                animation: exiting
                    ? 'slideUp 0.25s ease-in forwards'
                    : 'slideDown 0.3s ease-out',
            }}
        >
            <div className="p-3 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0">
                    <UserCheck className="w-4 h-4 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-semibold text-emerald-900 leading-tight">
                        {operatorName || 'An agent'} is available!
                    </p>
                    <p className="text-[11px] text-emerald-700 leading-tight mt-0.5">
                        Switch to live chat instead?
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onSwitchToChat}
                    className="px-3 py-1.5 rounded-lg text-white text-[12px] font-medium hover:opacity-90 transition-opacity flex-shrink-0"
                    style={{ backgroundColor: primaryColor }}
                >
                    Switch
                </button>
                <button
                    type="button"
                    onClick={handleManualDismiss}
                    className="text-emerald-700/60 hover:text-emerald-900 transition-colors flex-shrink-0"
                    aria-label="Dismiss"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
};

export default OperatorJoinedToast;
