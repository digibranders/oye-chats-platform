import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingRows,
  buttonClass,
  formatNumber,
} from '../../ui';
import { formatDate } from '../../i18n/formatters';
import { t as translateNow } from '../../i18n/i18n';
import { errorMessage, useOperatorRatedChats } from '../analytics/useAnalyticsData';
import type { ResolvedRange } from '../analytics/range';

export interface OperatorChatsProps {
  botId: number | null;
  operatorId: number;
  /** The page's range, the same window the operator's row was averaged over. */
  range: ResolvedRange;
}

/** A rating at or below this is one the visitor was unhappy with. */
const UNHAPPY_AT_MOST = 2;

/**
 * The chats behind one operator's row in the breakdown: who they spoke with,
 * how that visitor rated it, and a way into the conversation.
 *
 * Worst first, as the server orders them, because a manager opens an operator
 * to find the chats behind "1 unhappy". Each row links to the lead drawer, not
 * the inbox: every rated chat is closed, the inbox holds only open work, and a
 * link there would land on an empty pane. The lead drawer opens any
 * conversation in the workspace, whether or not the visitor left details.
 *
 * On screen only. The monthly CSV deliberately carries no visitor identities.
 */
export function OperatorChats({ botId, operatorId, range }: OperatorChatsProps) {
  const { chats, total, unrated, loading, error, hasMore, loadingMore, loadMore, retry } =
    useOperatorRatedChats(botId, operatorId, range);

  if (loading) return <LoadingRows rows={3} className="py-2" />;

  if (error) {
    return (
      <ErrorState
        flush
        size="inline"
        title="Chats could not be loaded"
        description={errorMessage(error, "The request for this operator's chats failed.")}
        onRetry={retry}
      />
    );
  }

  if (chats.length === 0) {
    return (
      <EmptyState
        flush
        size="inline"
        title="No rated chats in this period"
        description="Choose a longer period at the top of the page to look further back."
      />
    );
  }

  const anonymous = translateNow('leads.anonymousVisitor') || 'Anonymous visitor';
  const remaining = total - chats.length;

  return (
    <div className="flex flex-col gap-2 pb-2">
      <ul className="flex flex-col" aria-label="Rated chats, lowest rating first">
        {chats.map((chat) => {
          const who = chat.visitorName ?? chat.visitorEmail ?? anonymous;
          return (
            <li
              key={chat.sessionId}
              className="flex min-h-row-compact items-center gap-3 border-b border-border last:border-b-0"
            >
              <span className="w-16 shrink-0 text-caption text-text-secondary">
                {chat.rating <= UNHAPPY_AT_MOST ? (
                  <Badge tone="danger">{chat.rating} star</Badge>
                ) : (
                  `${chat.rating} star`
                )}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate text-body">{who}</span>
                {chat.visitorName && chat.visitorEmail ? (
                  <span className="truncate text-caption text-text-tertiary">{chat.visitorEmail}</span>
                ) : null}
              </span>
              <span className="w-28 shrink-0 whitespace-nowrap text-end text-caption text-text-secondary">
                {chat.createdAt ? formatDate(chat.createdAt, { day: 'numeric', month: 'short' }) : null}
              </span>
              <Link
                to={`/leads?lead=${encodeURIComponent(chat.sessionId)}`}
                className={buttonClass('link', 'sm', 'shrink-0 text-caption')}
                aria-label={`View chat with ${who}`}
              >
                View chat
              </Link>
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <Button size="sm" variant="ghost" className="self-start" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading more' : `Show more (${formatNumber(remaining)} left)`}
        </Button>
      ) : null}
      {unrated > 0 ? (
        <p className="text-caption text-text-tertiary">
          Plus {formatNumber(unrated)} {unrated === 1 ? "chat that wasn't" : "chats that weren't"} rated.
        </p>
      ) : null}
    </div>
  );
}
