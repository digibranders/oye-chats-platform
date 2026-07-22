import { type ReactElement, useState } from 'react';
import {
  Plus,
  Trash2,
  ChevronDown,
  AlertTriangle,
  Gauge,
  Timer,
  Activity,
  X,
} from 'lucide-react';
import { Modal, Button, Input, cn } from '../../../design-system';
import { Toggle, NumberField } from './controls';
import {
  type QualModel,
  type QualDimension,
  parseModel,
  serializeModel,
  enabledWeightTotal,
  makeDimension,
  normalizeDimensionKey,
} from './qualification.model';

interface QualificationEditorProps {
  open: boolean;
  onClose: () => void;
  /** Current framework key — gates custom-only affordances (rename/add/remove). */
  framework: string;
  /** The bot's current `bant_config` (or null → BANT defaults). */
  config: Record<string, unknown> | null;
  /** Commit the edited model back to the page draft (does not persist to the server). */
  onApply: (nextConfig: Record<string, unknown>) => void;
}

/** Parse a numeric input string to a clamped, finite integer. */
function toInt(raw: string, min: number): number {
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed)) return min;
  return Math.max(parsed, min);
}

/**
 * QualificationEditor — the full `bant_config` editor. Opens in a modal so the
 * heavy scoring model gets a focused, roomy surface instead of crowding the
 * Advanced page. Edits a local working copy; "Apply" hands the result back to the
 * page draft, which owns persistence via its single save bar.
 *
 * Covers every slice of the config: per-dimension enable/weight/options + CTA,
 * tier thresholds, score decay, and behavioural scoring. Custom frameworks
 * additionally get dimension add/remove/rename.
 */
export function QualificationEditor({
  open,
  onClose,
  framework,
  config,
  onApply,
}: QualificationEditorProps): ReactElement | null {
  if (!open) return null;
  return (
    <Modal open onClose={onClose} title="Qualification model" size="xl">
      <EditorBody framework={framework} config={config} onApply={onApply} onClose={onClose} />
    </Modal>
  );
}

interface EditorBodyProps {
  framework: string;
  config: Record<string, unknown> | null;
  onApply: (nextConfig: Record<string, unknown>) => void;
  onClose: () => void;
}

/**
 * EditorBody holds the working model. It's mounted fresh each time the modal
 * opens (the modal unmounts its children when closed), so the `useState`
 * initializer always seeds from the latest saved config without a sync effect.
 */
