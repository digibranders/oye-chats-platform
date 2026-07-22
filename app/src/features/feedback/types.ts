/**
 * Types for the itemized thumbs-up/down feedback log (`ChatMessage.feedback`,
 * 1 = 👍, -1 = 👎). This is distinct from the star-rating CSAT surface
 * (`SatisfactionBreakdown`, `ChatSession.visitor_rating`) and from platform
 * bug reports — see `GET /analytics/feedback`.
 */

/**
 * One rated bot answer, as returned by `GET /analytics/feedback`. `user` is
 * server-anonymized (e.g. "User -3"); there is no pagination or server-side
 * filtering — the full set returns and is filtered/bucketed client-side.
 */
export interface FeedbackItem {
  message_id: number;
  /** ISO timestamp. */
  created_at: string;
  question: string;
  answer: string;
  /** 1 = thumbs-up (positive), -1 = thumbs-down (negative). */
  feedback: 1 | -1;
  user: string;
}

/** Filter tab selection for the feedback list. */
export type FeedbackFilter = 'all' | 'positive' | 'negative';

/** Date-range segmented control selection. */
export type DateRange = '7d' | '30d' | 'all';
