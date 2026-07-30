import { type ReactElement, useId } from 'react';
import {
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button, Input, SectionHeader, cn } from '../../../design-system';
import { type ExperienceDraft, type SuggestionsLayout, FIELD_LIMITS } from './types';

export interface MessagesSectionProps {
  draft: ExperienceDraft;
  onChange: (patch: Partial<ExperienceDraft>) => void;
}

const LAYOUT_OPTIONS: { id: SuggestionsLayout; label: string; icon: typeof AlignHorizontalDistributeCenter }[] = [
  { id: 'horizontal', label: 'Horizontal', icon: AlignHorizontalDistributeCenter },
  { id: 'vertical', label: 'Vertical', icon: AlignVerticalDistributeCenter },
];

/** Small labelled text field used across the Messages section. */
function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  maxLength?: number;
}): ReactElement {
  const id = useId();
  const hintId = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-[var(--ds-text)]">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-describedby={hintId}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={hintId} className="text-[11px] text-[var(--ds-text-subtle)]">
        {hint}
      </p>
    </div>
  );
}

/**
 * MessagesSection - the visitor-facing copy shown before and during a chat: the
 * welcome greeting, subtitle, quick-action prompts (with a horizontal/vertical
 * layout choice), and the input placeholder. Mirrors the fields the shipped
 * widget reads from `widget_messages`.
 */
export function MessagesSection({ draft, onChange }: MessagesSectionProps): ReactElement {
  const { quickActions, suggestionsLayout } = draft;

  const setAction = (index: number, value: string): void => {
    onChange({ quickActions: quickActions.map((s, i) => (i === index ? value : s)) });
  };
  const addAction = (): void => {
    onChange({ quickActions: [...quickActions, ''] });
  };
  const removeAction = (index: number): void => {
    onChange({ quickActions: quickActions.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-8">
      <section className="space-y-5">
        <SectionHeader
          title="Widget identity"
          description="The name shown in the widget header and the tooltip beside the launcher button."
        />
        <Field
          label="Display name"
          hint="Shown in the widget header - also your agent's name across the dashboard."
          value={draft.displayName}
          maxLength={FIELD_LIMITS.displayName}
          placeholder="e.g. Acme Assistant"
          onChange={(v) => onChange({ displayName: v })}
        />
        <Field
          label="Launcher text"
          hint="The tooltip shown next to the launcher button before the chat opens."
          value={draft.launcherName}
          maxLength={FIELD_LIMITS.launcherName}
          placeholder="Have Questions?"
          onChange={(v) => onChange({ launcherName: v })}
        />
      </section>

      <section className="space-y-5 border-t border-[var(--ds-border)] pt-6">
        <SectionHeader
          title="Welcome screen"
          description="The greeting visitors see the moment the chat opens."
        />
        <Field
          label="Greeting"
          hint="The headline that welcomes visitors."
          value={draft.welcomeGreeting}
          placeholder="Hi there, how can I help you today?"
          onChange={(v) => onChange({ welcomeGreeting: v })}
        />
        <Field
          label="Subtitle"
          hint="A short line of context under the greeting."
          value={draft.welcomeSubtitle}
          placeholder="Ask me anything - I answer from your knowledge base."
          onChange={(v) => onChange({ welcomeSubtitle: v })}
        />
      </section>

      <section className="space-y-4 border-t border-[var(--ds-border)] pt-6">
        <SectionHeader
          title="Quick actions"
          description="Tappable prompts that give visitors a head start. Leave empty to hide them."
          actions={
            <div
              role="group"
              aria-label="Quick-action layout"
              className="inline-flex overflow-hidden rounded-lg border border-[var(--ds-border)]"
            >
              {LAYOUT_OPTIONS.map(({ id, label, icon: Icon }) => {
                const active = suggestionsLayout === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    aria-label={`${label} layout`}
                    title={`${label} layout`}
                    onClick={() => onChange({ suggestionsLayout: id })}
                    className={cn(
                      'flex h-8 items-center gap-1.5 px-2.5 text-[12px] font-medium transition-colors',
                      active
                        ? 'bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]'
                        : 'bg-[var(--ds-bg-surface)] text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
                    )}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                );
              })}
            </div>
          }
        />

        <div className="space-y-2">
          {quickActions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--ds-border)] px-3 py-4 text-[13px] text-[var(--ds-text-subtle)]">
              No quick actions yet. Add a few common questions to guide visitors.
            </p>
          ) : (
            quickActions.map((action, index) => (
              // Rows are only appended/removed (never reordered), so a positional
              // key is stable enough and avoids threading synthetic row ids.
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={action}
                  aria-label={`Quick action ${index + 1}`}
                  placeholder={`Quick action ${index + 1}`}
                  onChange={(e) => setAction(index, e.target.value)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove quick action ${index + 1}`}
                  onClick={() => removeAction(index)}
                  className="shrink-0 hover:text-[var(--ds-danger)]"
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            ))
          )}
        </div>

        <Button variant="outline" size="sm" onClick={addAction}>
          <Plus size={15} />
          Add quick action
        </Button>
      </section>

      <section className="space-y-4 border-t border-[var(--ds-border)] pt-6">
        <SectionHeader title="Chat input" description="The placeholder shown in the message box." />
        <Field
          label="Input placeholder"
          hint="Hint text inside the message field."
          value={draft.inputPlaceholder}
          placeholder="Write a message…"
          onChange={(v) => onChange({ inputPlaceholder: v })}
        />
      </section>
    </div>
  );
}
