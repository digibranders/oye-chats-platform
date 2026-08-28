/**
 * Types for the itemized thumbs-up/down feedback log (`ChatMessage.feedback`,
 * 1 = 👍, -1 = 👎). This is distinct from the star-rating CSAT surface
 * (`SatisfactionBreakdown`, `ChatSession.visitor_rating`) and from platform
 * bug reports - see `GET /analytics/feedback`.
 */

/**
 * One rated bot answer, as returned by `GET /analytics/feedback`. `user` is
 * server-anonymized (e.g. "User -3"); there is no pagination or server-side
 * filtering - the full set returns and is filtered/bucketed client-side.
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

/**
 * There is deliberately no date-range type here any more.
 *
 * This panel used to own a private 7d/30d/All control, which made it the last
 * surface on `/analytics` speaking a second time vocabulary: the page header
 * could say "Last 90 days" while the card below it counted a fortnight, with
 * nothing on screen admitting the two disagreed. The window now arrives as a
 * `ResolvedRange` from `features/analytics/range.ts`, the same one every other
 * tab is scoped by.
 */
