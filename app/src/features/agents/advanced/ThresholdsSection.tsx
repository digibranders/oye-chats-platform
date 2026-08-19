import { memo } from 'react';
import { Badge, Card, CardBody, CardHeader, CardSection } from '../../../ui';
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
      <CardHeader
        title="Tier thresholds"
        titleAs="h2"
        description="Where a lead's score has to reach before it is promoted. The score is always between 0 and 100."
      />
      <CardBody className="grid gap-4 sm:grid-cols-3">
        {TIERS.map((tier) => (
          <NumberField
            key={tier.key}
            label={`${tier.label} at`}
            hint={tier.meaning}
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
      </CardBody>
      <CardSection className="bg-surface-sunken">
        <p className="font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
          What that produces
        </p>
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {bands.map((band) => (
            <li key={band.label} className="flex items-center gap-2">
              <Badge tone={band.tone} dot>
                {band.label}
              </Badge>
              <span className="figure text-xs text-text-secondary">
                {band.to < band.from ? 'unreachable' : `${band.from}–${band.to}`}
              </span>
            </li>
          ))}
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
