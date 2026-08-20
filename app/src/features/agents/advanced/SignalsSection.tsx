import { memo } from 'react';
import { Alert, Card, CardBody, CardHeader, CardSection, Field, Grid, Switch, TagInput } from '../../../ui';
import { NumberField } from './NumberField';
import { toLabel } from './qualification.model';
import type { BehavioralConfig, QualDecay, QualModel, QualValidation } from './qualification.model';

export interface SignalsSectionProps {
  model: QualModel;
  onDecayChange: (next: QualDecay) => void;
  onBehavioralChange: (next: BehavioralConfig) => void;
  validation: QualValidation;
  disabled?: boolean;
}

function toInt(raw: string, fallback: number): number {
  const parsed = Math.round(Number(raw));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

/**
 * A card header's on/off state, as a word beside the switch.
 *
 * `hideLabel` is documented for a table's select-row cell. Alone in a card
 * header it leaves a sighted reader a bare 20×36 toggle with nothing next to it,
 * and whether the card below is live is the single most important fact about it.
 */
function SwitchAction({
  on,
  label,
  onChange,
  disabled,
}: {
  on: boolean;
  label: string;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-xs text-text-secondary">{on ? 'On' : 'Off'}</span>
      <Switch checked={on} onCheckedChange={onChange} label={label} hideLabel disabled={disabled} />
    </span>
  );
}

/**
 * The two adjustments that sit outside the conversation itself: decay, and
 * behaviour.
 *
 * Both were previously buried in a modal, and both were wrong about their own
 * scope.
 *
 * **Decay** was shown for BANT only, with two hard-coded fields.
 * `lead_service.apply_display_decay` reads `{dimension}_decay_per_30d` for every
 * dimension in the active framework, so a MEDDIC chatbot has six decay rates
 * that were simply unreachable. Every rate is editable here, including the
 * zeros — the server merges its own BANT defaults *under* a stored decay object,
 * so a rate the payload omits comes back as 5, not 0.
 *
 * **Behavioural points** were presented as part of the score. They are not part
 * of the score the tier email and webhook fire on. See the notice below.
 *
 * No per-field hints in the grids: `Field` renders a hint below its control, so
 * three of eight cells were ~22px taller than the rest and every row of the grid
 * had a ragged bottom.
 */
function SignalsSectionInner({
  model,
  onDecayChange,
  onBehavioralChange,
  validation,
  disabled = false,
}: SignalsSectionProps) {
  const { decay, behavioral } = model;

  return (
    <>
      <Card>
        <CardHeader
          title="Score decay"
          titleAs="h2"
          description="Lower a stale lead’s score over time."
          actions={
            <SwitchAction
              on={decay.enabled}
              label="Apply score decay"
              disabled={disabled}
              onChange={(next) => onDecayChange({ ...decay, enabled: next })}
            />
          }
        />
        {decay.enabled ? (
          <CardBody>
            <p className="mb-4 max-w-reading text-xs text-text-secondary">
              Points removed per 30 days. Recorded answers are never rewritten.
            </p>
            <Grid cols={3}>
              {model.order.map((key) => (
                <NumberField
                  key={key}
                  label={model.dimensions[key]?.label ?? toLabel(key)}
                  unitLabel="points per 30 days"
                  value={decay.rates[key] ?? 0}
                  min={0}
                  max={100}
                  step={1}
                  disabled={disabled}
                  onChange={(raw) =>
                    onDecayChange({
                      ...decay,
                      rates: { ...decay.rates, [key]: toInt(raw, decay.rates[key] ?? 0) },
                    })
                  }
                />
              ))}
            </Grid>
          </CardBody>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Behavioural points"
          titleAs="h2"
          description="Points for how a visitor arrived and browsed."
          actions={
            <SwitchAction
              on={behavioral.enabled}
              label="Award behavioural points"
              disabled={disabled}
              onChange={(next) => onBehavioralChange({ ...behavioral, enabled: next })}
            />
          }
        />
        <CardSection>
          <Alert tone="neutral" title="These points do not trigger the tier email or webhook">
            They show on Leads, but the qualified-lead email and the{' '}
            <span className="figure">tier_transition</span> webhook fire on the conversation score
            alone.
          </Alert>
        </CardSection>
        {behavioral.enabled ? (
          <>
            <CardSection>
              <Grid cols={3}>
                <NumberField
                  label="Maximum from behaviour"
                  error={validation.behavioralMaxScore}
                  value={behavioral.max_score}
                  min={0}
                  max={100}
                  disabled={disabled}
                  onChange={(raw) =>
                    onBehavioralChange({ ...behavioral, max_score: toInt(raw, behavioral.max_score) })
                  }
                />
                <NumberField
                  label="Came back"
                  value={behavioral.return_visit_score}
                  min={0}
                  max={100}
                  disabled={disabled}
                  onChange={(raw) =>
                    onBehavioralChange({
                      ...behavioral,
                      return_visit_score: toInt(raw, behavioral.return_visit_score),
                    })
                  }
                />
                <NumberField
                  label="Arrived from a campaign"
                  value={behavioral.utm_present_score}
                  min={0}
                  max={100}
                  disabled={disabled}
                  onChange={(raw) =>
                    onBehavioralChange({
                      ...behavioral,
                      utm_present_score: toInt(raw, behavioral.utm_present_score),
                    })
                  }
                />
                <NumberField
                  label="Time on site to count"
                  unitLabel="seconds"
                  value={behavioral.time_on_site_threshold}
                  min={0}
                  max={7200}
                  step={5}
                  disabled={disabled}
                  onChange={(raw) =>
                    onBehavioralChange({
                      ...behavioral,
                      time_on_site_threshold: toInt(raw, behavioral.time_on_site_threshold),
                    })
                  }
                />
                <NumberField
                  label="Points for that time"
                  value={behavioral.time_on_site_score}
                  min={0}
                  max={100}
                  disabled={disabled}
                  onChange={(raw) =>
                    onBehavioralChange({
                      ...behavioral,
                      time_on_site_score: toInt(raw, behavioral.time_on_site_score),
                    })
                  }
                />
                <NumberField
                  label="Pages viewed to count"
                  value={behavioral.pages_viewed_threshold}
                  min={0}
                  max={500}
                  disabled={disabled}
                  onChange={(raw) =>
                    onBehavioralChange({
                      ...behavioral,
                      pages_viewed_threshold: toInt(raw, behavioral.pages_viewed_threshold),
                    })
                  }
                />
                <NumberField
                  label="Points for those pages"
                  value={behavioral.pages_viewed_score}
                  min={0}
                  max={100}
                  disabled={disabled}
                  onChange={(raw) =>
                    onBehavioralChange({
                      ...behavioral,
                      pages_viewed_score: toInt(raw, behavioral.pages_viewed_score),
                    })
                  }
                />
                <NumberField
                  label="Points for a known referrer"
                  value={behavioral.known_referrer_score}
                  min={0}
                  max={100}
                  disabled={disabled}
                  onChange={(raw) =>
                    onBehavioralChange({
                      ...behavioral,
                      known_referrer_score: toInt(raw, behavioral.known_referrer_score),
                    })
                  }
                />
              </Grid>
            </CardSection>
            <CardSection>
              <Field
                label="Known referrers"
                hint="Matched as a substring, so google.com also covers news.google.com."
                disabled={disabled}
              >
                <TagInput
                  label="Known referrers"
                  values={behavioral.known_referrers}
                  onValuesChange={(values) =>
                    onBehavioralChange({ ...behavioral, known_referrers: values })
                  }
                  placeholder="example.com"
                  normalize={(value) => value.trim().toLowerCase().replace(/^https?:\/\//, '')}
                  validate={(value) =>
                    /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) ? null : `“${value}” is not a domain.`
                  }
                  disabled={disabled}
                />
              </Field>
            </CardSection>
          </>
        ) : null}
      </Card>
    </>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const SignalsSection = memo(SignalsSectionInner);
