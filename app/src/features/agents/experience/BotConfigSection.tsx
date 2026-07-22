import { type ReactElement, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, Check, Plus, Trash2 } from 'lucide-react';
import {
  Button,
  EmptyState,
  FeatureGate,
  Input,
  SectionHeader,
  Skeleton,
  Textarea,
  cn,
} from '../../../design-system';
import { useAgent } from '../../../context/AgentContext';
import { getBot, updateBot } from '../../../services/api';
import {
  type BotConfigDraft,
  type LeadFieldName,
  type LiveChatConfig,
  type ServiceEntry,
  type SliceKey,
  type WidgetCopy,
  COPY_PLACEHOLDERS,
  HANDOFF_DELAY_OPTIONS,
  LEAD_FIELD_LABELS,
  LEAD_FIELD_ORDER,
  LIVE_CHAT_PLACEHOLDERS,
  MAX_QUEUE,
  QUEUE_TIMEOUT,
  copyPatch,
  draftFromBot,
  leadFormPatch,
  liveChatPatch,
  normalizeLiveChat,
  normalizeServiceEntries,
  servicesPatch,
  sliceEqual,
} from './botConfig';

/** Which cluster of config cards this instance renders. */
export type BotConfigVariant = 'handoff' | 'content';

interface SliceStatus {
  saving: boolean;
  error: string | null;
  saved: boolean;
}

const IDLE: SliceStatus = { saving: false, error: null, saved: false };

const INITIAL_STATUS: Record<SliceKey, SliceStatus> = {
  liveChat: IDLE,
  leadForm: IDLE,
  services: IDLE,
  copy: IDLE,
};

export interface BotConfigSectionProps {
  variant: BotConfigVariant;
}

/**
 * BotConfigSection — the Experience surfaces backed directly by the `Bot`
 * record rather than the shared appearance draft: live-chat handoff and the
 * pre-chat lead form (`variant="handoff"`), or the services answer-scope and
 * the remaining widget copy (`variant="content"`).
 *
 * It loads the bot once via `getBot`, edits locally, and persists each card's
 * slice independently via `updateBot` — so a change to the lead form never
 * forces a save of live-chat copy. Every slice tracks its own dirty / saving /
 * saved / error state and surfaces feedback inline.
 */
