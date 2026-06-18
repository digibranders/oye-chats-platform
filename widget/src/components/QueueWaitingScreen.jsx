import React, { useEffect, useState, useRef } from 'react';
import { Users, Clock, MessageSquare } from 'lucide-react';
import { sanitizeColor } from '../services/sanitize';

/**
 * QueueWaitingScreen — shown when the visitor is in the live chat queue
 * waiting for an operator to free up.
 *
 * UX principle: the wait state must show progress, not silence. We rotate
 * through three messaging variants over the wait window so the visitor knows
 * something is happening. At the timeout we offer them a choice rather than
 * forcing a fallback — visitors who really need live help keep waiting,
 * impatient visitors self-serve to the form.
 *
 * Visual states by elapsed time (against ``timeoutSeconds``, default 20s):
 *   0–25%  : "Looking for an available agent..." 🔍
 *   25–50% : "All agents are busy — waiting for the next available..." ⏳
 *   50–80% : "This is taking longer than usual..." ⌛
 *   80–100%: Choice card — [Keep waiting] [Leave a message]
 *
 * Props:
 *   - position           : 1-indexed queue position from backend (display only)
 *   - etaSeconds         : estimated wait time (display only — UI doesn't trust
 *                          this for timing decisions, only timeoutSeconds drives
 *                          the actual countdown)
 *   - timeoutSeconds     : how long until the auto-fallback CTA appears.
 *                          Sourced from bot.live_chat_queue_timeout_seconds.
 *   - primaryColor       : brand color for accents
 *   - onLeaveMessage     : called when visitor clicks "leave a message"
 *   - onKeepWaiting      : optional — called when visitor clicks "keep waiting"
 *                          (currently no-op; queue continues automatically)
 */
const QueueWaitingScreen = ({
    position,
    etaSeconds,
    timeoutSeconds = 20,
    primaryColor: rawPrimary,
    onLeaveMessage,
    onKeepWaiting,
}) => {
    const primaryColor = sanitizeColor(rawPrimary, '#3A0CA3');
    const [elapsed, setElapsed] = useState(0);
    // Once the visitor explicitly chooses to keep waiting, we stop showing the
    // choice prompt so they're not nagged every few seconds.
    const [chosenToWait, setChosenToWait] = useState(false);
    // Lazy ref so Date.now() is called inside useEffect (impure functions
    // can't run during render per React's strict mode rules).
    const startRef = useRef(null);

    useEffect(() => {
        startRef.current = Date.now();
        const tick = () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
        const interval = setInterval(tick, 500);
        return () => clearInterval(interval);
    }, []);

    // Progressive messaging — content depends on elapsed time as a fraction
    // of the configured timeout. Independent of the absolute number so longer
    // timeouts still cycle through all three messages.
    const progress = Math.min(1, elapsed / timeoutSeconds);
    let status;
    if (progress < 0.25) {
        status = { icon: Users, text: 'Looking for an available agent...', accent: primaryColor };
    } else if (progress < 0.5) {
        status = { icon: Clock, text: 'All agents are busy — waiting for the next available...', accent: '#F59E0B' };
    } else {
        status = { icon: Clock, text: 'This is taking a little longer than usual...', accent: '#EF4444' };
    }
    const StatusIcon = status.icon;

    const showChoicePrompt = !chosenToWait && progress >= 0.8;

    const handleKeepWaiting = () => {
        setChosenToWait(true);
        // Reset the countdown so the progressive messaging cycles again
        // from the top rather than instantly showing the choice prompt again.
        startRef.current = Date.now();
        setElapsed(0);
        onKeepWaiting?.();
    };

    return (
        <div
            className="mx-3 my-2 rounded-2xl border border-gray-100 bg-white shadow-sm max-w-xs"
            style={{ animation: 'fadeUp 0.3s ease-out' }}
        >
            {/* Animated status header */}
            <div className="p-4 border-b border-gray-50">
                <div className="flex items-center gap-3">
                    <div
                        className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 relative"
                        style={{ backgroundColor: `${status.accent}15` }}
                    >
                        <StatusIcon className="w-4 h-4" style={{ color: status.accent }} />
                        {/* Pulse ring while actively waiting */}
                        <span
                            className="absolute inset-0 rounded-full animate-ping"
                            style={{ backgroundColor: `${status.accent}30`, animationDuration: '2s' }}
                        />
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-[#16202C] leading-tight">
                            {status.text}
                        </p>
                        {position && position > 0 && (
                            <p className="text-[11px] text-gray-400 leading-tight mt-1">
                                Position {position}
                                {etaSeconds && etaSeconds > 0
                                    ? ` · ~${formatEta(etaSeconds)} wait`
                                    : ''}
                            </p>
                        )}
                    </div>
                </div>
            </div>

            {/* Progress bar — slow fill over the timeout window. Resets when
                visitor opts to keep waiting (visible signal that they made
                a choice). */}
            <div className="px-4 py-3">
                <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
                    <div
                        className="h-full rounded-full transition-all duration-1000 ease-linear"
                        style={{
                            width: `${progress * 100}%`,
                            backgroundColor: status.accent,
                        }}
                    />
                </div>
            </div>

            {/* Auto-fallback choice — appears once we're 80% through the
                timeout window. Visitor can opt to keep waiting or jump to
                the offline form. Choosing nothing waits indefinitely from
                this point (no hard cutoff). */}
            {showChoicePrompt && (
                <div className="p-4 pt-1 space-y-2">
                    <p className="text-[12px] text-gray-500 leading-relaxed">
                        We&apos;re still trying to connect you. Would you like to leave a message instead?
                    </p>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={handleKeepWaiting}
                            className="flex-1 py-2 rounded-lg border border-gray-200 text-[12px] font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            Keep waiting
                        </button>
                        <button
                            type="button"
                            onClick={onLeaveMessage}
                            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-white text-[12px] font-medium hover:opacity-90 transition-opacity"
                            style={{ backgroundColor: primaryColor }}
                        >
                            <MessageSquare className="w-3 h-3" />
                            Leave a message
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

function formatEta(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.round(seconds / 60);
    return `${mins} min`;
}

export default QueueWaitingScreen;
