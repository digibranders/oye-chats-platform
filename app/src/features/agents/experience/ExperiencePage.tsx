import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Globe } from 'lucide-react';
import {
  Button,
  EmptyState,
  PageContainer,
  Skeleton,
  cn,
} from '../../../design-system';
import { Tabs, type TabItem } from '../../../design-system/components/Tabs';
import { useAgent } from '../../../context/AgentContext';
import { getClientSettings, updateClientSettings, uploadLogo } from '../../../services/api';
import {
  type ExperienceDraft,
  asStringArray,
  draftFromSettings,
  draftsEqual,
  settingsFromDraft,
} from './types';
import { BrandingSection } from './BrandingSection';
import { MessagesSection } from './MessagesSection';
import { PersonalitySection } from './PersonalitySection';
import { BotConfigSection } from './BotConfigSection';
import { ExperiencePreview } from './ExperiencePreview';
import { WebsitePreviewPanel } from './WebsitePreviewPanel';
import { useTranslation } from '../../../i18n/useTranslation';
import { t as translateNow } from '../../../i18n/i18n';

type SectionKey = 'branding' | 'messages' | 'personality' | 'language' | 'liveChatLeads' | 'servicesCopy';

// Built at import, before a locale exists. The labels here are the fallback;
// the render site resolves each from its key.
// @i18n-exempt: resolved in `sectionTabs` below from the tab key
// (`agents.tab.<key>`); the labels here are that lookup's English fallback.
const SECTION_TABS: TabItem[] = [
  { key: 'branding', label: 'Branding' },
  { key: 'messages', label: 'Messages' },
  { key: 'personality', label: 'Personality' },
  { key: 'language', label: 'Language' },
  { key: 'liveChatLeads', label: 'Live chat & leads' },
  { key: 'servicesCopy', label: 'Services & copy' },
];

/**
 * `PATCH /bots/{id}` answers 403 `branding_addon_required` when a bot without
 * the branding-removal add-on tries to hide or re-label the "Powered by
 * OyeChats" badge. It is the one save failure on this page that has a specific
 * cure, so it must not land in the generic error line.
 */
function isBrandingAddonRequired(err: unknown): boolean {
  const detail =
    (err as { response?: { data?: { detail?: unknown } }; detail?: unknown })?.response?.data
      ?.detail ?? (err as { detail?: unknown })?.detail;
  return (
    detail !== null &&
    typeof detail === 'object' &&
    (detail as { error?: string }).error === 'branding_addon_required'
  );
}

/** Narrows the Tabs' string key to a SectionKey without an unchecked assertion. */
function isSectionKey(key: string): key is SectionKey {
  return SECTION_TABS.some((tab) => tab.key === key);
}

/** Brand-neutral fallback swatches, appended after any website-extracted colours. */
const PRESET_SWATCHES = ['#7C3AED', '#4f46e5', '#0ea5e9', '#059669', '#e11d48', '#d97706'];

/**
 * ExperiencePage - the agent's "Experience" tab. One job: let the user control
 * exactly what visitors see in the chat widget (branding, messages, personality)
 * with a live, pixel-faithful preview beside the editor. Loads once, edits
 * locally, and persists the whole draft on demand - surfacing loading, empty,
 * error, saving and saved states throughout.
 */
