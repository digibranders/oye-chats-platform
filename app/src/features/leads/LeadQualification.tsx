import { ABSENT, Disclosure, Progress } from '../../ui';
import type { Lead, LeadSignal } from '../../types/domain';
import { LeadSection } from './LeadSection';
import { orderedDimensions } from './leadModel';
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
 * There is **no denominator** any more, and that is the honest reading rather
 * than a regression. Two earlier versions both invented one: the first took
 * `max(100 / dimensionCount, ...observedScores)`, so a single high score raised
 * the ceiling for that lead alone; the second dropped to a flat
 * `round(100 / dimensionCount)`, which is 17 for MEDDIC's six dimensions
 * against a top option worth 21, so a top-scoring dimension read "21/17"
 * beside a bar clamped at full, and the second-best option (17) painted as
 * maxed out at 81% of the real ceiling. The lead payload carries `{value,
 * score}` per dimension and no weight, no option table and no framework
 * config, so a per-dimension ceiling is not a fact this screen has. A score
 * with no ceiling is still a fact, and it is stated as one: these are the
 * points the dimension contributed to the 0 to 100 score in the header.
 * `orderedDimensions` carries a `max` for the day the API starts sending one,
 * and the bar and the fraction come back with it.
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
          const max = dimension.max;
          return (
            <li
              key={dimension.key}
              className="flex items-center gap-3 border-t border-border py-2 first:border-t-0"
            >
              <span className="w-28 shrink-0 truncate text-sm font-medium text-text-primary">
                {dimension.label}
              </span>
              {/* The bar exists only where a real ceiling does. A bar with an
                  invented denominator is worse than no bar: it renders a
                  position on a scale that does not exist, and it is the one
                  element on the row a reader cannot check.

                  `hideLabel`: the row prints the dimension's name at its
                  leading edge and the score at its trailing one, so a label row
                  on the bar would be the same two facts a third time. The
                  `aria-label` still says both. */}
              {max !== null ? (
                <Progress
                  className="min-w-0 flex-1"
                  size="sm"
                  hideLabel
                  value={Math.min((dimension.score / max) * 100, 100)}
                  label={`${dimension.label}: ${dimension.score} out of ${max}`}
                  tone={dimension.captured ? 'success' : 'accent'}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                  {dimension.captured ? 'Captured' : 'Nothing captured for this yet'}
                </span>
              )}
              <span className="figure w-12 shrink-0 text-right text-xs text-text-secondary">
                {max !== null
                  ? `${dimension.score}/${max}`
                  : dimension.captured
                    ? `+${dimension.score}`
                    : ABSENT}
              </span>
            </li>
          );
        })}
      </ul>

      {/* What the bare figure means, once, rather than a fake denominator on
          every row. It is checkable: the dimension scores are what the backend
          sums into the qualification half of the 0 to 100 score in the header. */}
      {dimensions.every((dimension) => dimension.max === null) ? (
        <p className="mt-2 text-xs text-text-tertiary">
          Points each answer added to this lead&rsquo;s score.
        </p>
      ) : null}

      {/* Evidence, once, below the list, not a paragraph inside every row. */}
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
