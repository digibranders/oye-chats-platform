import { FeedbackPanel } from '../feedback/FeedbackPanel';
import type { ResolvedRange } from './range';

/**
 * Feedback — thumbs up and down on individual answers.
 *
 * The panel belongs to the feedback feature; this tab is its door, and the
 * thing it now hands over is the page's range. The panel used to own a private
 * 7d/30d/All control, which made it the last surface here speaking a second
 * time vocabulary — that control is gone and the window arrives from the same
 * `?range=` every other tab is scoped by.
 */
export function FeedbackTab({ botId, range }: { botId: number | null; range: ResolvedRange }) {
  return <FeedbackPanel botId={botId} range={range} />;
}