function EditorBody({ framework, config, onApply, onClose }: EditorBodyProps): ReactElement {
  const isCustom = framework === 'custom';
  const [model, setModel] = useState<QualModel>(() => parseModel(config, framework));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(model.order));
  const [referrerDraft, setReferrerDraft] = useState('');

  const totalWeight = enabledWeightTotal(model);

  // ── Dimension mutators ──────────────────────────────────────────────────────
  const patchDimension = (key: string, patch: Partial<QualDimension>): void => {
    setModel((prev) => {
      const current = prev.dimensions[key];
      if (!current) return prev;
      return { ...prev, dimensions: { ...prev.dimensions, [key]: { ...current, ...patch } } };
    });
  };

  const patchOption = (key: string, index: number, patch: Partial<{ label: string; score: number }>): void => {
    setModel((prev) => {
      const dim = prev.dimensions[key];
      if (!dim) return prev;
      const options = dim.options.map((option, i) => (i === index ? { ...option, ...patch } : option));
      return { ...prev, dimensions: { ...prev.dimensions, [key]: { ...dim, options } } };
    });
  };

  const addOption = (key: string): void => {
    setModel((prev) => {
      const dim = prev.dimensions[key];
      if (!dim) return prev;
      const options = [...dim.options, { label: '', score: 0 }];
      return { ...prev, dimensions: { ...prev.dimensions, [key]: { ...dim, options } } };
    });
  };

  const removeOption = (key: string, index: number): void => {
    setModel((prev) => {
      const dim = prev.dimensions[key];
      if (!dim) return prev;
      const options = dim.options.filter((_, i) => i !== index);
      return { ...prev, dimensions: { ...prev.dimensions, [key]: { ...dim, options } } };
    });
  };

  const addDimension = (): void => {
    // Derive the new key once from the current model so the state update and the
    // auto-expand stay in lockstep.
    const { key, dimension } = makeDimension(model.order);
    setModel((prev) => ({
      ...prev,
      order: [...prev.order, key],
      dimensions: { ...prev.dimensions, [key]: dimension },
    }));
    setExpanded((prev) => new Set(prev).add(key));
  };

  const removeDimension = (key: string): void => {
    setModel((prev) => {
      const dimensions = { ...prev.dimensions };
      delete dimensions[key];
      return { ...prev, order: prev.order.filter((k) => k !== key), dimensions };
    });
  };

  // Re-key a custom dimension from its label on blur (readable keys without the
  // focus loss that live per-keystroke re-keying would cause).
  const commitDimensionRename = (key: string): void => {
    const dim = model.dimensions[key];
    if (!dim) return;
    const nextKey = normalizeDimensionKey(dim.label);
    if (!nextKey || nextKey === key || model.dimensions[nextKey]) return;
    setModel((prev) => {
      const dimensions: Record<string, QualDimension> = {};
      for (const k of prev.order) {
        dimensions[k === key ? nextKey : k] = prev.dimensions[k];
      }
      return { ...prev, order: prev.order.map((k) => (k === key ? nextKey : k)), dimensions };
    });
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.delete(key)) next.add(nextKey);
      return next;
    });
  };

  const toggleExpanded = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ── Meta mutators ───────────────────────────────────────────────────────────
  const patchThreshold = (field: keyof QualModel['thresholds'], value: number): void => {
    setModel((prev) => ({ ...prev, thresholds: { ...prev.thresholds, [field]: value } }));
  };

  const patchDecay = (patch: Partial<QualModel['decay']>): void => {
    setModel((prev) => ({ ...prev, decay: { ...prev.decay, ...patch } }));
  };

  const patchBehavioral = (patch: Partial<QualModel['behavioral']>): void => {
    setModel((prev) => ({ ...prev, behavioral: { ...prev.behavioral, ...patch } }));
  };

  const addReferrer = (): void => {
    const value = referrerDraft.trim().toLowerCase();
    if (!value) return;
    setModel((prev) =>
      prev.behavioral.known_referrers.includes(value)
        ? prev
        : {
            ...prev,
            behavioral: {
              ...prev.behavioral,
              known_referrers: [...prev.behavioral.known_referrers, value],
            },
          },
    );
    setReferrerDraft('');
  };

  const removeReferrer = (value: string): void => {
    setModel((prev) => ({
      ...prev,
      behavioral: {
        ...prev.behavioral,
        known_referrers: prev.behavioral.known_referrers.filter((item) => item !== value),
      },
    }));
  };

  const handleApply = (): void => {
    onApply(serializeModel(model));
    onClose();
  };

  const weightOk = totalWeight === 100;

  return (
    <div className="space-y-6">
      {/* Weight-sum guidance — surfaced first so it's visible before scrolling. */}
      {!weightOk && (
        <div className="flex items-start gap-2.5 rounded-lg border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] px-3.5 py-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--ds-warning)]" aria-hidden="true" />
          <p className="text-[12px] leading-relaxed text-[var(--ds-text)]">
            Enabled dimension weights sum to <strong>{totalWeight}</strong>. For balanced scoring the
            recommended total is <strong>100</strong>.
          </p>
        </div>
      )}

      {/* ── Dimensions ─────────────────────────────────────────────────────────*/}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-[var(--ds-text)]">Scoring dimensions</h3>
          {isCustom && (
            <Button variant="outline" size="sm" onClick={addDimension}>
              <Plus size={14} aria-hidden="true" />
              Add dimension
            </Button>
          )}
        </div>

        <div className="space-y-2.5">
          {model.order.map((key) => {
            const dim = model.dimensions[key];
            if (!dim) return null;
            const isOpen = expanded.has(key);
            return (
              <div
                key={key}
                className="overflow-hidden rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)]"
              >
                {/* Card header — label, weight, enable, expand, (custom) delete. */}
                <div className="flex flex-wrap items-center gap-3 bg-[var(--ds-bg-sunken)] px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(key)}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? `Collapse ${dim.label}` : `Expand ${dim.label}`}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]"
                  >
                    <ChevronDown
                      size={16}
                      aria-hidden="true"
                      className={cn('transition-transform', isOpen ? 'rotate-0' : '-rotate-90')}
                    />
                  </button>

                  <div className="min-w-0 flex-1">
                    {isCustom ? (
                      <Input
                        value={dim.label}
                        aria-label={`Dimension name for ${dim.label}`}
                        onChange={(event) => patchDimension(key, { label: event.target.value })}
                        onBlur={() => commitDimensionRename(key)}
                        className="h-8 max-w-xs text-[13px] font-semibold"
                      />
                    ) : (
                      <span className="truncate text-[14px] font-semibold text-[var(--ds-text)]">
                        {dim.label}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <label
                      htmlFor={`weight-${key}`}
                      className="text-[11px] font-semibold text-[var(--ds-text-subtle)]"
                    >
                      Weight
                    </label>
                    <Input
                      id={`weight-${key}`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={100}
                      value={dim.weight}
                      onChange={(event) => patchDimension(key, { weight: toInt(event.target.value, 0) })}
                      className="h-8 w-16 text-center text-[13px] font-semibold"
                    />
                    <span className="text-[11px] text-[var(--ds-text-subtle)]">/ 100</span>
                  </div>

                  <Toggle
                    checked={dim.enabled}
                    onChange={(next) => patchDimension(key, { enabled: next })}
                    label={`Enable ${dim.label} scoring`}
                  />

                  {isCustom && (
                    <button
                      type="button"
                      onClick={() => removeDimension(key)}
                      aria-label={`Remove ${dim.label}`}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-danger-soft)] hover:text-[var(--ds-danger)]"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>

                {/* Card body — options + CTA. */}
                {isOpen && (
                  <div className="space-y-4 px-4 py-4">
                    <div className="space-y-2">
                      <div className="grid grid-cols-[1fr_88px_32px] items-center gap-3 px-0.5">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
                          Option label
                        </span>
                        <span className="text-center text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
                          Score
                        </span>
                        <span aria-hidden="true" />
                      </div>
                      {dim.options.map((option, index) => (
                        <div key={index} className="grid grid-cols-[1fr_88px_32px] items-center gap-3">
                          <Input
                            value={option.label}
                            placeholder="Option label"
                            aria-label={`Option ${index + 1} label for ${dim.label}`}
                            onChange={(event) => patchOption(key, index, { label: event.target.value })}
                            className="h-9"
                          />
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={100}
                            value={option.score}
                            aria-label={`Option ${index + 1} score for ${dim.label}`}
                            onChange={(event) => patchOption(key, index, { score: toInt(event.target.value, 0) })}
                            className="h-9 text-center font-semibold"
                          />
                          <button
                            type="button"
                            onClick={() => removeOption(key, index)}
                            aria-label={`Remove option ${index + 1} from ${dim.label}`}
                            className="flex h-9 w-8 items-center justify-center rounded-md text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-danger-soft)] hover:text-[var(--ds-danger)]"
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addOption(key)}
                        className="inline-flex items-center gap-1.5 pt-1 text-[12px] font-semibold text-[var(--ds-accent-text)] transition-colors hover:text-[var(--ds-accent)]"
                      >
                        <Plus size={13} aria-hidden="true" />
                        Add option
                      </button>
                    </div>

                    {/* CTA */}
                    <div className="space-y-3 border-t border-[var(--ds-border)] pt-3">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-[var(--ds-text)]">Show CTA chips</p>
                          <p className="mt-0.5 text-[12px] text-[var(--ds-text-subtle)]">
                            Ask the visitor this directly with quick-reply chips.
                          </p>
                        </div>
                        <Toggle
                          checked={dim.cta_enabled}
                          onChange={(next) => patchDimension(key, { cta_enabled: next })}
                          label={`Show CTA chips for ${dim.label}`}
                        />
                      </div>
                      {dim.cta_enabled && (
                        <Input
                          value={dim.cta_prompt}
                          placeholder="CTA prompt shown to the visitor"
                          aria-label={`CTA prompt for ${dim.label}`}
                          onChange={(event) => patchDimension(key, { cta_prompt: event.target.value })}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Tier thresholds ────────────────────────────────────────────────────*/}
      <section className="space-y-3 border-t border-[var(--ds-border)] pt-5">
        <div className="flex items-center gap-2">
          <Gauge size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
          <h3 className="text-[13px] font-semibold text-[var(--ds-text)]">Tier thresholds</h3>
        </div>
        <p className="text-[12px] text-[var(--ds-text-subtle)]">
          The composite score at which a lead is promoted to each tier.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumberField
            id="threshold-mql"
            label="MQL threshold"
            value={model.thresholds.mql}
            step={1}
            min={0}
            onChange={(raw) => patchThreshold('mql', toInt(raw, 0))}
          />
          <NumberField
            id="threshold-sal"
            label="SAL threshold"
            value={model.thresholds.sal}
            step={1}
            min={0}
            onChange={(raw) => patchThreshold('sal', toInt(raw, 0))}
          />
          <NumberField
            id="threshold-sql"
            label="SQL threshold"
            value={model.thresholds.sql}
            step={1}
            min={0}
            onChange={(raw) => patchThreshold('sql', toInt(raw, 0))}
          />
        </div>
      </section>

      {/* ── Score decay ────────────────────────────────────────────────────────
          Decay is applied by the backend per `{dimension}_decay_per_30d`, and
          these two knobs write `timeline_`/`need_` — which only exist on BANT.
          For every other framework they'd map to non-existent dimensions and
          silently no-op, so the section is shown only for BANT. */}
      {framework === 'bant' && (
        <section className="space-y-3 border-t border-[var(--ds-border)] pt-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Timer size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
              <h3 className="text-[13px] font-semibold text-[var(--ds-text)]">Score decay</h3>
            </div>
            <Toggle
              checked={model.decay.enabled}
              onChange={(next) => patchDecay({ enabled: next })}
              label="Enable score decay"
            />
          </div>
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            Gradually lower stale lead scores over time so fresh intent ranks higher.
          </p>
          {model.decay.enabled && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumberField
                id="decay-timeline"
                label="Timeline decay per 30 days"
                value={model.decay.timeline_decay_per_30d}
                step={1}
                min={0}
                onChange={(raw) => patchDecay({ timeline_decay_per_30d: toInt(raw, 0) })}
              />
              <NumberField
                id="decay-need"
                label="Need decay per 30 days"
                value={model.decay.need_decay_per_30d}
                step={1}
                min={0}
                onChange={(raw) => patchDecay({ need_decay_per_30d: toInt(raw, 0) })}
              />
            </div>
          )}
        </section>
      )}

      {/* ── Behavioural scoring ────────────────────────────────────────────────*/}
      <section className="space-y-3 border-t border-[var(--ds-border)] pt-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Activity size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
            <h3 className="text-[13px] font-semibold text-[var(--ds-text)]">Behavioural scoring</h3>
          </div>
          <Toggle
            checked={model.behavioral.enabled}
            onChange={(next) => patchBehavioral({ enabled: next })}
            label="Enable behavioural scoring"
          />
        </div>
        <p className="text-[12px] text-[var(--ds-text-subtle)]">
          Add points for engagement signals from the widget — return visits, campaign traffic, time
          on site, pages viewed, and known referrers.
        </p>
        {model.behavioral.enabled && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField
                id="beh-max"
                label="Max behavioural score"
                help="Caps the total points behavioural signals can add."
                value={model.behavioral.max_score}
                step={1}
                min={0}
                onChange={(raw) => patchBehavioral({ max_score: toInt(raw, 0) })}
              />
              <NumberField
                id="beh-return"
                label="Return visit score"
                value={model.behavioral.return_visit_score}
                step={1}
                min={0}
                onChange={(raw) => patchBehavioral({ return_visit_score: toInt(raw, 0) })}
              />
              <NumberField
                id="beh-utm"
                label="UTM present score"
                help="Awarded when the visitor arrives with UTM campaign params."
                value={model.behavioral.utm_present_score}
                step={1}
                min={0}
                onChange={(raw) => patchBehavioral({ utm_present_score: toInt(raw, 0) })}
              />
              <NumberField
                id="beh-time-threshold"
                label="Time on site threshold"
                unit="sec"
                unitLabel="seconds"
                value={model.behavioral.time_on_site_threshold}
                step={5}
                min={0}
                onChange={(raw) => patchBehavioral({ time_on_site_threshold: toInt(raw, 0) })}
              />
              <NumberField
                id="beh-time-score"
                label="Time on site score"
                value={model.behavioral.time_on_site_score}
                step={1}
                min={0}
                onChange={(raw) => patchBehavioral({ time_on_site_score: toInt(raw, 0) })}
              />
              <NumberField
                id="beh-pages-threshold"
                label="Pages viewed threshold"
                value={model.behavioral.pages_viewed_threshold}
                step={1}
                min={0}
                onChange={(raw) => patchBehavioral({ pages_viewed_threshold: toInt(raw, 0) })}
              />
              <NumberField
                id="beh-pages-score"
                label="Pages viewed score"
                value={model.behavioral.pages_viewed_score}
                step={1}
                min={0}
                onChange={(raw) => patchBehavioral({ pages_viewed_score: toInt(raw, 0) })}
              />
              <NumberField
                id="beh-referrer-score"
                label="Known referrer score"
                value={model.behavioral.known_referrer_score}
                step={1}
                min={0}
                onChange={(raw) => patchBehavioral({ known_referrer_score: toInt(raw, 0) })}
              />
            </div>

            {/* Known referrers */}
            <div className="space-y-2">
              <label
                htmlFor="beh-referrer-input"
                className="block text-[13px] font-medium text-[var(--ds-text)]"
              >
                Known referrers
              </label>
              <p className="text-[12px] text-[var(--ds-text-subtle)]">
                Domains that earn the referrer score when a visitor arrives from them.
              </p>
              <div className="flex gap-2">
                <Input
                  id="beh-referrer-input"
                  value={referrerDraft}
                  placeholder="example.com"
                  onChange={(event) => setReferrerDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addReferrer();
                    }
                  }}
                />
                <Button variant="outline" size="md" onClick={addReferrer} disabled={!referrerDraft.trim()}>
                  <Plus size={14} aria-hidden="true" />
                  Add
                </Button>
              </div>
              {model.behavioral.known_referrers.length > 0 && (
                <ul className="flex flex-wrap gap-2 pt-1">
                  {model.behavioral.known_referrers.map((referrer) => (
                    <li
                      key={referrer}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] py-1 pl-3 pr-1.5 text-[12px] text-[var(--ds-text-muted)]"
                    >
                      {referrer}
                      <button
                        type="button"
                        onClick={() => removeReferrer(referrer)}
                        aria-label={`Remove ${referrer}`}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-danger-soft)] hover:text-[var(--ds-danger)]"
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Footer actions — kept in the scroll body so long models still reach them. */}
      <div className="flex items-center justify-end gap-2 border-t border-[var(--ds-border)] pt-4">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleApply}>
          Apply changes
        </Button>
      </div>
    </div>
  );
}
