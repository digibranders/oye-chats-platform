import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import {
  Button,
  EmptyState,
  PageContainer,
  SectionHeader,
  Skeleton,
} from '../../../design-system';
import { Tabs, type TabItem } from '../../../design-system/components/Tabs';
import { useAgent } from '../../../context/AgentContext';
import { getClientSettings, updateClientSettings, uploadLogo } from '../../../services/api';
import {
  type ExperienceDraft,
  draftFromSettings,
  draftsEqual,
  settingsFromDraft,
} from './types';
import { BrandingSection } from './BrandingSection';
import { MessagesSection } from './MessagesSection';
import { PersonalitySection } from './PersonalitySection';
import { ExperiencePreview } from './ExperiencePreview';

type SectionKey = 'branding' | 'messages' | 'personality';

const SECTION_TABS: TabItem[] = [
  { key: 'branding', label: 'Branding' },
  { key: 'messages', label: 'Messages' },
  { key: 'personality', label: 'Personality' },
];

/** Brand-neutral fallback swatches, appended after any website-extracted colours. */
const PRESET_SWATCHES = ['#a21caf', '#4f46e5', '#0ea5e9', '#059669', '#e11d48', '#d97706'];

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * ExperiencePage — the agent's "Experience" tab. One job: let the user control
 * exactly what visitors see in the chat widget (branding, messages, personality)
 * with a live, pixel-faithful preview beside the editor. Loads once, edits
 * locally, and persists the whole draft on demand — surfacing loading, empty,
 * error, saving and saved states throughout.
 */
export function ExperiencePage(): ReactElement {
  const { agent, loading: agentLoading, error: agentError } = useAgent();
  const botId = agent?.id ?? null;

  const [baseline, setBaseline] = useState<ExperienceDraft | null>(null);
  const [draft, setDraft] = useState<ExperienceDraft | null>(null);
  const [recommended, setRecommended] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [activeSection, setActiveSection] = useState<SectionKey>('branding');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Load the agent's settings once per agent (and on retry). All setState here
  // runs inside async callbacks — never synchronously during the effect body.
  useEffect(() => {
    if (botId === null) return;
    let cancelled = false;
    setDraft(null);
    setBaseline(null);
    setLoadError(null);
    getClientSettings(botId)
      .then((raw) => {
        if (cancelled) return;
        const next = draftFromSettings(raw);
        setBaseline(next);
        setDraft(next);
        setRecommended(asStringArray(raw.recommended_colors));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load this agent’s settings.');
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

  const handleUpload = useCallback(
    async (file: File): Promise<void> => {
      setUploading(true);
      setUploadError(null);
      try {
        const { url } = await uploadLogo(file);
        updateDraft({ botLogo: url, avatarType: 'upload' });
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
      } finally {
        setUploading(false);
      }
    },
    [updateDraft],
  );

  const handleSave = useCallback(async (): Promise<void> => {
    if (botId === null || !draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateClientSettings(settingsFromDraft(draft), botId);
      setBaseline(draft);
      setJustSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [botId, draft]);

  const handleDiscard = useCallback((): void => {
    setDraft(baseline);
    setSaveError(null);
    setJustSaved(false);
  }, [baseline]);

  const swatches = [...recommended, ...PRESET_SWATCHES];
  const dirty = draft !== null && baseline !== null && !draftsEqual(draft, baseline);
  const showLoading = agentLoading || (botId !== null && draft === null && loadError === null);

  return (
    <PageContainer
      title="Experience"
      description="Control exactly what visitors see in your chat widget — colours, avatar, greeting and voice — with a live preview."
      width="wide"
    >
      {showLoading ? (
        <LoadingState />
      ) : botId === null ? (
        <EmptyState
          icon={Eye}
          title={agentError ? 'Couldn’t load this agent' : 'Agent not found'}
          description={
            agentError
              ? 'We hit a problem loading your agents. Refresh to try again.'
              : 'This agent doesn’t exist or you don’t have access to it.'
          }
        />
      ) : loadError && !draft ? (
        <EmptyState
          icon={Eye}
          title="Couldn’t load settings"
          description={loadError}
          action={
            <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)}>
              Try again
            </Button>
          }
        />
      ) : draft ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* Editor column */}
          <div className="flex min-w-0 flex-col gap-6">
            <Tabs
              tabs={SECTION_TABS}
              value={activeSection}
              onChange={(key) => setActiveSection(key as SectionKey)}
              ariaLabel="Experience sections"
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
                  swatches={swatches}
                  uploading={uploading}
                  uploadError={uploadError}
                  onUpload={handleUpload}
                />
              )}
              {activeSection === 'messages' && (
                <MessagesSection draft={draft} onChange={updateDraft} />
              )}
              {activeSection === 'personality' && (
                <PersonalitySection draft={draft} onChange={updateDraft} />
              )}
            </div>

            {/* Sticky save bar — appears whenever there's something to act on. */}
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
                    'Saving…'
                  ) : justSaved && !dirty ? (
                    'All changes saved'
                  ) : (
                    'You have unsaved changes'
                  )}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDiscard}
                    disabled={!dirty || saving}
                  >
                    Discard
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
                    {saving ? 'Saving…' : 'Save changes'}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Preview column */}
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <div className="rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-5">
              <SectionHeader title="Preview" className="mb-4" />
              <ExperiencePreview draft={draft} agentName={agent?.name ?? 'Your agent'} />
            </div>
          </aside>
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
