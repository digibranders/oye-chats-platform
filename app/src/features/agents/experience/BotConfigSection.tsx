import { type ReactElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, Lock, Plus, Trash2 } from 'lucide-react';
import {
  Button,
  EmptyState,
  FeatureGate,
  Input,
  LockedFeatureCard,
  SectionHeader,
  Select,
  Skeleton,
  Textarea,
  cn,
} from '../../../design-system';
import { Card, SaveFooter, TextField, Toggle, ToggleRow } from './configCards';
import { LanguageCard } from './LanguageCard';
import { CustomCopyNotice } from './CustomCopyNotice';
import { useAgent } from '../../../context/AgentContext';
import { useUpgradeModal } from '../../../context/UpgradeModalContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getBot, updateBot } from '../../../services/api';
import {
  type BotConfigDraft,
  type LeadFieldName,
  type LiveChatConfig,
  type ServiceEntry,
  type SliceKey,
  type SliceStatus,
  type SmartLink,
  type WidgetCopy,
  COPY_PLACEHOLDERS,
  HANDOFF_DELAY_OPTIONS,
  IDLE,
  LEAD_FIELD_LABELS,
  LEAD_FIELD_ORDER,
  LIVE_CHAT_PLACEHOLDERS,
  MAX_QUEUE,
  QUEUE_TIMEOUT,
  answerLinksPatch,
  copyPatch,
  draftFromBot,
  isHttpUrl,
  languagePatch,
  leadFormPatch,
  liveChatPatch,
  normalizeLanguageConfig,
  normalizeLiveChat,
  normalizeServiceEntries,
  normalizeSmartLinkEntries,
  servicesPatch,
  sliceEqual,
} from './botConfig';
import { useTranslation } from '../../../i18n/useTranslation';
import { t as translateNow } from '../../../i18n/i18n';

/** Which cluster of config cards this instance renders. */
export type BotConfigVariant = 'handoff' | 'content' | 'language';

const INITIAL_STATUS: Record<SliceKey, SliceStatus> = {
  liveChat: IDLE,
  leadForm: IDLE,
  services: IDLE,
  answerLinks: IDLE,
  copy: IDLE,
  language: IDLE,
};

export interface BotConfigSectionProps {
  variant: BotConfigVariant;
}

/**
 * BotConfigSection - the Experience surfaces backed directly by the `Bot`
 * record rather than the shared appearance draft: live-chat handoff and the
 * pre-chat lead form (`variant="handoff"`), the services answer-scope and the
 * remaining widget copy (`variant="content"`), or the bot's visitor-facing
 * language configuration (`variant="language"`).
 *
 * It loads the bot once via `getBot`, edits locally, and persists each card's
 * slice independently via `updateBot` - so a change to the lead form never
 * forces a save of live-chat copy. Every slice tracks its own dirty / saving /
 * saved / error state and surfaces feedback inline.
 */
