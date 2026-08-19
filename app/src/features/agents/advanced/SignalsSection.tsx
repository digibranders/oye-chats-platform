import { memo } from 'react';
import { Alert, Card, CardBody, CardHeader, CardSection, Field, Switch, TagInput } from '../../../ui';
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
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Score decay"
          titleAs="h2"
          description="Lower a stale lead's score as time passes, so fresh intent ranks above a conversation from three months ago."
          actions={
            <Switch
              checked={decay.enabled}
              onCheckedChange={(next) => onDecayChange({ ...decay, enabled: next })}
              label="Apply score decay"
              hideLabel
              disabled={disabled}
            />
          }
        />
        <CardBody>
          {decay.enabled ? (
            <>
              <p className="mb-4 max-w-2xl text-prose text-text-secondary">
                Points removed from each dimension for every 30 days since it was last assessed. This
                affects what you see on Leads; the recorded answers are never rewritten.
              </p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
              </div>
            </>
          ) : (
            <p className="max-w-2xl text-prose text-text-secondary">
              Off. A lead scored six months ago ranks exactly as high as one scored this morning.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Behavioural points"
          titleAs="h2"
          description="Points for how a visitor arrived and how they browsed, before they have said anything at all."
          actions={
            <Switch
              checked={behavioral.enabled}
              onCheckedChange={(next) => onBehavioralChange({ ...behavioral, enabled: next })}
              label="Award behavioural points"
              hideLabel
              disabled={disabled}
            />
          }
        />
        <CardSection>
          <Alert tone="neutral" title="These points do not trigger the tier email or webhook">
            Behavioural points are added to the score shown on Leads, but the qualified-lead email
            and the <span className="figure">tier_transition</span> webhook fire on the conversation
            score alone. A visitor can therefore appear as sales-qualified in Leads without either
            having been sent.
          </Alert>
        </CardSection>
        {behavioral.enabled ? (
          <>
            <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField
                label="Maximum from behaviour"
                hint="The cap on everything below, added together."
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
                hint="Awarded on any visit after the first."
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
                hint="Awarded when the page carries UTM parameters."
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
            </CardBody>
            <CardSection>
              <Field
                label="Known referrers"
                hint="A visitor arriving from any of these earns the referrer points. Matched as a substring of the referring domain, so “google.com” also covers news.google.com."
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
        ) : (
          <CardBody>
            <p className="max-w-2xl text-prose text-text-secondary">
              Off. Every visitor starts at zero and only what they say in the conversation counts.
            </p>
          </CardBody>
        )}
      </Card>
    </div>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const SignalsSection = memo(SignalsSectionInner);
