import type { ReactNode } from 'react';
import { siCaldotcom, siCalendly } from 'simple-icons';
import { simpleIconNode } from '../../../lib/simpleIcon';

/**
 * The real brand mark for each meeting-link provider, keyed by
 * `MeetingProvider.id` in `emailModel`. Calendly and Cal.com come from Simple
 * Icons; Zcal is not in that set, so its mark — a calendar with a lightning
 * "Z" through it — is hand-built here, in the brand's indigo.
 */
export const MEETING_PROVIDER_ICONS: Record<string, ReactNode> = {
  calendly: simpleIconNode(siCalendly),
  calcom: simpleIconNode(siCaldotcom),
  zcal: (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden style={{ color: '#6366F1' }}>
      <rect x="3.5" y="5.5" width="17" height="15" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 3.5 V6.5 M16 3.5 V6.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M5 11 L10 10 L14 14 L19 13"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};
