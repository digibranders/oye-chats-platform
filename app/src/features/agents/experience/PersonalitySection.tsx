import { type ReactElement, type ReactNode, useId } from 'react';
import { Input, SectionHeader } from '../../../design-system';
import { type ExperienceDraft, FIELD_LIMITS } from './types';

export interface PersonalitySectionProps {
  draft: ExperienceDraft;
  onChange: (patch: Partial<ExperienceDraft>) => void;
}

/** Labelled multi-line field with a live character counter capped at `maxLength`. */
function TextAreaField({
  label,
  hint,
  value,
  maxLength,
  rows,
  placeholder,
  onChange,
}: {
  label: string;
  hint: ReactNode;
  value: string;
  maxLength: number;
  rows: number;
  placeholder: string;
  onChange: (value: string) => void;
}): ReactElement {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-[var(--ds-text)]">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full resize-y rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-2.5 text-sm text-[var(--ds-text)] outline-none transition-colors placeholder:text-[var(--ds-text-subtle)] focus-visible:border-[var(--ds-accent)] focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-soft)]"
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-[var(--ds-text-subtle)]">{hint}</p>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--ds-text-subtle)]">
          {value.length}/{maxLength}
        </span>
      </div>
    </div>
  );
}

/**
 * PersonalitySection — how the agent sounds and what it knows about the
 * business: a custom system prompt, brand voice, and company identity. These
 * shape every answer a visitor reads. Bind to the same `Bot` fields the shipped
 * personality editor uses, with the backend length caps enforced client-side.
 */
export function PersonalitySection({ draft, onChange }: PersonalitySectionProps): ReactElement {
  const companyId = useId();

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <SectionHeader
          title="System prompt"
          description="Custom instructions that steer every reply. Leave blank to use the platform default."
        />
        <TextAreaField
          label="Custom instructions"
          hint="Layered on top of your knowledge base to guide the agent's behaviour."
          value={draft.systemPrompt}
          maxLength={FIELD_LIMITS.systemPrompt}
          rows={6}
          placeholder="e.g. You are a friendly support assistant for Acme Inc. Be concise and offer to connect visitors to a human when unsure."
          onChange={(v) => onChange({ systemPrompt: v })}
        />
      </section>

      <section className="space-y-4 border-t border-[var(--ds-border)] pt-6">
        <SectionHeader
          title="Brand voice"
          description="Describe the tone your agent should match. Visitors feel this in every message."
        />
        <TextAreaField
          label="Voice & tone"
          hint="e.g. Warm and approachable, with a touch of humour. Avoid jargon."
          value={draft.brandTone}
          maxLength={FIELD_LIMITS.brandTone}
          rows={3}
          placeholder="Warm and approachable, with a touch of humour. Avoid jargon."
          onChange={(v) => onChange({ brandTone: v })}
        />
      </section>

      <section className="space-y-4 border-t border-[var(--ds-border)] pt-6">
        <SectionHeader
          title="Company details"
          description="Context the agent uses to describe your business accurately."
        />
        <div className="space-y-1.5">
          <label htmlFor={companyId} className="block text-[13px] font-medium text-[var(--ds-text)]">
            Company name
          </label>
          <Input
            id={companyId}
            value={draft.companyName}
            maxLength={FIELD_LIMITS.companyName}
            placeholder="e.g. Acme Inc."
            onChange={(e) => onChange({ companyName: e.target.value })}
          />
          <p className="text-[11px] text-[var(--ds-text-subtle)]">The name of your business or brand.</p>
        </div>
        <TextAreaField
          label="Company description"
          hint="A short summary of what your company does."
          value={draft.companyDescription}
          maxLength={FIELD_LIMITS.companyDescription}
          rows={4}
          placeholder="e.g. Acme Inc. builds project-management software for remote teams."
          onChange={(v) => onChange({ companyDescription: v })}
        />
      </section>
    </div>
  );
}
