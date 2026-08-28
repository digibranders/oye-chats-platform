import { memo } from 'react';
import { Button, SegmentedControl, SettingRow } from '../../../ui';
import { DEFAULT_RELEVANCE_THRESHOLD, STRICTNESS_LEVELS, matchesLevel } from './behaviour.config';

export interface ScopeSectionProps {
  /** null = the platform default. */
  value: number | null;
  onChange: (next: number | null) => void;
}

/** The segment value for a threshold that matches no preset. */
const CUSTOM = 'custom';

/**
 * Answering scope — how strictly the chatbot stays inside what it has learned.
 *
 * Bound to `Bot.relevance_threshold`, the CRAG relevance gate. It is the first
 * row on this page because it is the only setting here that changes what the
 * chatbot *says*; everything below changes how the widget behaves.
 *
 * A saved value off the three presets — a hand-set threshold, or one an older
 * console wrote — gets its own segment rather than leaving the control with
 * nothing selected. `SegmentedControl` is a roving-tabindex radiogroup, so a
 * value matching no item leaves every segment at `tabIndex={-1}` and the whole
 * control unreachable from the keyboard.
 *
 * One explanation, not three. The card this replaces spent a 33-word header
 * description, a `FieldSet` hint and a 30-word paragraph on a three-segment
 * control; the chosen level's own help now sits under the label, where the
 * choice is.
 */
function ScopeSectionInner({ value, onChange }: ScopeSectionProps) {
  const matched = STRICTNESS_LEVELS.find((level) => matchesLevel(value, level.value));
  const isCustom = value !== null && !matched;
  const selected = isCustom ? CUSTOM : String(matched?.value ?? DEFAULT_RELEVANCE_THRESHOLD);

  const items = [
    ...STRICTNESS_LEVELS.map((level) => ({ value: String(level.value), label: level.label })),
    ...(isCustom ? [{ value: CUSTOM, label: `Custom (${value.toFixed(2)})` }] : []),
  ];

  const description = isCustom
    ? `Hand-set at ${value.toFixed(2)}. Picking a level replaces it.`
    : (matched?.help ?? '');

  return (
    <SettingRow label="Answering scope" description={description} stacked>
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          label="Answering strictness"
          size="sm"
          value={selected}
          items={items}
          onChange={(next) => {
            if (next === CUSTOM) return;
            onChange(Number(next));
          }}
        />
        {/* Always present, so picking a level does not change the row's height,
            and adjacent to the control it resets. It used to be a ghost button
            alone in a sunken band that only existed once a level was chosen. */}
        <Button size="sm" variant="ghost" disabled={value === null} onClick={() => onChange(null)}>
          Reset to the platform default
        </Button>
      </div>
    </SettingRow>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const ScopeSection = memo(ScopeSectionInner);