export function BotConfigSection({ variant }: BotConfigSectionProps): ReactElement {
  const { t } = useTranslation();
  const { agent, loading: agentLoading, error: agentError } = useAgent();
  const botId = agent?.id ?? null;
  // The pre-chat lead form is a paid feature (leads are Free-plan-gated across
  // the app). `loading` guards the initial entitlements fetch so a paid
  // workspace never flashes the locked teaser before its plan resolves.
  const { isFree, loading: entitlementsLoading } = useEntitlements();

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
        setLoadError(err instanceof Error ? err.message : translateNow('agents.couldNotLoadConfiguration') || 'Could not load this chatbot’s configuration.');
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
            error: err instanceof Error ? err.message : translateNow('agents.couldNotSavePleaseTry') || 'Could not save. Please try again.',
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
        title={agentError ? t('agents.couldntLoadThisChatbot') || 'Couldn’t load this chatbot' : t('agents.chatbotNotFound') || 'Chatbot not found'}
        description={
          agentError
            ? t('agents.weHitAProblemLoading') || 'We hit a problem loading your chatbots. Refresh to try again.'
            : t('agents.thisChatbotDoesntExistOr') || 'This chatbot doesn’t exist or you don’t have access to it.'
        }
      />
    );
  }

  if (loadError && !draft) {
    return (
      <EmptyState
        icon={AlertCircle}
        title={t('agents.couldntLoadConfiguration') || 'Couldn’t load configuration'}
        description={loadError}
        action={
          <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)}>
            {t('agents.tryAgain') || 'Try again'}
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
            multilingual={draft.language.enabled}
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

        {!entitlementsLoading && isFree ? (
          <LockedFeatureCard intent="leads_form" />
        ) : (
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
        )}
      </div>
    );
  }

  if (variant === 'language') {
    return (
      <div className="space-y-8">
        <LanguageCard
          value={draft.language}
          baseline={baseline.language}
          onChange={(updater) => patchSlice('language', updater)}
          dirty={!sliceEqual(draft.language, baseline.language)}
          status={status.language}
          onSave={() => {
            const value = normalizeLanguageConfig(draft.language);
            void runSave('language', () => languagePatch(value), (prev) => ({ ...prev, language: value }));
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

      <SmartLinksCard
        links={draft.answerLinks}
        onChange={(links) => patchSlice('answerLinks', () => links)}
        dirty={!sliceEqual(draft.answerLinks, baseline.answerLinks)}
        status={status.answerLinks}
        onSave={() => {
          const value = normalizeSmartLinkEntries(draft.answerLinks);
          void runSave('answerLinks', () => answerLinksPatch(value), (prev) => ({
            ...prev,
            answerLinks: value,
          }));
        }}
      />

      <WidgetCopyCard
        multilingual={draft.language.enabled}
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

// ── #7 Live chat ──────────────────────────────────────────────────────────────

function LiveChatCard({
  value,
  onChange,
  dirty,
  status,
  onSave,
  multilingual,
}: {
  value: LiveChatConfig;
  multilingual: boolean;
  onChange: (updater: (prev: LiveChatConfig) => LiveChatConfig) => void;
  dirty: boolean;
  status: SliceStatus;
  onSave: () => void;
}): ReactElement {
  const { t } = useTranslation();
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
        title={t('agents.liveChat') || 'Live chat'}
        description={t('agents.letVisitorsAskForA') || 'Let visitors ask for a human, and control the wait-time copy and queue behaviour.'}
      />
      <Card>
        <ToggleRow
          title={t('agents.enableLiveChat') || 'Enable live chat'}
          description={t('agents.showsATalkToA') || 'Shows a "Talk to a human" option in the widget during a chat.'}
          checked={value.enabled}
          onChange={(enabled) => onChange((prev) => ({ ...prev, enabled }))}
        />

        {value.enabled && (
          <>
            <CustomCopyNotice multilingual={multilingual} />

            <TextField
              label={t('agents.waitingMessage') || 'Waiting message'}
              hint={t('agents.shownWhileTheVisitorWaits') || 'Shown while the visitor waits for an operator to accept.'}
              value={value.waitingMessage}
              placeholder={LIVE_CHAT_PLACEHOLDERS.waitingMessage}
              maxLength={200}
              onChange={(waitingMessage) => onChange((prev) => ({ ...prev, waitingMessage }))}
            />

            <TextField
              label={t('agents.noOperatorsHandoffMessage') || 'No-operators handoff message'}
              hint={t('agents.theLiveChatHandoffReply') || 'The live-chat handoff reply shown when a visitor asks for a human but live chat is off or every operator is offline. Different from the widget\'s general “Offline banner” (under Services & copy).'}
              value={value.offlineMessage}
              placeholder={LIVE_CHAT_PLACEHOLDERS.offlineMessage}
              maxLength={200}
              onChange={(offlineMessage) => onChange((prev) => ({ ...prev, offlineMessage }))}
            />

            <div className="space-y-1.5">
              <label htmlFor={delayId} className="block text-[13px] font-medium text-[var(--ds-text)]">
                {t('agents.handoffDelayLabel') || 'Handoff delay'}
              </label>
              <Select
                id={delayId}
                value={String(value.handoffDelaySeconds)}
                onChange={(next) => onChange((prev) => ({ ...prev, handoffDelaySeconds: parseInt10(next) }))}
                options={HANDOFF_DELAY_OPTIONS.map((option) => ({
                  value: String(option.value),
                  label: t(`agents.handoffDelay.${option.value}`) || option.label,
                }))}
              />
              <p className="text-[11px] text-[var(--ds-text-subtle)]">
                {t('agents.timeBeforeTheHandoffForm') || 'Time before the handoff form appears after the AI Chatbot suggests live chat.'}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor={timeoutId} className="block text-[13px] font-medium text-[var(--ds-text)]">
                  {t('agents.queueTimeout') || 'Queue timeout'}
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
                    {t('agents.sec') || 'sec'}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--ds-text-subtle)]">
                  {t('agents.queueTimeoutHint', { seconds: QUEUE_TIMEOUT.default }) ||
                    `How long a visitor waits before timing out (${QUEUE_TIMEOUT.default}s default).`}
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor={queueId} className="block text-[13px] font-medium text-[var(--ds-text)]">
                  {t('agents.maxQueueSize') || 'Max queue size'}
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
                  {t('agents.maxQueueHint', { count: MAX_QUEUE.default }) ||
                    `Most visitors allowed to wait in the queue at once (${MAX_QUEUE.default} default).`}
                </p>
              </div>
            </div>
          </>
        )}

        <SaveFooter dirty={dirty} status={status} onSave={onSave} label={t('agents.saveLiveChat') || 'Save live chat'} />
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
  const { t } = useTranslation();
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
        title={t('agents.preChatLeadForm') || 'Pre-chat lead form'}
        description={t('agents.askNewVisitorsForTheir') || 'Ask new visitors for their details before the conversation starts.'}
      />
      <Card>
        <ToggleRow
          title={t('agents.enableLeadForm') || 'Enable lead form'}
          description={t('agents.newVisitorsFillOutA') || 'New visitors fill out a short form before chatting.'}
          checked={value}
          onChange={onToggle}
        />

        {value && (
          <div className="space-y-1">
            <p className="text-[12px] text-[var(--ds-text-muted)]">
              {t('agents.chooseWhichFieldsToCollect') || 'Choose which fields to collect and whether each one is required.'}
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
                        label={
                          t('agents.collectField', { field: leadFieldLabel(name) }) ||
                          `Collect ${leadFieldLabel(name)}`
                        }
                      />
                      <span className="text-[13px] font-medium text-[var(--ds-text)]">
                        {leadFieldLabel(name)}
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
                        {t('agents.required') || 'Required'}
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <SaveFooter dirty={dirty} status={status} onSave={onSave} label={t('agents.saveLeadForm') || 'Save lead form'} />
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
  const { t } = useTranslation();
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
        title={t('agents.services') || 'Services'}
        description={t('agents.scopeWhatTheBotMay') || 'Scope what the bot may answer about. Add a page link and it shows an ↗ next to the service when mentioned.'}
      />
      <Card>
        {services.length === 0 ? (
          <p className="rounded-[var(--ds-radius-lg)] border border-dashed border-[var(--ds-border)] px-3 py-4 text-[13px] text-[var(--ds-text-subtle)]">
            {t('agents.noServicesListed') ||
              'No services listed - the bot answers about anything in your knowledge base. Add one or more to scope its answers.'}
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
                  aria-label={t('agents.serviceNameLabel', { n: index + 1 }) || `Service ${index + 1} name`}
                  placeholder={
                    t('agents.serviceNamePlaceholder', { n: index + 1 }) ||
                    `Service ${index + 1} name (e.g. SEO Audit)`
                  }
                  onChange={(e) => updateAt(index, { name: e.target.value })}
                  className="flex-1 bg-[var(--ds-bg-surface)]"
                />
                <Input
                  type="url"
                  value={service.url}
                  aria-label={t('agents.serviceLinkLabel', { n: index + 1 }) || `Service ${index + 1} link`}
                  placeholder={t('agents.httpsExampleComServicesSeo') || 'https://example.com/services/seo (optional)'}
                  onChange={(e) => updateAt(index, { url: e.target.value })}
                  className="flex-1 bg-[var(--ds-bg-surface)]"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('agents.removeServiceLabel', { n: index + 1 }) || `Remove service ${index + 1}`}
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
            {t('agents.addService') || 'Add service'}
          </Button>
        </div>

        <p className="text-[11px] text-[var(--ds-text-subtle)]">
          {t('agents.onceYouSaveAtLeast') || 'Once you save at least one service, the bot refuses questions outside this list. Links are optional.'}
        </p>

        <SaveFooter dirty={dirty} status={status} onSave={onSave} label={t('agents.saveServices') || 'Save services'} />
      </Card>
    </section>
  );
}

// ── #11 Smart links (keyword → page) ──────────────────────────────────────────

function SmartLinksCard({
  links,
  onChange,
  dirty,
  status,
  onSave,
}: {
  links: SmartLink[];
  onChange: (links: SmartLink[]) => void;
  dirty: boolean;
  status: SliceStatus;
  onSave: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const updateAt = (index: number, patch: Partial<SmartLink>): void => {
    onChange(links.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };
  const removeAt = (index: number): void => {
    onChange(links.filter((_, i) => i !== index));
  };
  const add = (): void => {
    onChange([...links, { keyword: '', url: '' }]);
  };

  return (
    <section className="space-y-5">
      <SectionHeader
        title={t('agents.smartLinks') || 'Smart links'}
        description={t('agents.mapAKeywordToA') || 'Map a keyword to a page. When the bot\'s answer mentions it, the word becomes a link to that page. Separate from Services - this never limits what the bot can answer.'}
      />
      <Card>
        {links.length === 0 ? (
          <p className="rounded-[var(--ds-radius-lg)] border border-dashed border-[var(--ds-border)] px-3 py-4 text-[13px] text-[var(--ds-text-subtle)]">
            {t('agents.noSmartLinksYet') ||
              'No smart links yet. Add one - for example, keyword “pricing” linking to your pricing page - and the bot will hyperlink it whenever it naturally comes up in an answer.'}
          </p>
        ) : (
          <div className="space-y-2">
            {links.map((link, index) => {
              // Rows are only appended/removed (never reordered), so a positional key is stable.
              const urlInvalid = link.url.trim().length > 0 && !isHttpUrl(link.url);
              return (
                <div
                  key={index}
                  className="flex flex-col gap-2 rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-2"
                >
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={link.keyword}
                      aria-label={t('agents.smartLinkKeywordLabel', { n: index + 1 }) || `Smart link ${index + 1} keyword`}
                      placeholder={t('agents.keywordEGPricing') || 'Keyword (e.g. pricing)'}
                      maxLength={80}
                      onChange={(e) => updateAt(index, { keyword: e.target.value })}
                      className="flex-1 bg-[var(--ds-bg-surface)] sm:max-w-[40%]"
                    />
                    <Input
                      type="url"
                      value={link.url}
                      aria-label={t('agents.smartLinkUrlLabel', { n: index + 1 }) || `Smart link ${index + 1} URL`}
                      placeholder={t('agents.httpsExampleComPricing') || 'https://example.com/pricing'}
                      aria-invalid={urlInvalid || undefined}
                      onChange={(e) => updateAt(index, { url: e.target.value })}
                      className="flex-1 bg-[var(--ds-bg-surface)]"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('agents.removeSmartLinkLabel', { n: index + 1 }) || `Remove smart link ${index + 1}`}
                      onClick={() => removeAt(index)}
                      className="shrink-0 hover:text-[var(--ds-danger)]"
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                  {urlInvalid && (
                    <p className="px-1 text-[11px] text-[var(--ds-danger)]">
                      {t('agents.enterAFullLink') ||
                        'Enter a full link starting with http:// or https:// - other rows are saved but this one is skipped until it is valid.'}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div>
          <Button variant="outline" size="sm" onClick={add}>
            <Plus size={15} />
            {t('agents.addSmartLink') || 'Add smart link'}
          </Button>
        </div>

        <p className="text-[11px] text-[var(--ds-text-subtle)]">
          {t('agents.smartLinkRules') ||
            'The bot links a keyword only where it fits the sentence, at most once per reply. Every row needs a keyword and an http(s) link; blank or invalid rows are dropped when you save.'}
        </p>

        <SaveFooter dirty={dirty} status={status} onSave={onSave} label={t('agents.saveSmartLinks') || 'Save smart links'} />
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
  multilingual,
}: {
  value: WidgetCopy;
  multilingual: boolean;
  onChange: (updater: (prev: WidgetCopy) => WidgetCopy) => void;
  dirty: boolean;
  status: SliceStatus;
  onSave: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const offlineId = useId();
  const { hasFeature } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();
  const liveChatUnlocked = hasFeature('live_chat');

  return (
    <section className="space-y-5">
      <SectionHeader
        title={t('agents.moreWidgetCopy') || 'More widget copy'}
        description={t('agents.theRemainingVisitorFacingStrings') || 'The remaining visitor-facing strings - the live-chat button, greeting bubble, offline banner and post-chat prompts.'}
      />
      <CustomCopyNotice multilingual={multilingual} />
      {!liveChatUnlocked && (
        <button
          type="button"
          onClick={() => openUpgradeModal('live_chat')}
          className="group flex w-full items-center gap-2.5 rounded-[var(--ds-radius-md)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3.5 py-2.5 text-left transition-colors hover:border-[var(--ds-border-strong)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
        >
          <Lock
            size={13}
            strokeWidth={1.75}
            aria-hidden="true"
            className="text-[var(--ds-text-subtle)]"
          />
          <span className="text-[12.5px] text-[var(--ds-text-muted)]">
            {t('agents.liveChatCopyIsAvailable') || 'Live-chat copy is available on Starter and up.'}
          </span>
          <span className="ml-auto text-[12.5px] font-medium text-[var(--ds-accent-text)] transition-colors group-hover:text-[var(--ds-accent)]">
            {t('agents.upgrade') || 'Upgrade'}
          </span>
        </button>
      )}
      <Card>
        <TextField
          label={t('agents.liveChatButtonLabel') || 'Live-chat button label'}
          hint={t('agents.labelForTheButtonThat2') || 'Label for the button that starts a live chat.'}
          value={value.liveChatLabel}
          placeholder={COPY_PLACEHOLDERS.liveChatLabel}
          maxLength={40}
          disabled={!liveChatUnlocked}
          onChange={(liveChatLabel) => onChange((prev) => ({ ...prev, liveChatLabel }))}
        />
        <TextField
          label={t('agents.greetingBubbleMessage') || 'Greeting bubble message'}
          hint={t('agents.theTeaserBubbleThatPops') || 'The teaser bubble that pops up next to the launcher after a short delay.'}
          value={value.greetingMessage}
          placeholder={COPY_PLACEHOLDERS.greetingMessage}
          maxLength={160}
          onChange={(greetingMessage) => onChange((prev) => ({ ...prev, greetingMessage }))}
        />
        <div className="space-y-1.5">
          <label
            htmlFor={offlineId}
            className={cn(
              'flex items-center gap-1.5 text-[13px] font-medium',
              liveChatUnlocked ? 'text-[var(--ds-text)]' : 'text-[var(--ds-text-subtle)]',
            )}
          >
            {!liveChatUnlocked && <Lock size={11} strokeWidth={1.75} aria-hidden="true" />}
            {t('agents.offlineBanner') || 'Offline banner'}
          </label>
          <Textarea
            id={offlineId}
            rows={2}
            value={value.offlineMessage}
            maxLength={200}
            placeholder={COPY_PLACEHOLDERS.offlineMessage}
            disabled={!liveChatUnlocked}
            onChange={(e) => onChange((prev) => ({ ...prev, offlineMessage: e.target.value }))}
          />
          <p className="text-[11px] text-[var(--ds-text-subtle)]">
            {t('agents.offlineNoticeHint') ||
              'The widget\'s general offline notice shown when no operators are online. Different from the live-chat “No-operators handoff message” (under Live chat & leads). Keep it warm and action-oriented.'}
          </p>
        </div>
        <TextField
          label={t('agents.ratingPrompt') || 'Rating prompt'}
          hint={t('agents.promptShownInThePost') || 'Prompt shown in the post-chat rating card.'}
          value={value.ratingPrompt}
          placeholder={COPY_PLACEHOLDERS.ratingPrompt}
          maxLength={120}
          disabled={!liveChatUnlocked}
          onChange={(ratingPrompt) => onChange((prev) => ({ ...prev, ratingPrompt }))}
        />
        <TextField
          label={t('agents.endChatButtonLabel') || 'End-chat button label'}
          hint={t('agents.labelForTheButtonThat') || 'Label for the button that ends a live chat and returns to the AI.'}
          value={value.endChatLabel}
          placeholder={COPY_PLACEHOLDERS.endChatLabel}
          maxLength={40}
          disabled={!liveChatUnlocked}
          onChange={(endChatLabel) => onChange((prev) => ({ ...prev, endChatLabel }))}
        />

        <SaveFooter dirty={dirty} status={status} onSave={onSave} label={t('agents.saveCopy') || 'Save copy'} />
      </Card>
    </section>
  );
}


/** A lead-form field's label in the active language. */
function leadFieldLabel(name: LeadFieldName): string {
  return translateNow(`agents.leadField.${name}`) || LEAD_FIELD_LABELS[name];
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
