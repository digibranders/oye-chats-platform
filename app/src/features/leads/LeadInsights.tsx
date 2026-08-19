import { useState } from 'react';
import { Badge, Button, Dialog, DefinitionList, formatDuration } from '../../ui';
import type { Lead } from '../../types/domain';

/**
 * Where the lead came from, and how they behaved before they typed.
 *
 * Both blocks read data the backend already produces and the drawer used to
 * carry a `TODO` for. Attribution (`detail.source`) only arrives on plans that
 * include it, so its presence is the gate — absent means the section is simply
 * not rendered rather than rendered empty.
 *
 * The engagement score is deliberately not printed as a number. It already
 * feeds the headline 0–100 quality score, and a second numeric scale in the
 * same panel competes with the verdict the panel exists to give, so it is
 * surfaced as a band instead.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

interface JourneyStep {
  path: string;
  timestamp: string | null;
  dwell: string | null;
  last: boolean;
}

/** Each page's dwell time is the gap to the next entry's timestamp. */
function buildJourney(entries: readonly unknown[]): JourneyStep[] {
  return entries.map((raw, index) => {
    const entry = asRecord(raw);
    const next = asRecord(entries[index + 1]);
    const from = asText(entry.ts);
    const to = asText(next.ts);
    let dwell: string | null = null;
    if (from && to) {
      const start = Date.parse(from);
      const end = Date.parse(to);
      // A clock that ran backwards, or a gap of days, is not a dwell time.
      const seconds = (end - start) / 1000;
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) {
        dwell = formatDuration(seconds);
      }
    }
    return {
      path: asText(entry.path) ?? '',
      timestamp: from,
      dwell,
      last: index === entries.length - 1,
    };
  });
}

function JourneyList({ steps, className }: { steps: readonly JourneyStep[]; className?: string }) {
  return (
    <ol className={className}>
      {steps.map((step, index) => (
        <li
          key={`${step.path}-${step.timestamp ?? index}`}
          className="flex items-start gap-2 border-t border-border py-1.5 first:border-t-0 text-xs"
        >
          <span className="figure w-6 shrink-0 text-text-tertiary">{index + 1}</span>
          <span className="min-w-0 flex-1 break-all text-text-primary">{step.path || '—'}</span>
          {step.last ? (
            <span className="shrink-0 text-xs text-text-secondary">opened the chat here</span>
          ) : step.dwell ? (
            <span className="figure shrink-0 text-text-tertiary">{step.dwell}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function SourceAttribution({ lead }: { lead: Lead }) {
  const [expanded, setExpanded] = useState(false);
  const source = asRecord(lead.source);
  // Absent entirely on plans without attribution — not empty, absent.
  if (Object.keys(source).length === 0) return null;

  const utm = asRecord(source.utm_params);
  const utmSource = asText(utm.utm_source);
  const rows = [
    { label: 'Campaign', value: asText(utm.utm_campaign) },
    { label: 'Medium', value: asText(utm.utm_medium) },
    { label: 'Ad detail', value: asText(utm.utm_content) ?? asText(utm.utm_term) },
    { label: 'Referrer', value: asText(source.referrer) },
    { label: 'Landed on', value: asText(source.landing_page) },
  ].filter((row): row is { label: string; value: string } => row.value !== null);

  const journey = buildJourney(Array.isArray(source.journey) ? source.journey : []);

  if (!utmSource && rows.length === 0 && journey.length === 0) {
    return (
      <section className="space-y-2">
        <h3 className="text-lg font-semibold text-text-primary">Where they came from</h3>
        <p className="rounded-md border border-border px-3.5 py-3 text-prose text-text-secondary">
          Direct or organic. No campaign tags and no referrer were captured for this visitor.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-text-primary">Where they came from</h3>
        {utmSource ? <Badge>{utmSource}</Badge> : null}
      </div>

      {rows.length > 0 ? (
        <div className="rounded-md border border-border px-3.5 py-3">
          <DefinitionList
            items={rows.map((row) => ({ label: row.label, value: truncate(row.value) }))}
          />
        </div>
      ) : null}

      {journey.length > 0 ? (
        <div className="rounded-md border border-border px-3.5 py-3">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-text-secondary">
              {journey.length === 1 ? '1 page' : `${journey.length} pages`} before the chat
            </p>
            {journey.length > 6 ? (
              <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
                See all
              </Button>
            ) : null}
          </div>
          {/* The tail is the payoff — the page they were on when they opened the
              chat — so a long journey shows its end, not its beginning. */}
          <JourneyList steps={journey.slice(-6)} />
        </div>
      ) : null}

      <Dialog
        open={expanded}
        onOpenChange={setExpanded}
        title="Pages visited before the chat"
        description={`${journey.length} pages, oldest first. The last one is where they opened the chat.`}
        size="lg"
      >
        <div className="max-h-[60vh] overflow-y-auto">
          <JourneyList steps={journey} />
        </div>
      </Dialog>
    </section>
  );
}

/** The 0–20 engagement score as a band, plus the raw return-visit count. */
function engagementBand(score: number): string {
  if (score >= 15) return 'High';
  if (score >= 8) return 'Medium';
  return 'Low';
}

function BehaviouralSignals({ lead }: { lead: Lead }) {
  const score = lead.behavioral_score ?? 0;
  const behavioural = lead.behavioral ?? {};
  const visits = Number(behavioural.visit_count) || 0;

  if (score <= 0 && visits <= 1) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-lg font-semibold text-text-primary">How they behaved</h3>
      <div className="rounded-md border border-border px-3.5 py-3">
        <DefinitionList
          items={[
            ...(score > 0
              ? [{ label: 'Engagement', value: engagementBand(score) }]
              : []),
            ...(visits > 1
              ? [
                  {
                    label: 'Visits',
                    value: <span className="figure">{visits}</span>,
                  },
                ]
              : []),
          ]}
        />
      </div>
    </section>
  );
}

/** Renders whichever insight sections have data, and nothing when neither does. */
export function LeadInsights({ lead }: { lead: Lead }) {
  return (
    <>
      <SourceAttribution lead={lead} />
      <BehaviouralSignals lead={lead} />
    </>
  );
}