export function BotConfigSection({ variant }: BotConfigSectionProps): ReactElement {
  const { agent, loading: agentLoading, error: agentError } = useAgent();
  const botId = agent?.id ?? null;

  const botIdRef = useRef(botId);
  botIdRef.current = botId;

  const [baseline, setBaseline] = useState<BotConfigDraft | null>(null);
  const [draft, setDraft] = useState<BotConfigDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState<Record<SliceKey, SliceStatus>>(INITIAL_STATUS);

  // Load the bot once per agent (and on retry). Mirrors ExperiencePage: local
  // state is reset synchronously first, then the fetch resolves under a
  // `cancelled` guard so a stale response can't clobber a newer agent.
  useEffect(() => {
    if (botId === null) return;
    let cancelled = false;
    setDraft(null);
    setBaseline(null);
    setLoadError(null);
    setStatus(INITIAL_STATUS);
    getBot(botId)
      .then((bot) => {
        if (cancelled) return;
        const next = draftFromBot(bot as unknown as Record<string, unknown>);
        setBaseline(next);
        setDraft(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load this agent’s configuration.');
      });
    return () => {
      cancelled = true;
    };
  }, [botId, reloadKey]);

  const patchSlice = useCallback(
    <K extends SliceKey>(key: K, updater: (prev: BotConfigDraft[K]) => BotConfigDraft[K]): void => {
      setDraft((prev) => (prev ? { ...prev, [key]: updater(prev[key]) } : prev));
      setStatus((s) => ({ ...s, [key]: IDLE }));
    },
    [],
  );

  const runSave = useCallback(
    async (
      key: SliceKey,
      buildPatch: () => Record<string, unknown>,
      commit: (prev: BotConfigDraft) => BotConfigDraft,
    ): Promise<void> => {
      if (botId === null) return;
      const saveBotId = botId;
      setStatus((s) => ({ ...s, [key]: { saving: true, error: null, saved: false } }));
      try {
        await updateBot(saveBotId, buildPatch());
        if (botIdRef.current !== saveBotId) return;
        // Commit the normalized/clamped slice to BOTH the baseline and the
        // visible draft, so the UI shows exactly what the server stored (e.g. an
        // out-of-range queue timeout or a dropped blank service row) rather than
        // the un-persisted value the user typed.
        setBaseline((prev) => (prev ? commit(prev) : prev));
        setDraft((prev) => (prev ? commit(prev) : prev));
        setStatus((s) => ({ ...s, [key]: { saving: false, error: null, saved: true } }));
      } catch (err) {
        if (botIdRef.current !== saveBotId) return;
        setStatus((s) => ({
          ...s,
          [key]: {
            saving: false,
            error: err instanceof Error ? err.message : 'Could not save. Please try again.',
            saved: false,
          },
        }));
      }
    },
    [botId],
  );

  if (agentLoading || (botId !== null && draft === null && loadError === null)) {
    return <LoadingState />;
  }

  if (botId === null) {
    return (
      <EmptyState
        icon={AlertCircle}
        title={agentError ? 'Couldn’t load this agent' : 'Agent not found'}
        description={
          agentError
            ? 'We hit a problem loading your agents. Refresh to try again.'
            : 'This agent doesn’t exist or you don’t have access to it.'
        }
      />
    );
  }

  if (loadError && !draft) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Couldn’t load configuration"
        description={loadError}
        action={
          <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </Button>
        }
      />
    );
  }

  if (!draft || !baseline) return <LoadingState />;

  if (variant === 'handoff') {
    return (
      <div className="space-y-8">
        <FeatureGate feature="live_chat" intent="live_chat_appearance">
          <LiveChatCard
            value={draft.liveChat}
            onChange={(updater) => patchSlice('liveChat', updater)}
            dirty={!sliceEqual(draft.liveChat, baseline.liveChat)}
            status={status.liveChat}
            onSave={() => {
              const value = normalizeLiveChat(draft.liveChat);
              void runSave('liveChat', () => liveChatPatch(value), (prev) => ({ ...prev, liveChat: value }));
            }}
          />
        </FeatureGate>

        <LeadFormCard
          value={draft.leadForm.enabled}
          fields={draft.leadForm.fields}
          onToggle={(enabled) => patchSlice('leadForm', (prev) => ({ ...prev, enabled }))}
          onFieldsChange={(fields) => patchSlice('leadForm', (prev) => ({ ...prev, fields }))}
          dirty={!sliceEqual(draft.leadForm, baseline.leadForm)}
          status={status.leadForm}
          onSave={() => {
            const value = draft.leadForm;
            void runSave('leadForm', () => leadFormPatch(value), (prev) => ({ ...prev, leadForm: value }));
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <ServicesCard
        services={draft.services}
        onChange={(services) => patchSlice('services', () => services)}
        dirty={!sliceEqual(draft.services, baseline.services)}
        status={status.services}
        onSave={() => {
          const value = normalizeServiceEntries(draft.services);
          void runSave('services', () => servicesPatch(value), (prev) => ({ ...prev, services: value }));
        }}
      />

      <WidgetCopyCard
        value={draft.copy}
        onChange={(updater) => patchSlice('copy', updater)}
        dirty={!sliceEqual(draft.copy, baseline.copy)}
        status={status.copy}
        onSave={() => {
          const value = draft.copy;
          void runSave('copy', () => copyPatch(value), (prev) => ({ ...prev, copy: value }));
        }}
      />
    </div>
  );
}

// ── Shared card scaffolding ───────────────────────────────────────────────────

function Card({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="space-y-5 rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5">
      {children}
    </div>
  );
}

function SaveFooter({
  dirty,
  status,
  onSave,
  label,
}: {
  dirty: boolean;
  status: SliceStatus;
  onSave: () => void;
  label: string;
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--ds-border)] pt-4">
      <p role="status" aria-live="polite" className="min-w-0 truncate text-[12px]">
        {status.error ? (
          <span className="text-[var(--ds-danger)]">{status.error}</span>
        ) : status.saving ? (
          <span className="text-[var(--ds-text-muted)]">Saving…</span>
        ) : status.saved && !dirty ? (
          <span className="inline-flex items-center gap-1 text-[var(--ds-success)]">
            <Check size={13} aria-hidden="true" /> Saved
          </span>
        ) : dirty ? (
          <span className="text-[var(--ds-text-muted)]">Unsaved changes</span>
        ) : (
          <span className="text-[var(--ds-text-subtle)]">Up to date</span>
        )}
      </p>
      <Button size="sm" onClick={onSave} disabled={!dirty || status.saving}>
        {status.saving ? 'Saving…' : label}
      </Button>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
        checked ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-border)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-[var(--ds-text)]">{title}</p>
        <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  label: string;
  hint?: string;
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
        maxLength={maxLength}
        placeholder={placeholder}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && (
        <p id={hintId} className="text-[11px] text-[var(--ds-text-subtle)]">
          {hint}
        </p>
      )}
    </div>
  );
}

