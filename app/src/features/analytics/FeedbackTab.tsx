import { FeedbackPanel } from '../feedback/FeedbackPanel';

/**
 * Feedback — thumbs up and down on individual answers.
 *
 * The panel itself belongs to the feedback feature and is reused unchanged;
 * this tab is only its door. It keeps its own date control for now, which is
 * the one time vocabulary on this surface that Analytics does not own — noted
 * rather than papered over, because the fix belongs in that component.
 */
export function FeedbackTab({ botId }: { botId: number | null }) {
  return <FeedbackPanel agentId={botId != null ? String(botId) : undefined} />;
}
