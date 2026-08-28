import { Badge, formatMoney, formatNumber, type Tone } from '../../ui';
import type { Lead, LeadQuotation as Quotation } from '../../types/domain';
import { LeadSection } from './LeadSection';

/**
 * What the visitor priced up before they left.
 *
 * The quotation flow is the only place in the product where a visitor states a
 * number the customer can act on, so it belongs in the record next to what the
 * chatbot inferred — not behind a tab. An operator opening this lead is about
 * to call someone, and "three seats of onboarding, ₹42,000" is the sentence
 * that call opens with.
 *
 * **A started quote and a declined one are different facts.** An abandoned flow
 * still says the visitor was pricing; a skip says they looked and chose not to.
 * Both render, with their own sentence, rather than collapsing into one empty
 * state — or worse, into nothing, which reads as "the flow is not configured".
 *
 * Amounts are MAJOR units in the catalog's own currency (rupees, not paise),
 * unlike everything on the billing surfaces, so they are scaled up before
 * reaching `formatMoney`, which takes minor units everywhere else in the app.
 */

const STATUS_TONE: Record<Quotation['status'], Tone> = {
  complete: 'success',
  quoting: 'neutral',
  selecting: 'neutral',
  // `choosing` is the current spelling of `answering`; both render identically
  // so a session stored under either reads the same.
  choosing: 'neutral',
  answering: 'neutral',
  skipped: 'warning',
  idle: 'neutral',
};

const STATUS_LABEL: Record<Quotation['status'], string> = {
  complete: 'Quote accepted',
  quoting: 'Quote pending',
  selecting: 'Selecting services',
  choosing: 'Answering questions',
  answering: 'Answering questions',
  skipped: 'Declined',
  idle: 'Not started',
};

/** Catalog prices are authored in whole currency; `formatMoney` takes minor units. */
function money(currency: string, majorUnits: number): string {
  return formatMoney(Math.round(majorUnits * 100), currency, { showDecimals: !Number.isInteger(majorUnits) });
}

export function LeadQuotation({ lead }: { lead: Lead }) {
  const quotation = lead.quotation ?? null;
  if (!quotation) return null;

  const lines = quotation.line_items ?? [];
  const ended = quotation.status === 'skipped' || quotation.status === 'complete';
  // Nothing priced and nothing decided is a flow still in flight on a lead
  // nobody is reading live: it has no fact to report yet.
  if (lines.length === 0 && !ended) return null;

  return (
    <LeadSection
      title="Quotation"
      actions={<Badge tone={STATUS_TONE[quotation.status] ?? 'neutral'}>{STATUS_LABEL[quotation.status] ?? quotation.status}</Badge>}
    >
      {lines.length === 0 ? (
        <p className="text-sm text-text-secondary">
          {quotation.status === 'skipped'
            ? 'They opened the quote builder and chose not to price anything.'
            : 'They started a quote but never priced a service.'}
        </p>
      ) : (
        <>
          <ul>
            {lines.map((line) => (
              <li
                key={line.requirement_id}
                className="border-t border-border py-2 first:border-t-0 first:pt-0"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{line.label}</span>
                  <span className="figure shrink-0 text-sm text-text-primary">
                    {money(quotation.currency, line.subtotal)}
                  </span>
                </div>
                {/* The parent service is named here rather than above, because a
                    service with several requirements now yields several lines
                    that would otherwise repeat one heading. `unit_label` is
                    optional server-side (it defaults to ""), so the "per unit"
                    clause is dropped rather than rendered bare when absent. */}
                <p className="figure mt-0.5 text-xs text-text-tertiary">
                  {line.service_name} · {formatNumber(line.quantity)} ×{' '}
                  {money(quotation.currency, line.price)}
                  {line.unit_label ? ` per ${line.unit_label}` : ''}
                </p>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-2">
            <span className="text-sm font-medium text-text-primary">Estimated total</span>
            <span className="figure text-base font-semibold text-text-primary">
              {money(quotation.currency, quotation.total)}
            </span>
          </div>
        </>
      )}
    </LeadSection>
  );
}
