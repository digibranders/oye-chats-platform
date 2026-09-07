import React, { useMemo } from 'react';
import { t } from '../i18n/i18n.js';

/**
 * Delivery receipt for a visitor's outgoing live-chat message.
 *
 * Renders the state as a WORD rather than a tick glyph:
 *   - "sending"   . in flight, not yet acknowledged by the server
 *   - "sent"      . the server persisted it
 *   - "delivered" . the operator's socket received it
 *   - "read"      . the operator opened the chat
 *   - "failed"    . the caller renders its own retry UI; this renders nothing
 *
 * WHY WORDS AND NOT TICKS. A tick is a convention the visitor has to already
 * know, and a double tick and a single tick differ by a few pixels at 14px.
 * "Delivered" and "Read" need no decoding, and every string is already
 * translated in every locale (they were written for the old glyph's tooltip),
 * so this costs nothing in i18n and inherits RTL for free.
 *
 * WHY IT IS DELIBERATELY QUIET. Words are read; glyphs are skimmed. Rendered
 * under every message this would be a stuttering column of "Read / Read /
 * Read" beside the thread -- louder than the ticks it replaces. The caller
 * therefore renders it on the LAST outgoing message only (the iMessage
 * pattern), and the type here is small, italic and low-contrast so it reads as
 * an annotation rather than as content.
 *
 * One neutral grey for every state, "read" included. Colour-coding the final
 * state would make the receipt compete with the message above it, and the word
 * already carries the meaning that the colour would only be repeating.
 */

const NEUTRAL_COLOR = '#9CA3AF';   // gray-400. Calm, low-contrast
const SENDING_COLOR = '#CBD5E1';   // slate-300, softer still while in flight

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
            return t('status.sending') || 'Sending…';
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

const MessageStatus = ({ status = 'sending', sentAt, deliveredAt, readAt, className = '' }) => {
    const label = useMemo(
        () => labelFor(status, readAt, deliveredAt, sentAt),
        [status, readAt, deliveredAt, sentAt],
    );

    if (status === 'failed' || !label) return null;

    const isSending = status === 'sending';

    return (
        <span
            className={`oyechats-msg-status select-none transition-colors duration-300 ease-out ${className}`}
            // `title` kept even though the text is now visible: the label is
            // truncated to the bubble's width on a narrow viewport, and hover
            // is the only way back to the timestamp when it is.
            title={label}
            aria-label={label}
            role="status"
            data-status={status}
            style={{
                fontSize: '10px',
                fontStyle: 'italic',
                fontWeight: 400,
                lineHeight: 1.4,
                color: isSending ? SENDING_COLOR : NEUTRAL_COLOR,
                animation: isSending ? 'oyechatsTickPulse 1.4s ease-in-out infinite' : undefined,
            }}
        >
            {label}
        </span>
    );
};

export default MessageStatus;