// ── #7 Live chat ──────────────────────────────────────────────────────────────

function LiveChatCard({
  value,
  onChange,
  dirty,
  status,
  onSave,
}: {
  value: LiveChatConfig;
  onChange: (updater: (prev: LiveChatConfig) => LiveChatConfig) => void;
  dirty: boolean;
  status: SliceStatus;
  onSave: () => void;
}): ReactElement {
  const delayId = useId();
  const timeoutId = useId();
  const queueId = useId();

  const parseInt10 = (raw: string): number => {
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? 0 : n;
  };

  return (
    <section className="space-y-5">
      <SectionHeader
        title="Live chat"
        description="Let visitors ask for a human, and control the wait-time copy and queue behaviour."
      />
      <Card>
        <ToggleRow
          title="Enable live chat"
          description='Shows a "Talk to a human" option in the widget during a chat.'
          checked={value.enabled}
          onChange={(enabled) => onChange((prev) => ({ ...prev, enabled }))}
        />

        {value.enabled && (
          <>
            <TextField
              label="Waiting message"
              hint="Shown while the visitor waits for an operator to accept."
              value={value.waitingMessage}
              placeholder={LIVE_CHAT_PLACEHOLDERS.waitingMessage}
              maxLength={200}
              onChange={(waitingMessage) => onChange((prev) => ({ ...prev, waitingMessage }))}
            />

            <TextField
              label="No-operators handoff message"
              hint="The live-chat handoff reply shown when a visitor asks for a human but live chat is off or every operator is offline. Different from the widget's general “Offline banner” (under Services & copy)."
              value={value.offlineMessage}
              placeholder={LIVE_CHAT_PLACEHOLDERS.offlineMessage}
              maxLength={200}
              onChange={(offlineMessage) => onChange((prev) => ({ ...prev, offlineMessage }))}
            />

            <div className="space-y-1.5">
              <label htmlFor={delayId} className="block text-[13px] font-medium text-[var(--ds-text)]">
                Handoff delay
              </label>
              <select
                id={delayId}
                value={value.handoffDelaySeconds}
                onChange={(e) => onChange((prev) => ({ ...prev, handoffDelaySeconds: parseInt10(e.target.value) }))}
                className="h-10 w-full rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 text-sm text-[var(--ds-text)] outline-none transition-colors focus-visible:border-[var(--ds-accent)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
              >
                {HANDOFF_DELAY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-[var(--ds-text-subtle)]">
                Time before the handoff form appears after the bot suggests live chat.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor={timeoutId} className="block text-[13px] font-medium text-[var(--ds-text)]">
                  Queue timeout
                </label>
                <div className="relative">
                  <Input
                    id={timeoutId}
                    type="number"
                    inputMode="numeric"
                    min={QUEUE_TIMEOUT.min}
                    max={QUEUE_TIMEOUT.max}
                    step={5}
                    value={value.queueTimeoutSeconds}
                    onChange={(e) =>
                      onChange((prev) => ({ ...prev, queueTimeoutSeconds: parseInt10(e.target.value) }))
                    }
                    className="pr-12"
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-medium text-[var(--ds-text-subtle)]"
                  >
                    sec
                  </span>
                </div>
                <p className="text-[11px] text-[var(--ds-text-subtle)]">
                  How long a visitor waits before timing out ({QUEUE_TIMEOUT.default}s default).
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor={queueId} className="block text-[13px] font-medium text-[var(--ds-text)]">
                  Max queue size
                </label>
                <Input
                  id={queueId}
                  type="number"
                  inputMode="numeric"
                  min={MAX_QUEUE.min}
                  max={MAX_QUEUE.max}
                  step={1}
                  value={value.maxQueueSize}
                  onChange={(e) => onChange((prev) => ({ ...prev, maxQueueSize: parseInt10(e.target.value) }))}
                />
                <p className="text-[11px] text-[var(--ds-text-subtle)]">
                  Most visitors allowed to wait in the queue at once ({MAX_QUEUE.default} default).
                </p>
              </div>
            </div>
          </>
        )}

        <SaveFooter dirty={dirty} status={status} onSave={onSave} label="Save live chat" />
      </Card>
    </section>
  );
}

// ── #10 Pre-chat lead form ────────────────────────────────────────────────────

function LeadFormCard({
  value,
  fields,
  onToggle,
  onFieldsChange,
  dirty,
  status,
  onSave,
}: {
  value: boolean;
  fields: { field: LeadFieldName; required: boolean }[];
  onToggle: (enabled: boolean) => void;
  onFieldsChange: (fields: { field: LeadFieldName; required: boolean }[]) => void;
  dirty: boolean;
  status: SliceStatus;
  onSave: () => void;
}): ReactElement {
  const toggleField = (name: LeadFieldName, enabled: boolean): void => {
    if (enabled) {
      if (fields.some((f) => f.field === name)) return;
      onFieldsChange([...fields, { field: name, required: false }]);
    } else {
      onFieldsChange(fields.filter((f) => f.field !== name));
    }
  };

  const setRequired = (name: LeadFieldName, required: boolean): void => {
    onFieldsChange(fields.map((f) => (f.field === name ? { ...f, required } : f)));
  };

  return (
    <section className="space-y-5">
      <SectionHeader
        title="Pre-chat lead form"
        description="Ask new visitors for their details before the conversation starts."
      />
      <Card>
        <ToggleRow
          title="Enable lead form"
          description="New visitors fill out a short form before chatting."
          checked={value}
          onChange={onToggle}
        />

        {value && (
          <div className="space-y-1">
            <p className="text-[12px] text-[var(--ds-text-muted)]">
              Choose which fields to collect and whether each one is required.
            </p>
            <ul className="divide-y divide-[var(--ds-border)]">
              {LEAD_FIELD_ORDER.map((name) => {
                const existing = fields.find((f) => f.field === name);
                const enabled = existing !== undefined;
                return (
                  <li key={name} className="flex items-center justify-between gap-4 py-3">
                    <div className="flex items-center gap-3">
                      <Toggle
                        checked={enabled}
                        onChange={(next) => toggleField(name, next)}
                        label={`Collect ${LEAD_FIELD_LABELS[name]}`}
                      />
                      <span className="text-[13px] font-medium text-[var(--ds-text)]">
                        {LEAD_FIELD_LABELS[name]}
                      </span>
                    </div>
                    {enabled && (
                      <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--ds-text-muted)]">
                        <input
                          type="checkbox"
                          checked={existing.required}
                          onChange={(e) => setRequired(name, e.target.checked)}
                          className="h-4 w-4 rounded border-[var(--ds-border)] accent-[var(--ds-accent)]"
                        />
                        Required
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <SaveFooter dirty={dirty} status={status} onSave={onSave} label="Save lead form" />
      </Card>
    </section>
  );
}

// ── #11 Services answer-scope ─────────────────────────────────────────────────

function ServicesCard({
  services,
  onChange,
  dirty,
  status,
  onSave,
}: {
  services: ServiceEntry[];
  onChange: (services: ServiceEntry[]) => void;
  dirty: boolean;
  status: SliceStatus;
  onSave: () => void;
}): ReactElement {
  const updateAt = (index: number, patch: Partial<ServiceEntry>): void => {
    onChange(services.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };
  const removeAt = (index: number): void => {
    onChange(services.filter((_, i) => i !== index));
  };
  const add = (): void => {
    onChange([...services, { name: '', url: '' }]);
  };

  return (
    <section className="space-y-5">
      <SectionHeader
        title="Services"
        description="Scope what the bot may answer about. Add a page link and it shows an ↗ next to the service when mentioned."
      />
      <Card>
        {services.length === 0 ? (
          <p className="rounded-[var(--ds-radius-lg)] border border-dashed border-[var(--ds-border)] px-3 py-4 text-[13px] text-[var(--ds-text-subtle)]">
            No services listed — the bot answers about anything in your knowledge base. Add one or more to
            scope its answers.
          </p>
        ) : (
          <div className="space-y-2">
            {services.map((service, index) => (
              // Rows are only appended/removed (never reordered), so a positional key is stable.
              <div
                key={index}
                className="flex flex-col gap-2 rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-2 sm:flex-row"
              >
                <Input
                  value={service.name}
                  aria-label={`Service ${index + 1} name`}
                  placeholder={`Service ${index + 1} name (e.g. SEO Audit)`}
                  onChange={(e) => updateAt(index, { name: e.target.value })}
                  className="flex-1 bg-[var(--ds-bg-surface)]"
                />
                <Input
                  type="url"
                  value={service.url}
                  aria-label={`Service ${index + 1} link`}
                  placeholder="https://example.com/services/seo (optional)"
                  onChange={(e) => updateAt(index, { url: e.target.value })}
                  className="flex-1 bg-[var(--ds-bg-surface)]"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove service ${index + 1}`}
                  onClick={() => removeAt(index)}
                  className="shrink-0 hover:text-[var(--ds-danger)]"
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div>
          <Button variant="outline" size="sm" onClick={add}>
            <Plus size={15} />
            Add service
          </Button>
        </div>

        <p className="text-[11px] text-[var(--ds-text-subtle)]">
          Once you save at least one service, the bot refuses questions outside this list. Links are optional.
        </p>

        <SaveFooter dirty={dirty} status={status} onSave={onSave} label="Save services" />
      </Card>
    </section>
  );
}

// ── #11 Remaining widget copy ─────────────────────────────────────────────────

function WidgetCopyCard({
  value,
  onChange,
  dirty,
  status,
  onSave,
}: {
  value: WidgetCopy;
  onChange: (updater: (prev: WidgetCopy) => WidgetCopy) => void;
  dirty: boolean;
  status: SliceStatus;
  onSave: () => void;
}): ReactElement {
  const offlineId = useId();
  return (
    <section className="space-y-5">
      <SectionHeader
        title="More widget copy"
        description="The remaining visitor-facing strings — the live-chat button, greeting bubble, offline banner and post-chat prompts."
      />
      <Card>
        <TextField
          label="Live-chat button label"
          hint="Label for the button that starts a live chat."
          value={value.liveChatLabel}
          placeholder={COPY_PLACEHOLDERS.liveChatLabel}
          maxLength={40}
          onChange={(liveChatLabel) => onChange((prev) => ({ ...prev, liveChatLabel }))}
        />
        <TextField
          label="Greeting bubble message"
          hint="The teaser bubble that pops up next to the launcher after a short delay."
          value={value.greetingMessage}
          placeholder={COPY_PLACEHOLDERS.greetingMessage}
          maxLength={160}
          onChange={(greetingMessage) => onChange((prev) => ({ ...prev, greetingMessage }))}
        />
        <div className="space-y-1.5">
          <label htmlFor={offlineId} className="block text-[13px] font-medium text-[var(--ds-text)]">
            Offline banner
          </label>
          <Textarea
            id={offlineId}
            rows={2}
            value={value.offlineMessage}
            maxLength={200}
            placeholder={COPY_PLACEHOLDERS.offlineMessage}
            onChange={(e) => onChange((prev) => ({ ...prev, offlineMessage: e.target.value }))}
          />
          <p className="text-[11px] text-[var(--ds-text-subtle)]">
            The widget's general offline notice shown when no operators are online. Different from the
            live-chat “No-operators handoff message” (under Live chat &amp; leads). Keep it warm and
            action-oriented.
          </p>
        </div>
        <TextField
          label="Rating prompt"
          hint="Prompt shown in the post-chat rating card."
          value={value.ratingPrompt}
          placeholder={COPY_PLACEHOLDERS.ratingPrompt}
          maxLength={120}
          onChange={(ratingPrompt) => onChange((prev) => ({ ...prev, ratingPrompt }))}
        />
        <TextField
          label="End-chat button label"
          hint="Label for the button that ends a live chat and returns to the AI."
          value={value.endChatLabel}
          placeholder={COPY_PLACEHOLDERS.endChatLabel}
          maxLength={40}
          onChange={(endChatLabel) => onChange((prev) => ({ ...prev, endChatLabel }))}
        />

        <SaveFooter dirty={dirty} status={status} onSave={onSave} label="Save copy" />
      </Card>
    </section>
  );
}

function LoadingState(): ReactElement {
  return (
    <div className="space-y-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-40 w-full rounded-[var(--ds-radius-lg)]" />
      <Skeleton className="h-40 w-full rounded-[var(--ds-radius-lg)]" />
    </div>
  );
}
