import { Link } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Card,
  CardFooter,
  CardSection,
  CopyField,
  Eyebrow,
  StatTile,
  buttonClass,
  formatDate,
  formatNumber,
} from '../../ui';
import { agentPath } from '../../shell/nav';
import type { AgentListItem } from './AgentsPage';
import { AgentActionsMenu } from './AgentActionsMenu';

/**
 * One chatbot in the list.
 *
 * The card is not itself a link. It cannot be: it holds a copy control, a
 * status badge and an actions menu, and wrapping interactive content in an
 * anchor produces markup no screen reader or browser handles the same way. The
 * card the audit found solved that by absolutely positioning the "⋯" menu on
 * top of the tile's own click target, so the two controls overlapped and the
 * menu's hit area stole presses meant for the card. Here the chatbot's name is
 * the link — one clear target, with its own focus ring — and the menu is its
 * sibling in the header row.
 *
 * `bot_key` is a real `CopyField`, not the masked caption it used to be. It is
 * the value a customer pastes into their site and quotes in a support ticket,
 * and showing it in a form nobody can copy was the least useful of the three
 * possible choices.
 */
export interface AgentCardProps {
  item: AgentListItem;
  /** Called after a rename or delete, so the list can refetch. */
  onChanged: () => void;
}

export function AgentCard({ item, onChanged }: AgentCardProps) {
  const { bot, health, conversations, conversationsLoading } = item;
  const name = bot.name || `Chatbot ${bot.id}`;
  const indexed = Number(bot.indexed_chunk_count ?? 0);

  return (
    <Card as="li" className="flex flex-col">
      <div className="flex items-start gap-3 px-5 py-4">
        <Avatar name={name} src={bot.bot_logo} size="lg" shape="rounded" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-text-primary">
            <Link
              to={agentPath(bot.id, 'overview')}
              className="underline-offset-2 outline-none hover:underline focus-visible:underline"
            >
              {name}
            </Link>
          </h3>
          <p className="mt-0.5 truncate text-xs text-text-secondary">
            {bot.website || 'No website set'}
          </p>
          <Badge tone={health.tone} dot className="mt-2">
            {health.label}
          </Badge>
        </div>
        <AgentActionsMenu bot={bot} onChanged={onChanged} />
      </div>

      <CardSection className="grid grid-cols-2 gap-4">
        <StatTile
          label="Knowledge"
          value={indexed > 0 ? formatNumber(indexed) : undefined}
          period={indexed > 0 ? 'Passages indexed' : 'Nothing indexed'}
        />
        <StatTile
          label="Conversations"
          value={conversations === null ? undefined : formatNumber(conversations)}
          period="All time"
          loading={conversationsLoading}
        />
      </CardSection>

      <CardSection className="space-y-1.5">
        <Eyebrow>Chatbot key</Eyebrow>
        {bot.bot_key ? (
          <CopyField value={bot.bot_key} label={`chatbot key for ${name}`} />
        ) : (
          <p className="figure text-xs text-text-tertiary">Not issued yet</p>
        )}
        <p className="text-xs text-text-tertiary">Created {formatDate(bot.created_at)}</p>
      </CardSection>

      {/* One action, and only when there is something to do about this chatbot.
          A row of buttons on every card turns the grid into a wall of chrome
          and buries the one card that actually needs a press. */}
      <CardFooter className="mt-auto justify-start">
        {health.action ? (
          <Link to={agentPath(bot.id, health.action.segment)} className={buttonClass('secondary', 'sm')}>
            {health.action.label}
          </Link>
        ) : (
          <Link to={agentPath(bot.id, 'overview')} className={buttonClass('ghost', 'sm')}>
            Open overview
          </Link>
        )}
      </CardFooter>
    </Card>
  );
}
