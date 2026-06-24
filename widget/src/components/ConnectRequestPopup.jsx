import React, { useEffect, useMemo, useState } from 'react';
import { UserCheck, Loader2 } from 'lucide-react';
import { sanitizeColor } from '../services/sanitize';

/**
 * ConnectRequestPopup — modal shown to the visitor when an operator proactively
 * asks to take over an AI conversation. The visitor sees the operator's name
 * and chooses Yes (switch to live chat) or No (continue with AI).
 *
 * The visitor's bot conversation is NOT interrupted — they can keep typing while
 * the popup is open; only their explicit choice changes the chat mode.
 *
 * Props:
 *   - operatorName : operator display name to show in the body copy
 *   - expiresAt    : optional unix-seconds deadline. If provided we render a
 *                    live countdown and auto-call ``onExpire`` when it hits 0.
 *   - submitting   : disables the buttons while the response is in flight
 *   - onAccept     : () => void  — visitor clicks Yes
 *   - onDecline    : () => void  — visitor clicks No (also Escape / overlay)
 *   - onExpire     : () => void  — fired exactly once when the countdown ends
 *   - primaryColor : brand accent for the primary CTA
 */
const ConnectRequestPopup = ({
    operatorName,
    expiresAt,
    submitting = false,
    onAccept,
    onDecline,
    onExpire,
    primaryColor: rawPrimary,
}) => {
    const primaryColor = sanitizeColor(rawPrimary, '#3A0CA3');
    const displayName = operatorName || 'A team member';

    // Countdown — drives the small timer chip in the corner. We only render
    // the chip if ``expiresAt`` is supplied so the popup remains useful for
    // ad-hoc / testing flows without a TTL.
    const targetMs = useMemo(
        () => (typeof expiresAt === 'number' ? expiresAt * 1000 : null),
        [expiresAt]
    );
    const [secondsLeft, setSecondsLeft] = useState(() => {
        if (targetMs == null) return null;
        return Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
    });

    useEffect(() => {
        if (targetMs == null) return undefined;
        const tick = () => {
            const remaining = Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
            setSecondsLeft(remaining);
            if (remaining === 0) {
                onExpire?.();
            }
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [targetMs, onExpire]);

    useEffect(() => {
        const handler = (e) => {
            if (e.key === 'Escape') onDecline?.();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onDecline]);

    const handleOverlayClick = (e) => {
        if (e.target === e.currentTarget && !submitting) onDecline?.();
    };

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="oyechats-connect-title"
            onClick={handleOverlayClick}
            className="absolute inset-0 z-[100] flex items-center justify-center bg-black/45 backdrop-blur-[2px] px-4"
            style={{ animation: 'fadeIn 0.2s ease-out' }}
        >
            <div
                className="w-full max-w-[300px] bg-white rounded-2xl shadow-xl border border-gray-200 overflow-hidden"
                style={{ animation: 'scaleIn 0.2s ease-out' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-5 pt-5 pb-3">
                    <div className="flex items-center gap-3 mb-3">
                        <div
                            className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                            style={{ backgroundColor: primaryColor }}
                        >
                            <UserCheck className="w-5 h-5 text-white" />
                        </div>
                        <div className="min-w-0">
                            <h3
                                id="oyechats-connect-title"
                                className="text-[14px] font-semibold text-[#16202C] leading-tight"
                            >
                                {displayName} wants to connect
                            </h3>
                            <p className="text-[12px] text-gray-500 leading-tight mt-0.5">
                                Switch to a live chat with a real person?
                            </p>
                        </div>
                    </div>

                    {secondsLeft != null && (
                        <div className="text-[10px] text-gray-400 mb-3">
                            Request expires in {secondsLeft}s
                        </div>
                    )}
                </div>

                <div className="px-5 pb-5 flex flex-col gap-2">
                    <button
                        type="button"
                        onClick={onAccept}
                        disabled={submitting}
                        className="w-full py-2.5 rounded-xl text-white text-[13px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-60 flex items-center justify-center gap-1.5"
                        style={{ backgroundColor: primaryColor }}
                    >
                        {submitting ? (
                            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Connecting…</>
                        ) : (
                            'Yes, connect me'
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={onDecline}
                        disabled={submitting}
                        className="w-full py-2.5 rounded-xl text-[13px] font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors disabled:opacity-60"
                    >
                        No, keep chatting with AI
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ConnectRequestPopup;
