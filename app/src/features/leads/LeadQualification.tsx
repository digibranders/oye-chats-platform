import { useState } from 'react';
import { Alert, Badge, Progress, Select, Tooltip } from '../../ui';
import type { Lead, LeadSignal } from '../../types/domain';
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
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-text-primary">What we learned</h3>
        <Tooltip content="Correcting a score here is recorded against your account and recalculates the lead's quality.">
          <span className="inline-flex">
            <Badge>You can correct these</Badge>
          </span>
        </Tooltip>
      </div>

      {error ? (
        <Alert tone="danger" live>
          {error}
        </Alert>
      ) : null}
      {/* Announced, not just shown: the score select is the only thing that
          moved, and a sighted user sees the number change while a screen-reader
          user would otherwise get nothing at all. */}
      {saved && !error ? (
        <Alert tone="success" live>
          {saved}
        </Alert>
      ) : null}

      <ul className="space-y-2.5">
        {dimensions.map((dimension) => {
          const values = statedValues(lead.signals, dimension.key);
          // Clamped for the bar only. An unevenly-weighted dimension can exceed
          // the equal-weight ceiling, and the text below reports it honestly
          // rather than moving the goalposts.
          const percent = Math.min((dimension.score / max) * 100, 100);
          return (
            <li key={dimension.key} className="rounded-md border border-border px-3.5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <span className="text-base font-medium text-text-primary">{dimension.label}</span>
                <div className="flex items-center gap-2">
                  <span className="figure text-xs text-text-secondary">
                    {dimension.score} / {max}
                  </span>
                  {/* Boxed to a width: `Select` wraps itself in a `w-full`
                      element, which would otherwise take the whole row. */}
                  <div className="w-20">
                    <Select
                      size="sm"
                      aria-label={`${dimension.label} score out of ${max}`}
                      value={String(Math.min(dimension.score, max))}
                      options={scoreOptions}
                      disabled={saving}
                      onChange={(event) =>
                        void apply(dimension.key, dimension.label, Number(event.target.value))
                      }
                    />
                  </div>
                </div>
              </div>

              <Progress
                className="mt-2"
                size="sm"
                value={percent}
                label={`${dimension.label}: ${dimension.score} out of ${max}`}
                tone={dimension.captured ? 'success' : 'accent'}
              />

              {values.length > 1 ? (
                <ul className="mt-2 space-y-1">
                  {values.map((value) => (
                    <li key={value} className="flex gap-2 text-prose text-text-secondary">
                      <span
                        aria-hidden
                        className="mt-2 h-1 w-1 shrink-0 rounded-full bg-text-tertiary"
                      />
                      <span>{value}</span>
                    </li>
                  ))}
                </ul>
              ) : (values[0] ?? dimension.value) ? (
                <p className="mt-2 text-prose text-text-secondary">
                  {values[0] ?? dimension.value}
                </p>
              ) : (
                <p className="mt-2 text-xs text-text-tertiary">
                  Nothing captured for this yet.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
