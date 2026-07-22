import { type ReactElement } from 'react';
import { Radio, Users, MessageSquare, Hammer, AlertCircle } from 'lucide-react';
import { Button, StatusBadge, EmptyState, Skeleton } from '../../design-system';
import { MetricCard } from '../../design-system/components/MetricCard';
import { InsightCard } from '../../design-system/components/InsightCard';
import { type OperatorStatusState } from './useOperatorStatus';

export interface LiveChatPanelProps {
  operator: OperatorStatusState;
}

/**
 * LiveChatPanel — SCAFFOLD ONLY.
 *
 * The full real-time operator console (WebSocket sessions, typing indicators,
 * canned-response insertion, handoff) is a large surface deliberately NOT ported
 * here. This renders a faithful, structured placeholder: availability state,
 * live counters (stubbed at zero), and a waiting-queue empty state, so the shape
 * of the finished experience is legible.
 *
 * TODO(inbox/live-chat): build the console against `ws_routes.py` /
 * `live_chat_service.py` — active conversations list, message thread, operator
 * reply box with `/shortcut` canned responses, and visitor→operator handoff.
 */
export function LiveChatPanel({ operator }: LiveChatPanelProps): ReactElement {
  const { isOnline, unavailable, saving, loading, error, toggle } = operator;

  return (
    <div className="space-y-6">
      <InsightCard
        icon={Hammer}
        tone="info"
        title="The live chat console is coming soon"
        body="You’ll be able to take real-time conversations from visitors right here — see who’s waiting, reply instantly, and hand off between teammates. For now, set your availability so incoming chats route correctly once it’s live."
      />

      {/* Availability — real, wired to the operator status API. */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]">
        <div className="flex items-center gap-3">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]"
            aria-hidden="true"
          >
            <Radio size={18} />
          </span>
          <div>
            <p className="text-[14px] font-semibold text-[var(--ds-text)]">Your availability</p>
            <p className="text-[13px] text-[var(--ds-text-muted)]">
              {loading
                ? 'Checking your availability…'
                : unavailable
                  ? 'You’re not set up as a live-chat operator in this workspace yet.'
                  : isOnline
                    ? 'You’re online and can receive live conversations.'
                    : 'You’re offline. Visitors will be offered the message form instead.'}
            </p>
          </div>
        </div>
        {loading ? (
          // Don't assert Online/Offline before the real status resolves.
          <Skeleton className="h-8 w-40 rounded-lg" />
        ) : unavailable ? (
          <StatusBadge tone="neutral">Not an operator</StatusBadge>
        ) : (
          <div className="flex items-center gap-3">
            <StatusBadge tone={isOnline ? 'success' : 'neutral'} dot>
              {isOnline ? 'Online' : 'Offline'}
            </StatusBadge>
            <Button variant="outline" size="sm" onClick={() => void toggle()} disabled={saving}>
              {saving ? 'Saving…' : isOnline ? 'Go offline' : 'Go online'}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] px-3 py-2 text-[13px] text-[var(--ds-danger)]"
        >
          <AlertCircle size={15} aria-hidden="true" />
          {error}
        </div>
      )}

      {/* Stubbed live counters — shape of the finished console. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MetricCard label="Active conversations" value="0" icon={MessageSquare} />
        <MetricCard label="Waiting for an operator" value="0" icon={Users} />
      </div>

      <EmptyState
        icon={MessageSquare}
        title="No live conversations yet"
        description="When the live console ships, active visitor chats will appear here in real time."
      />
    </div>
  );
}
