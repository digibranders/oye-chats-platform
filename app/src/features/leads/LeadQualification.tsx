import { Disclosure, Progress } from '../../ui';
import type { Lead, LeadSignal } from '../../types/domain';
import { LeadSection } from './LeadSection';
import { dimensionMax, orderedDimensions } from './leadModel';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * What the chatbot learned. Read-only — the score is derived from what the
 * visitor said, and stays that way.
 *
 * An operator override control (`PATCH /operators/session/{id}/qualification`)
 * was built and shipped briefly here, on the reasoning that the automated
 * extractor never downgrades a dimension, so a single false-positive
 * extraction could pin a lead to the wrong tier with no remedy short of
 * editing the database. Removed on review: a plain 0–{max} dropdown let an
 * operator raise a score just as easily as correct one, which is a different
 * capability than the one the endpoint was built to offer, and `development`
 * never exposed the endpoint as a control for exactly that reason — the
 * endpoint existed there, unused, behind no client function at all. If a way
 * back from a bad extraction is needed, it wants a narrower shape than a free
 * 0–{max} pick — most obviously, an action that can only ever lower a score,
 * never raise one.
 *
 * The **denominator** is still derived from the framework, not from the data.
 * The version this replaced took `max(100 / dimensionCount, ...observedScores)`,
 * so a single high score raised the ceiling for that lead alone and two leads
 * on the same chatbot were shown "18 / 25" and "30 / 30" — neither of which
 * the reader could compare with anything.
 *
 * **It is four rows, not four boxes.** Each dimension used to be a bordered
 * panel holding a label, a figure, a `Progress` bar and then either a
 * bulleted list, a paragraph or "Nothing captured for this yet." — about
 * 460px for four dimensions, with the two things a salesperson actually wants
 * (which dimensions landed, and what the visitor said) buried under three layers
 * of chrome each. One hairline row per dimension is 144px, and what the visitor
 * said moves below the list as evidence, consulted rather than scanned.
 */

export interface LeadQualificationProps {
  lead: Lead;
}

/**
 * Every distinct value the visitor stated for one dimension, in the order they
 * said them, so a lead who mentioned three separate needs shows all three
 * rather than only the highest-scoring one.
 *
 * `operator_override` signals are excluded even though nothing in this UI
 * writes one any more: their `extracted_value` is the raw numeric score, not
 * something the visitor said, and a lead scored before this control was
 * removed can still carry one in its signal history. Values are
 * de-duplicated case-insensitively so a repeated mention appears once.
 */
function statedValues(signals: LeadSignal[] | undefined, dimension: string): string[] {
  if (!signals?.length) return [];
  const target = dimension.toLowerCase();
  const seen = new Set<string>();
  const values: string[] = [];
  for (const signal of signals) {
    if ((signal.dimension ?? '').toLowerCase() !== target) continue;
    if (signal.source === 'operator_override') continue;
    const value = (signal.extracted_value ?? '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

export function LeadQualification({ lead }: LeadQualificationProps) {
  const { t } = useTranslation();
  const dimensions = orderedDimensions(lead);
  if (dimensions.length === 0) return null;

  const max = dimensionMax(dimensions.length);

  const evidence = dimensions
    .map((dimension) => ({
      label: dimension.label,
      values: statedValues(lead.signals, dimension.key),
      fallback: dimension.value,
    }))
    .filter((entry) => entry.values.length > 0 || entry.fallback);

  return (
    <LeadSection title={t('leads.whatWeLearned') || 'What we learned'}>
      <ul>
        {dimensions.map((dimension) => {
          // Clamped for the bar only. An unevenly-weighted dimension can exceed
          // the equal-weight ceiling, and the figure beside it reports the truth
          // rather than moving the goalposts.
          const percent = Math.min((dimension.score / max) * 100, 100);
          return (
            <li
              key={dimension.key}
              className="flex items-center gap-3 border-t border-border py-2 first:border-t-0"
            >
              <span className="w-28 shrink-0 truncate text-sm font-medium text-text-primary">
                {dimension.label}
              </span>
              {/* `hideLabel`: the row prints the dimension's name at its
                  leading edge and the score at its trailing one, so a label row
                  on the bar would be the same two facts a third time — and a
                  30px labelled bar in a list of 6px bare ones would not share a
                  baseline with its siblings. The `aria-label` still says both. */}
              <Progress
                className="min-w-0 flex-1"
                size="sm"
                hideLabel
                value={percent}
                label={`${dimension.label}: ${dimension.score} out of ${max}`}
                tone={dimension.captured ? 'success' : 'accent'}
              />
              <span className="figure w-12 shrink-0 text-right text-xs text-text-secondary">
                {dimension.score}/{max}
              </span>
            </li>
          );
        })}
      </ul>

      {/* Evidence, once, below the list — not a paragraph inside every row. */}
      {evidence.length > 0 ? (
        <Disclosure
          className="mt-2"
          summary={`What they said (${evidence.length})`}
          regionLabel="What the visitor said"
        >
          <dl className="space-y-2">
            {evidence.map((entry) => (
              <div key={entry.label}>
                <dt className="text-xs text-text-secondary">{entry.label}</dt>
                <dd className="text-prose text-text-primary">
                  {entry.values.length > 0 ? entry.values.join(' · ') : entry.fallback}
                </dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      ) : null}
    </LeadSection>
  );
}
