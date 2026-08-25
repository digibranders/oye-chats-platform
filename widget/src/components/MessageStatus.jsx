import React, { useMemo } from 'react';
import { t } from '../i18n/i18n.js';

/**
 * WhatsApp-style message receipt indicator.
 *
 * Renders a small status glyph for a visitor's outgoing live-chat message:
 *   - "sending"  . Single hollow check, dimmed; subtle pulse while in flight
 *   - "sent"     . Single check, muted gray (server persisted the message)
 *   - "delivered" (double check, muted gray (operator's WS got it)
 *   - "read") double check, vivid green (operator viewed the chat)
 *   - "failed"   . Caller renders its own retry UI; this component renders nothing
 *
 * The glyph carries a localized timestamp tooltip + an aria-label so screen
 * readers and hover users both get the same information shown in the UI.
 */

const READ_COLOR = '#22C55E';      // Tailwind green-500. Vivid, accessible
const READ_GLOW = 'rgba(34,197,94,0.35)';
const NEUTRAL_COLOR = '#9CA3AF';   // gray-400. Calm, low-contrast
const SENDING_COLOR = '#CBD5E1';   // slate-300, even softer for in-flight

const formatTimestamp = (iso) => {
    if (!iso) return null;
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch {
        return null;
    }
};

// `time` is already locale-formatted by formatTimestamp above, so the
// dictionary entries only position it: Hindi puts the separator and the
// receipt word in a different order than English does.
const labelFor = (status, readAt, deliveredAt, sentAt) => {
    switch (status) {
        case 'sending':
            return t('status.sending') || 'Sending\u2026';
        case 'sent': {
            const time = formatTimestamp(sentAt);
            return time
                ? t('status.sent_at', { time }) || `Sent · ${time}`
                : t('status.sent') || 'Sent';
        }
        case 'delivered': {
            const time = formatTimestamp(deliveredAt || sentAt);
            return time
                ? t('status.delivered_at', { time }) || `Delivered · ${time}`
                : t('status.delivered') || 'Delivered';
        }
        case 'read': {
            const time = formatTimestamp(readAt);
            return time
                ? t('status.read_at', { time }) || `Read · ${time}`
                : t('status.read') || 'Read';
        }
        default: return '';
    }
};

const SingleCheck = ({ color, strokeWidth = 2.2 }) => (
    <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        focusable="false"
    >
        <path
            d="M2.5 8.6 L6 12 L13.5 4"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

const DoubleCheck = ({ color, glow, strokeWidth = 2.2 }) => (
    <svg
        width="18"
        height="14"
        viewBox="0 0 20 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        focusable="false"
        style={glow ? { filter: `drop-shadow(0 0 2px ${glow})` } : undefined}
    >
        <path
            d="M1.5 8.6 L5 12 L12.5 4"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
        />
        <path
            d="M7.5 8.6 L11 12 L18.5 4"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

const MessageStatus = ({ status = 'sending', sentAt, deliveredAt, readAt, className = '' }) => {
    const label = useMemo(
        () => labelFor(status, readAt, deliveredAt, sentAt),
        [status, readAt, deliveredAt, sentAt],
    );

    if (status === 'failed') return null;

    const isRead = status === 'read';
    const isSending = status === 'sending';
    const color = isRead ? READ_COLOR : isSending ? SENDING_COLOR : NEUTRAL_COLOR;

    return (
        <span
            className={`oyechats-msg-status inline-flex items-center select-none transition-colors duration-300 ease-out ${className}`}
            title={label}
            aria-label={label}
            role="status"
            data-status={status}
            style={{
                opacity: isSending ? 0.7 : 1,
                animation: isSending ? 'oyechatsTickPulse 1.4s ease-in-out infinite' : undefined,
            }}
        >
            {status === 'sent' ? (
                <SingleCheck color={color} />
            ) : status === 'sending' ? (
                <SingleCheck color={color} strokeWidth={2} />
            ) : (
                <DoubleCheck color={color} glow={isRead ? READ_GLOW : undefined} />
            )}
        </span>
    );
};

export default MessageStatus;
