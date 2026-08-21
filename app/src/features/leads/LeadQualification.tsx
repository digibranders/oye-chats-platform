import { useState } from 'react';
import { Info } from 'lucide-react';
import { Alert, Disclosure, Progress, Select, Tooltip } from '../../ui';
import type { Lead, LeadSignal } from '../../types/domain';
import { LeadSection } from './LeadSection';
import { dimensionMax, orderedDimensions } from './leadModel';

/**
 * What the chatbot learned, and the operator's way of correcting it.
 *
 * Two defects from the audit close here.
 *
 * The **denominator** is derived from the framework, not from the data. The
 * version this replaces took `max(100 / dimensionCount, ...observedScores)`, so
 * a single high score raised the ceiling for that lead alone and two leads on
 * the same chatbot were shown "18 / 25" and "30 / 30" — neither of which the
 * reader could compare with anything.
 *
 * And the **override** exists at all. `PATCH /operators/session/{id}/qualification`
 * has always been there and had no client function, let alone a control. The
 * automated extractor deliberately never downgrades a dimension, so one
 * false-positive extraction — a visitor claiming a budget they do not have —
 * pinned a lead to the wrong tier permanently, with no remedy short of editing
 * the database. Every override is written to the same append-only signal trail
 * as an LLM extraction, tagged as an operator's.
 *
 * **It is four rows, not four boxes.** Each dimension used to be a bordered
 * panel holding a label, a figure, a `Select`, a `Progress` bar and then either
 * a bulleted list, a paragraph or "Nothing captured for this yet." — about
 * 460px for four dimensions, with the two things a salesperson actually wants
 * (which dimensions landed, and what the visitor said) buried under three layers
 * of chrome each. One hairline row per dimension is 144px, and what the visitor
 * said moves below the list as evidence, consulted rather than scanned.
 */

export interface LeadQualificationProps {
  lead: Lead;
  /** Applies an operator override. Resolves once the server has recomputed. */
  onOverride: (override: { dimension: string; score: number }) => Promise<void>;
  saving: boolean;
}

/**
 * Every distinct value the visitor stated for one dimension, in the order they
 * said them, so a lead who mentioned three separate needs shows all three
 * rather than only the highest-scoring one.
 *
 * Operator overrides are excluded: their `extracted_value` is the raw numeric
 * score, not something the visitor said. Values are de-duplicated
 * case-insensitively so a repeated mention appears once.
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

export function LeadQualification({ lead, onOverride, saving }: LeadQualificationProps) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const dimensions = orderedDimensions(lead);
  if (dimensions.length === 0) return null;

  const max = dimensionMax(dimensions.length);
  const scoreOptions = Array.from({ length: max + 1 }, (_, score) => ({
    value: String(score),
    label: String(score),
  }));

  const evidence = dimensions
    .map((dimension) => ({
      label: dimension.label,
      values: statedValues(lead.signals, dimension.key),
      fallback: dimension.value,
    }))
    .filter((entry) => entry.values.length > 0 || entry.fallback);

  async function apply(dimension: string, label: string, score: number): Promise<void> {
    setError(null);
    setSaved(null);
    try {
      await onOverride({ dimension, score });
      setSaved(`${label} set to ${score} out of ${max}.`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'That score could not be saved. Try again.',
      );
    }
  }

  return (
    <LeadSection
      title="What we learned"
      actions={
        // Stated once, on one affordance. It used to be a `Badge` reading "You
        // can correct these" — a state label wearing the job of an affordance
        // hint — carrying this same tooltip.
        <Tooltip content="Recorded against your account; recalculates the score.">
          <button
            type="button"
            aria-label="About correcting a score"
            className="flex h-6 w-6 items-center justify-center rounded-xs text-text-tertiary hover:text-text-primary"
          >
            <Info aria-hidden className="h-icon-sm w-icon-sm" />
          </button>
        </Tooltip>
      }
    >
      {error ? (
        <Alert tone="danger" live className="mb-2">
          {error}
        </Alert>
      ) : null}
      {/* Announced, not just shown: the score select is the only thing that
          moved, and a sighted user sees the number change while a screen-reader
          user would otherwise get nothing at all. */}
      {saved && !error ? (
        <Alert tone="success" live className="mb-2">
          {saved}
        </Alert>
      ) : null}

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
              {/* Boxed to a width: `Select` wraps itself in a `w-full` element,
                  which would otherwise take the whole row. */}
              <span className="w-20 shrink-0">
                <Select
                  size="sm"
                  label={`${dimension.label} score out of ${max}`}
                  value={String(Math.min(dimension.score, max))}
                  options={scoreOptions}
                  disabled={saving}
                  onValueChange={(value) => void apply(dimension.key, dimension.label, Number(value))}
                />
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
