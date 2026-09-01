import { memo } from 'react';
import { ABSENT, Badge, Card, CardBody, CardHeader, CardSection, Eyebrow, Grid, Tooltip } from '../../../ui';
import { NumberField } from './NumberField';
import { TIERS } from './qualification.config';
import { bandsFor, type QualThresholds, type QualValidation } from './qualification.model';

export interface ThresholdsSectionProps {
  thresholds: QualThresholds;
  onChange: (next: QualThresholds) => void;
  validation: QualValidation;
  disabled?: boolean;
}

/**
 * Tier thresholds — the composite score at which a lead is promoted.
 *
 * The composite is clamped to 0–100 server-side, so the bands below are the
 * whole space: a threshold above 100, or out of order, produces a tier that can
 * never fire. Both are refused at save with the specific reason on the specific
 * field, rather than a 422 the customer has to decode after the fact.
 *
 * No per-field hints. `Field` renders a hint *below* its control, so three
 * fields whose hints were six, four and six words made a three-column grid with
 * visibly ragged bottoms and the next row's labels starting at three different
 * heights. Each tier's meaning is a `Tooltip` on its own band below instead.
 */
function ThresholdsSectionInner({
  thresholds,
  onChange,
  validation,
  disabled = false,
}: ThresholdsSectionProps) {
  const bands = bandsFor(thresholds);

  return (
    <Card>
      <CardHeader title="Tier thresholds" titleAs="h2" description="The score to reach. Always 0 to 100." />
      <CardBody>
        <Grid cols={3}>
          {TIERS.map((tier) => (
            <NumberField
              key={tier.key}
              label={`${tier.label} at`}
              error={validation.thresholds[tier.key] ?? null}
              value={thresholds[tier.key]}
              min={0}
              max={100}
              step={1}
              disabled={disabled}
              onChange={(raw) => {
                const parsed = Math.round(Number(raw));
                onChange({
                  ...thresholds,
                  [tier.key]: Number.isFinite(parsed) ? parsed : thresholds[tier.key],
                });
              }}
            />
          ))}
        </Grid>
      </CardBody>
      <CardSection tone="sunken">
        <Eyebrow>What that produces</Eyebrow>
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {bands.map((band) => {
            const unreachable = band.to < band.from;
            const meaning = TIERS.find((tier) => tier.label === band.label)?.meaning;
            return (
              <li key={band.label} className="flex items-center gap-2">
                {meaning ? (
                  <Tooltip content={meaning}>
                    <Badge tone={band.tone} dot>
                      {band.label}
                    </Badge>
                  </Tooltip>
                ) : (
                  <Badge tone={band.tone} dot>
                    {band.label}
                  </Badge>
                )}
                {/* `.figure` is Geist Mono with tabular numerals — for numbers.
                    "unreachable" set in it was a word pretending to be a figure,
                    so the absent range is `—` and the word is a badge. */}
                <span className="figure text-xs text-text-secondary">
                  {unreachable ? ABSENT : `${band.from}–${band.to}`}
                </span>
                {unreachable ? <Badge tone="danger">Unreachable</Badge> : null}
              </li>
            );
          })}
        </ul>
      </CardSection>
    </Card>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const ThresholdsSection = memo(ThresholdsSectionInner);
