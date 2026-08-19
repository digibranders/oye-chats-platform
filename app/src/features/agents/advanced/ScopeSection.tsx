import { memo } from 'react';
import { Button, Card, CardBody, CardHeader, CardSection, FieldSet, SegmentedControl } from '../../../ui';
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
 * thing on this page because it is the only setting here that changes what the
 * chatbot *says*; everything below changes how the widget behaves.
 *
 * A saved value off the three presets — a hand-set threshold, or one an older
 * console wrote — gets its own segment rather than leaving the control with
 * nothing selected. `SegmentedControl` is a roving-tabindex radiogroup, so a
 * value matching no item leaves every segment at `tabIndex={-1}` and the whole
 * control unreachable from the keyboard.
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
    ? `This chatbot uses a hand-set strictness of ${value.toFixed(2)}, which is not one of the three presets. Picking a level replaces it.`
    : (matched?.help ?? '');

  return (
    <Card>
      <CardHeader
        title="Answering scope"
        titleAs="h2"
        description="How close a question has to be to your content before the chatbot will answer it. Loosen it if real questions are being turned away; tighten it to keep every answer inside what you have published."
      />
      <CardBody>
        <FieldSet
          legend="Strictness"
          hint={value === null ? 'Using the platform default.' : undefined}
        >
          <SegmentedControl
            label="Answering strictness"
            value={selected}
            items={items}
            onChange={(next) => {
              if (next === CUSTOM) return;
              onChange(Number(next));
            }}
          />
        </FieldSet>
        <p className="mt-3 max-w-2xl text-prose text-text-secondary">{description}</p>
      </CardBody>
      {value !== null ? (
        <CardSection className="bg-surface-sunken">
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Reset to the platform default
          </Button>
        </CardSection>
      ) : null}
    </Card>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const ScopeSection = memo(ScopeSectionInner);
