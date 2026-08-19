import { useState, memo } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  Field,
  Input,
  Switch,
  cn,
  formatPercent,
} from '../../../ui';
import { NumberField } from './NumberField';
import { listensFor } from './qualification.config';
import {
  type QualDimension,
  type QualModel,
  type QualValidation,
  balanceWeights,
  effectiveShare,
  makeDimension,
  normalizeDimensionKey,
  toLabel,
  weightTotal,
} from './qualification.model';

export interface DimensionsSectionProps {
  model: QualModel;
  onChange: (next: QualModel) => void;
  validation: QualValidation;
  /**
   * Dimension keys that belong to the server's preset for this framework.
   *
   * They can be switched off but not deleted, and the UI has to say so —
   * `get_framework_config` deep-merges the preset *under* the stored config
   * (api/app/services/qualification_service.py), so a removed preset dimension
   * comes straight back at scoring time. A delete control there would be a
   * button that silently does nothing.
   */
  presetKeys: readonly string[];
  disabled?: boolean;
}

/** Parse a numeric input string into a clamped whole number. */
function toInt(raw: string, min: number, max: number): number {
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * The scoring model: which dimensions count, how much each is worth, and what
 * the AI is listening for in each one.
 *
 * The editor it replaces was a modal with an "Apply" button that fed a second
 * draft into the page's draft — two levels of pending state over one save, so a
 * customer could apply changes, navigate away, and be warned about unsaved work
 * they had already been told was applied. It is inline now: one draft, one Save
 * bar, one meaning for "unsaved".
 *
 * The weight readout is the other change. Weights here are **relative**: the
 * server divides each by the total across enabled dimensions
 * (`calculate_composite_score`), so 25/25/25/25 and 10/10/10/10 score
 * identically. The total is shown because it is the number people reason about,
 * but each row also states the share it actually carries — which is the figure
 * that decides a lead's tier.
 */
function DimensionsSectionInner({
  model,
  onChange,
  validation,
  presetKeys,
  disabled = false,
}: DimensionsSectionProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const total = weightTotal(model);
  const enabledCount = model.order.filter((key) => model.dimensions[key]?.enabled).length;

  const patchDimension = (key: string, patch: Partial<QualDimension>): void => {
    const current = model.dimensions[key];
    if (!current) return;
    onChange({ ...model, dimensions: { ...model.dimensions, [key]: { ...current, ...patch } } });
  };

  const patchOption = (key: string, index: number, patch: Partial<{ label: string; score: number }>): void => {
    const dim = model.dimensions[key];
    if (!dim) return;
    patchDimension(key, {
      options: dim.options.map((option, i) => (i === index ? { ...option, ...patch } : option)),
    });
  };

  const addOption = (key: string): void => {
    const dim = model.dimensions[key];
    if (!dim) return;
    patchDimension(key, { options: [...dim.options, { label: '', score: 0 }] });
  };

  const removeOption = (key: string, index: number): void => {
    const dim = model.dimensions[key];
    if (!dim) return;
    patchDimension(key, { options: dim.options.filter((_, i) => i !== index) });
  };

  const addDimension = (): void => {
    const { key, dimension } = makeDimension(model.order);
    onChange({
      ...model,
      order: [...model.order, key],
      dimensions: { ...model.dimensions, [key]: dimension },
    });
    setExpanded((previous) => new Set(previous).add(key));
  };

  const removeDimension = (key: string): void => {
    const dimensions = { ...model.dimensions };
    delete dimensions[key];
    onChange({ ...model, order: model.order.filter((k) => k !== key), dimensions });
  };

  /** Re-key a custom dimension from its label on blur, not per keystroke. */
  const commitRename = (key: string): void => {
    const dim = model.dimensions[key];
    if (!dim) return;
    const nextKey = normalizeDimensionKey(dim.label);
    if (!nextKey || nextKey === key || model.dimensions[nextKey]) return;
    const dimensions: Record<string, QualDimension> = {};
    for (const k of model.order) {
      const value = model.dimensions[k];
      if (value) dimensions[k === key ? nextKey : k] = value;
    }
    onChange({
      ...model,
      order: model.order.map((k) => (k === key ? nextKey : k)),
      dimensions,
    });
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.delete(key)) next.add(nextKey);
      return next;
    });
  };

  const toggleExpanded = (key: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Card>
      <CardHeader
        title="Scoring dimensions"
        titleAs="h2"
        description="What the chatbot listens for while it talks, and how much each answer moves the lead's score."
        actions={
          <Button size="sm" variant="secondary" onClick={addDimension} disabled={disabled}>
            <Plus aria-hidden className="h-3.5 w-3.5" />
            Add dimension
          </Button>
        }
      />

      <CardSection className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 bg-surface-sunken">
        <div className="min-w-0">
          <p className="text-base font-medium text-text-primary">
            <span className="figure">{total}</span> across{' '}
            <span className="figure">{enabledCount}</span>{' '}
            {enabledCount === 1 ? 'dimension' : 'dimensions'}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
            {total === 100
              ? 'Weights total 100, so each weight is also its share of the score.'
              : 'Weights are relative — the score divides each by this total — so this set works as it is. Balancing to 100 just makes each weight readable as a percentage.'}
          </p>
        </div>
        {total !== 100 && total > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(balanceWeights(model))}
            disabled={disabled}
          >
            Balance to 100
          </Button>
        ) : null}
      </CardSection>

      {model.order.length === 0 ? (
        <CardBody>
          <Alert tone="danger" title="This chatbot has no scoring dimensions">
            Nothing is being measured, so every visitor scores 0 and no lead can reach a tier. Add a
            dimension, or switch back to a framework preset above.
          </Alert>
        </CardBody>
      ) : null}

      {model.order.map((key) => {
        const dim = model.dimensions[key];
        if (!dim) return null;
        const isPreset = presetKeys.includes(key);
        const isOpen = expanded.has(key);
        const share = effectiveShare(model, key);
        const error = validation.dimensions[key] ?? null;

        return (
          <CardSection key={key}>
            <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
              <button
                type="button"
                onClick={() => toggleExpanded(key)}
                aria-expanded={isOpen}
                aria-controls={`dimension-panel-${key}`}
                className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                <ChevronDown
                  aria-hidden
                  className={cn('h-4 w-4 transition-transform', isOpen ? 'rotate-0' : '-rotate-90')}
                />
                <span className="sr-only">
                  {isOpen ? `Collapse ${dim.label}` : `Expand ${dim.label}`}
                </span>
              </button>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-base font-medium text-text-primary">{dim.label}</p>
                  {isPreset ? null : <Badge tone="neutral">Added by you</Badge>}
                  {dim.enabled && share !== null ? (
                    <span className="figure text-xs text-text-secondary">
                      {formatPercent(share / 100)} of the score
                    </span>
                  ) : (
                    <Badge tone="neutral">Not scored</Badge>
                  )}
                </div>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-secondary">
                  {listensFor(key)}
                </p>
              </div>

              <div className="w-24 shrink-0">
                <NumberField
                  label="Weight"
                  value={dim.weight}
                  min={0}
                  max={100}
                  step={1}
                  disabled={disabled || !dim.enabled}
                  onChange={(raw) => patchDimension(key, { weight: toInt(raw, 0, 100) })}
                />
              </div>

              <div className="flex shrink-0 items-center gap-1 pt-6">
                <Switch
                  checked={dim.enabled}
                  onCheckedChange={(next) => patchDimension(key, { enabled: next })}
                  label={`Score ${dim.label}`}
                  hideLabel
                  disabled={disabled}
                />
                {isPreset ? (
                  // No dimmed, undeleteable trash icon standing in for an
                  // explanation. Why a framework dimension cannot be removed is
                  // a sentence, and it is in the panel below where a keyboard
                  // user actually reaches it.
                  <span aria-hidden className="h-6 w-6" />
                ) : (
                  <button
                    type="button"
                    onClick={() => removeDimension(key)}
                    disabled={disabled}
                    aria-label={`Remove ${dim.label}`}
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-text-tertiary transition-colors hover:bg-danger-tint hover:text-danger disabled:opacity-50"
                  >
                    <Trash2 aria-hidden className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {error ? (
              <p
                role="status"
                aria-live="polite"
                className="mt-3 text-xs leading-relaxed text-danger"
              >
                {error}
              </p>
            ) : null}

            <div id={`dimension-panel-${key}`} hidden={!isOpen} className="mt-4 space-y-4">
              {isPreset ? (
                <p className="max-w-2xl text-xs leading-relaxed text-text-secondary">
                  {dim.label} belongs to this framework, so it cannot be deleted — the server
                  restores its own preset dimensions on every read, and a delete here would be a
                  button that silently did nothing. Switching it off is what stops it being scored.
                </p>
              ) : (
                <Field
                  label="Dimension name"
                  hint="Renaming re-keys this dimension. Scores already recorded under the old name stay on their leads."
                  className="max-w-sm"
                  disabled={disabled}
                >
                  <Input
                    value={dim.label}
                    onChange={(event) => patchDimension(key, { label: event.target.value })}
                    onBlur={() => commitRename(key)}
                  />
                </Field>
              )}

              <div className="space-y-2">
                <p className="font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
                  Answers and what they score
                </p>
                <ul className="space-y-2">
                  {dim.options.map((option, index) => (
                    <li key={index} className="flex items-end gap-2">
                      {/* The label is hidden but names the dimension as well as
                          the row: a column of forty inputs all called "Answer 2"
                          is unusable on a screen reader. */}
                      <Field
                        label={`Answer ${index + 1} for ${dim.label}`}
                        hideLabel
                        className="flex-1"
                        disabled={disabled}
                      >
                        <Input
                          value={option.label}
                          placeholder="What the visitor said"
                          onChange={(event) => patchOption(key, index, { label: event.target.value })}
                        />
                      </Field>
                      <Field
                        label={`Score for answer ${index + 1} of ${dim.label}`}
                        hideLabel
                        className="w-20"
                        disabled={disabled}
                      >
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={100}
                          value={option.score}
                          onChange={(event) =>
                            patchOption(key, index, { score: toInt(event.target.value, 0, 100) })
                          }
                        />
                      </Field>
                      <button
                        type="button"
                        onClick={() => removeOption(key, index)}
                        disabled={disabled}
                        aria-label={`Remove answer ${index + 1} from ${dim.label}`}
                        className="mb-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-tertiary transition-colors hover:bg-danger-tint hover:text-danger disabled:opacity-50"
                      >
                        <Trash2 aria-hidden className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
                <Button size="sm" variant="ghost" onClick={() => addOption(key)} disabled={disabled}>
                  <Plus aria-hidden className="h-3.5 w-3.5" />
                  Add answer
                </Button>
              </div>

              <div className="space-y-3 border-t border-border pt-3">
                <Switch
                  checked={dim.cta_enabled}
                  onCheckedChange={(next) => patchDimension(key, { cta_enabled: next })}
                  label="Ask the visitor directly"
                  description="Instead of waiting to infer this from the conversation, offer the answers above as quick-reply chips."
                  disabled={disabled}
                />
                {dim.cta_enabled ? (
                  <Field
                    label="The question to ask"
                    hint="Keep it short — it is shown above the chips."
                    className="max-w-lg"
                    disabled={disabled}
                  >
                    <Input
                      value={dim.cta_prompt}
                      placeholder={`What best describes your ${toLabel(key).toLowerCase()}?`}
                      onChange={(event) => patchDimension(key, { cta_prompt: event.target.value })}
                    />
                  </Field>
                ) : null}
              </div>
            </div>
          </CardSection>
        );
      })}
    </Card>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const DimensionsSection = memo(DimensionsSectionInner);
