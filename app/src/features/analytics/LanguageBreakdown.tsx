import { type ReactElement } from 'react';
import { Languages } from 'lucide-react';
import { EmptyState } from '../../design-system';
import { type LanguageBreakdown as LanguageBreakdownData } from './analytics-types';

/**
 * LanguageBreakdown - which languages this agent's visitors actually chat in,
 * and how each one performs.
 *
 * Bars are proportional to the largest language rather than to the total, so a
 * long tail stays legible instead of collapsing into slivers beside a dominant
 * first language.
 *
 * Rendered as a panel body; the page owns the Card and SectionHeader, matching
 * `SatisfactionBreakdown`.
 */
export function LanguageBreakdown({ data }: { data: LanguageBreakdownData }): ReactElement {
  if (data.totals.total === 0) {
    return (
      <EmptyState
        icon={Languages}
        title="No conversations yet"
        description="Once visitors start chatting, you'll see which languages they use and how well your chatbot handles each one."
      />
    );
  }

  /**
   * "Not detected" is pinned last however large it is. It is a residual, not a
   * language, and sorting it into first place (which it will be for any agent
   * that turned multilingual on recently) would read as though most visitors
   * spoke something called "Not detected".
   */
  const named = data.rows.filter((row) => row.languageCode !== null);
  const residual = data.rows.filter((row) => row.languageCode === null);
  const rows = [...named, ...residual];
  const peak = Math.max(1, ...rows.map((row) => row.total));

  return (
    <ol className="space-y-4">
      {rows.map((row) => {
        const share = Math.round((row.total / data.totals.total) * 100);
        const width = Math.max(Math.round((row.total / peak) * 100), 2);
        const isResidual = row.languageCode === null;
        return (
          <li key={row.languageCode ?? '__none__'}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">{row.label}</p>
                <p className="text-[12px] text-[var(--ds-text-subtle)]">
                  {isResidual
                    ? 'Chats from before multilingual was on, or with no language detected'
                    : `${row.resolved.toLocaleString()} resolved · ${row.liveChat.toLocaleString()} reached a human`}
                </p>
              </div>
              <p className="shrink-0 text-[13px] font-semibold tabular-nums text-[var(--ds-text-muted)]">
                {row.total.toLocaleString()}
                <span className="ml-1.5 text-[var(--ds-text-subtle)]">{share}%</span>
              </p>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]" aria-hidden="true">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${width}%`,
                  backgroundColor: isResidual ? 'var(--ds-text-subtle)' : 'var(--ds-accent)',
                }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * TranslationUsage - what live-chat translation is doing and what it costs.
 *
 * Split into a rolling block and a durable one because the two cannot be
 * compared. The activity counters expire after about a day, so they can never
 * answer "how much have we translated this month"; the credit figure is the
 * billing record and does not expire. On real data the gap is stark: an agent
 * showing 494 requests in the rolling window had spent 2 credits, because most
 * requests were cache hits or same-language skips that are never charged.
 *
 * Token counts are deliberately absent. `translation_tokens_prompt` and
 * `_completion` are incremented without a `bot_id`, so they only exist at
 * global scope; showing a platform-wide figure on a per-agent screen would be
 * worse than showing nothing.
 */
export function TranslationUsage({ data }: { data: LanguageBreakdownData }): ReactElement {
  const { translation, creditsSpent } = data;
  const successRate =
    translation.requests > 0 ? Math.round((translation.ok / translation.requests) * 100) : null;
  const problems = translation.failed + translation.timeout;

  return (
    <div className="space-y-5">
      <section>
        <p className="text-[12px] font-medium text-[var(--ds-text-muted)]">
          Last {translation.windowHours} hours
        </p>
        <p className="mt-0.5 text-[11px] text-[var(--ds-text-subtle)]">
          A rolling window. These counters expire, so this is recent activity, not history.
        </p>
        {translation.requests === 0 ? (
          <p className="mt-3 text-[13px] text-[var(--ds-text-muted)]">
            No messages translated in this window.
          </p>
        ) : (
          <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Messages translated" value={translation.ok} />
            <Stat
              label="Succeeded"
              value={successRate === null ? '—' : `${successRate}%`}
              warn={successRate !== null && successRate < 90}
            />
            <Stat label="Failed or timed out" value={problems} warn={problems > 0} />
          </dl>
        )}
      </section>

      <section className="border-t border-[var(--ds-border)] pt-4">
        <p className="text-[12px] font-medium text-[var(--ds-text-muted)]">Credits spent</p>
        <p className="mt-0.5 text-[11px] text-[var(--ds-text-subtle)]">
          From your billing record, for the selected period. This does not expire.
        </p>
        <p className="mt-2 text-[20px] font-bold tabular-nums text-[var(--ds-text)]">
          {creditsSpent.toLocaleString()}
        </p>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: number | string;
  warn?: boolean;
}): ReactElement {
  return (
    <div>
      <dt className="text-[12px] text-[var(--ds-text-subtle)]">{label}</dt>
      <dd
        className="mt-0.5 text-[17px] font-bold tabular-nums"
        style={{ color: warn ? 'var(--ds-warning)' : 'var(--ds-text)' }}
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
      </dd>
    </div>
  );
}