export function ExperiencePage(): ReactElement {
  const { t, locale } = useTranslation();

  // Resolved here, not in the module table: the table is built at import,
  // before a locale exists, and these labels must follow a language switch.
  // Keyed on `locale` with the module-level `translateNow` rather than closing
  // over the hook's `t`, which the React Compiler cannot memoise across.
  const sectionTabs = useMemo(
    () =>
      SECTION_TABS.map((tab) => ({
        ...tab,
        label: translateNow(`agents.tab.${tab.key}`) || tab.label,
      })),
    // `translateNow` reads the locale at call time, so the linter cannot see the
    // dependency; without it the tab labels stay in the previous language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale],
  );

  const { agent, loading: agentLoading, error: agentError, refresh } = useAgent();
  const botId = agent?.id ?? null;

  // Tracks the currently-loaded agent so in-flight save/upload handlers can
  // detect an agent switch and skip writing their result against a new agent.
  const botIdRef = useRef(botId);
  botIdRef.current = botId;

  const [baseline, setBaseline] = useState<ExperienceDraft | null>(null);
  const [draft, setDraft] = useState<ExperienceDraft | null>(null);
  const [recommended, setRecommended] = useState<string[]>([]);
  // Read-only, from the same payload as `recommended` and never part of the
  // editable draft: it drives a notice, not a value the customer can save here.
  // Language itself is configured on its own tab.
  const [multilingual, setMultilingual] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [activeSection, setActiveSection] = useState<SectionKey>('branding');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // The on-demand "preview on my website" panel, launched from the Preview
  // card's corner icon (replaces the old always-present full-width card).
  const [websitePreviewOpen, setWebsitePreviewOpen] = useState(false);

  // Load the agent's settings once per agent (and on retry). Local state is
  // reset synchronously first, then the fetch resolves; every post-fetch
  // setState is guarded by the `cancelled` flag so a stale response can't
  // clobber a newer agent. Transient save/upload feedback is cleared here too
  // so a banner or error from the previous agent never bleeds onto this one.
  useEffect(() => {
    if (botId === null) return;
    let cancelled = false;
    setDraft(null);
    setBaseline(null);
    setLoadError(null);
    setRecommended([]);
    setMultilingual(false);
    setSaveError(null);
    setJustSaved(false);
    setUploadError(null);
    setUploading(false);
    setSaving(false);
    getClientSettings(botId)
      .then((raw) => {
        if (cancelled) return;
        const next = draftFromSettings(raw);
        setBaseline(next);
        setDraft(next);
        setRecommended(asStringArray(raw.recommended_colors));
        const langCfg = raw.language_config;
        setMultilingual(
          typeof langCfg === 'object' && langCfg !== null && (langCfg as Record<string, unknown>).enabled === true,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : translateNow('agents.couldNotLoadSettings') || 'Could not load this chatbot’s settings.');
      });
    return () => {
      cancelled = true;
    };
  }, [botId, reloadKey]);

  const updateDraft = useCallback((patch: Partial<ExperienceDraft>): void => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setJustSaved(false);
    setSaveError(null);
  }, []);

  // Commit values the server has ALREADY persisted (e.g. "Detect from website")
  // into both the baseline and the draft, so the change lands without ever
  // reading as an unsaved edit.
  const applyServerValues = useCallback((patch: Partial<ExperienceDraft>): void => {
    setBaseline((prev) => (prev ? { ...prev, ...patch } : prev));
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaveError(null);
  }, []);

  const handleUpload = useCallback(
    async (file: File): Promise<void> => {
      const uploadBotId = botId;
      setUploading(true);
      setUploadError(null);
      try {
        const { url } = await uploadLogo(file);
        if (botIdRef.current !== uploadBotId) return;
        updateDraft({ botLogo: url, avatarType: 'upload' });
      } catch (err) {
        if (botIdRef.current !== uploadBotId) return;
        setUploadError(err instanceof Error ? err.message : translateNow('agents.uploadFailedPleaseTryAgain') || 'Upload failed. Please try again.');
      } finally {
        if (botIdRef.current === uploadBotId) setUploading(false);
      }
    },
    [botId, updateDraft],
  );

  const handleSave = useCallback(async (): Promise<void> => {
    if (botId === null || !draft) return;
    const saveBotId = botId;
    // The widget display name IS the agent name, and the sidebar / header / bot
    // switcher render each agent's configured avatar - so the shared agent list
    // must be re-fetched whenever the name OR the avatar (type, uploaded logo,
    // or orb colour) changes, to keep those surfaces in sync.
    const identityChanged =
      baseline !== null &&
      (baseline.displayName !== draft.displayName ||
        baseline.avatarType !== draft.avatarType ||
        baseline.botLogo !== draft.botLogo ||
        baseline.orbColor !== draft.orbColor ||
        baseline.primaryColor !== draft.primaryColor);
    setSaving(true);
    setSaveError(null);
    try {
      await updateClientSettings(settingsFromDraft(draft, baseline), saveBotId);
      if (botIdRef.current !== saveBotId) return;
      setBaseline(draft);
      setJustSaved(true);
      if (identityChanged) void refresh();
    } catch (err) {
      if (botIdRef.current !== saveBotId) return;
      if (isBrandingAddonRequired(err)) {
        // Point at the cure, and put the branding toggle back where the server
        // has it. Left switched off, every later save on this page would fail
        // on the same field and block edits that have nothing to do with it.
        setActiveSection('branding');
        setDraft((prev) =>
          prev && baseline ? { ...prev, showBranding: baseline.showBranding } : prev,
        );
        setSaveError(
          translateNow('agents.brandingAddOnRequiredToSave') ||
            'Hiding the “Powered by OyeChats” badge needs the branding removal add-on. Add it from the Remove branding card, then try again.',
        );
        return;
      }
      setSaveError(err instanceof Error ? err.message : translateNow('agents.couldNotSavePleaseTry') || 'Could not save. Please try again.');
    } finally {
      if (botIdRef.current === saveBotId) setSaving(false);
    }
  }, [botId, draft, baseline, refresh]);

  const handleDiscard = useCallback((): void => {
    setDraft(baseline);
    setSaveError(null);
    setJustSaved(false);
  }, [baseline]);

  const swatches = [...recommended, ...PRESET_SWATCHES];
  const dirty = draft !== null && baseline !== null && !draftsEqual(draft, baseline);
  const showLoading = agentLoading || (botId !== null && draft === null && loadError === null);

  const saveDisabled = !dirty || saving;

  return (
    <PageContainer width="wide">
      {showLoading ? (
        <LoadingState />
      ) : botId === null ? (
        <EmptyState
          icon={Eye}
          title={agentError ? t('agents.couldntLoadThisChatbot') || 'Couldn’t load this chatbot' : t('agents.chatbotNotFound') || 'Chatbot not found'}
          description={
            agentError
              ? t('agents.weHitAProblemLoading') || 'We hit a problem loading your chatbots. Refresh to try again.'
              : t('agents.thisChatbotDoesntExistOr') || 'This chatbot doesn’t exist or you don’t have access to it.'
          }
        />
      ) : loadError && !draft ? (
        <EmptyState
          icon={Eye}
          title={t('agents.couldntLoadSettings') || 'Couldn’t load settings'}
          description={loadError}
          action={
            <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)}>
              {t('agents.tryAgain') || 'Try again'}
            </Button>
          }
        />
      ) : draft ? (
        <div className="flex flex-col gap-8">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* Editor column */}
          <div className="flex min-w-0 flex-col gap-6">
            <Tabs
              tabs={sectionTabs}
              value={activeSection}
              onChange={(key) => {
                if (isSectionKey(key)) setActiveSection(key);
              }}
              ariaLabel={t('agents.experienceSections') || 'Experience sections'}
            />

            <div
              role="tabpanel"
              id={`tabpanel-${activeSection}`}
              aria-labelledby={`tab-${activeSection}`}
            >
              {activeSection === 'branding' && (
                <BrandingSection
                  draft={draft}
                  onChange={updateDraft}
                  botId={botId}
                  swatches={swatches}
                  uploading={uploading}
                  uploadError={uploadError}
                  onUpload={handleUpload}
                  avatarIsLive={
                    baseline !== null &&
                    baseline.avatarType === draft.avatarType &&
                    (draft.avatarType === 'upload'
                      ? baseline.botLogo === draft.botLogo
                      : draft.avatarType === 'orb'
                        ? baseline.orbColor === draft.orbColor
                        : true)
                  }
                />
              )}
              {activeSection === 'messages' && (
                <MessagesSection draft={draft} onChange={updateDraft} multilingual={multilingual} />
              )}
              {activeSection === 'personality' && (
                <PersonalitySection
                  draft={draft}
                  onChange={updateDraft}
                  botId={botId}
                  canDetect={Boolean(agent?.crawl_completed_at)}
                  onServerApply={applyServerValues}
                />
              )}
              {activeSection === 'language' && <BotConfigSection variant="language" />}
              {activeSection === 'liveChatLeads' && <BotConfigSection variant="handoff" />}
              {activeSection === 'servicesCopy' && <BotConfigSection variant="content" />}
            </div>

            {/* Sticky save bar - appears whenever there's something to act on. */}
            {(dirty || saving || saveError || justSaved) && (
              <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-between gap-3 rounded-t-xl border-t border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-3 shadow-[var(--ds-shadow-lg)]">
                <p
                  role="status"
                  aria-live="polite"
                  className="min-w-0 truncate text-[13px] text-[var(--ds-text-muted)]"
                >
                  {saveError ? (
                    <span className="text-[var(--ds-danger)]">{saveError}</span>
                  ) : saving ? (
                    t('agents.saving') || 'Saving…'
                  ) : justSaved && !dirty ? (
                    t('agents.allChangesSaved') || 'All changes saved'
                  ) : (
                    t('agents.youHaveUnsavedChanges') || 'You have unsaved changes'
                  )}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDiscard}
                    disabled={!dirty || saving}
                  >
                    {t('agents.discard') || 'Discard'}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={saveDisabled}
                    aria-label={t('agents.saveChanges') || 'Save changes'}
                  >
                    {saving ? t('agents.saving') || 'Saving…' : t('agents.saveChanges') || 'Save changes'}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Preview column */}
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <div className="rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-5">
              <div className="mb-4 flex items-center justify-between gap-2">
                <h2 className="text-[15px] font-semibold tracking-tight text-[var(--ds-text)]">
                  {t('agents.preview') || 'Preview'}
                </h2>
                {agent?.bot_key && (
                  <button
                    type="button"
                    onClick={() => setWebsitePreviewOpen((v) => !v)}
                    title={t('agents.previewOnMyWebsite') || 'Preview on my website'}
                    aria-label={t('agents.previewOnMyWebsite') || 'Preview on my website'}
                    aria-pressed={websitePreviewOpen}
                    className={cn(
                      'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]',
                      websitePreviewOpen
                        ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]'
                        : 'border-[var(--ds-border)] text-[var(--ds-text-subtle)] hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]',
                    )}
                  >
                    <Globe size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
              <ExperiencePreview
                draft={draft}
                agentName={draft.displayName.trim() || agent?.name || t('agents.yourChatbot') || 'Your chatbot'}
              />
            </div>
          </aside>
        </div>

        {/* On-demand "preview on my website" - loads the hosted demo page (which
            overlays the live widget on the customer's URL) in an iframe. Opened
            from the Preview card's corner launcher above. */}
        <WebsitePreviewPanel
          botKey={agent?.bot_key ?? null}
          website={agent?.website ?? null}
          open={websitePreviewOpen}
          onClose={() => setWebsitePreviewOpen(false)}
        />
        </div>
      ) : null}
    </PageContainer>
  );
}

/** Two-column skeleton mirroring the loaded layout so the shift on load is minimal. */
function LoadingState(): ReactElement {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex flex-col gap-6">
        <Skeleton className="h-9 w-72" />
        <div className="space-y-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-10 w-full max-w-md" />
          <Skeleton className="h-10 w-full max-w-md" />
          <Skeleton className="h-24 w-full max-w-md" />
        </div>
      </div>
      <div className="hidden lg:block">
        <Skeleton className="h-[520px] w-full rounded-2xl" />
      </div>
    </div>
  );
}
