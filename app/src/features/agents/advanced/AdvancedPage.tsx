import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { SlidersHorizontal, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import {
  PageContainer,
  Card,
  Button,
  Skeleton,
  EmptyState,
} from '../../../design-system';
import { useAgent } from '../../../context/AgentContext';
import {
  getClientSettings,
  updateClientSettings,
  updateBot,
  getFrameworkPresets,
} from '../../../services/api';
import {
  parseSettings,
  presetForFramework,
  type AdvancedDraft,
} from './advanced.config';
import { ScopeStrictnessSection } from './ScopeStrictnessSection';
import { QualificationSection } from './QualificationSection';
import { WidgetBehaviorSection } from './WidgetBehaviorSection';
import { TimingReliabilitySection } from './TimingReliabilitySection';

/** Stable structural equality for the plain-data draft. */
function draftsEqual(a: AdvancedDraft, b: AdvancedDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * AdvancedPage — the agent "Advanced" tab. Answers: *"How do I configure
 * technical behaviour?"* It gathers the power-user knobs (answering scope,
 * lead-qualification framework, widget behaviour flags, timing & reliability)
 * onto one draft-and-save surface. All data is the reused Bot payload, loaded
 * via `getClientSettings` and persisted via `updateClientSettings` / `updateBot`.
 */
export function AdvancedPage(): ReactElement {
  const { agent, loading: agentLoading, error: agentError } = useAgent();
  const agentId = agent?.id ?? null;

  const [draft, setDraft] = useState<AdvancedDraft | null>(null);
  const [initial, setInitial] = useState<AdvancedDraft | null>(null);
  const [presets, setPresets] = useState<Record<string, unknown>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);

  // Load the agent's technical settings + framework catalog. All state writes
  // happen inside the async task (never synchronously in the effect body) so a
  // slow network never blocks paint, and a stale agent switch is discarded.
  useEffect(() => {
    if (agentId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [rawSettings, frameworkPresets] = await Promise.all([
          getClientSettings(agentId),
          getFrameworkPresets(agentId).catch(() => ({}) as Record<string, unknown>),
        ]);
        if (cancelled) return;
        const parsed = parseSettings(rawSettings);
        setDraft(parsed);
        setInitial(parsed);
        setPresets(frameworkPresets ?? {});
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load settings.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, reloadKey]);

  // ── Draft mutators ─────────────────────────────────────────────────────────
  const setRelevanceThreshold = useCallback((value: number | null) => {
    setSaveError(null);
    setDraft((prev) => (prev ? { ...prev, relevanceThreshold: value } : prev));
  }, []);

  const setFramework = useCallback(
    (key: string) => {
      setSaveError(null);
      setDraft((prev) => {
        if (!prev) return prev;
        // Custom keeps the existing scoring model; a named framework adopts its
        // preset config (mirrors Qualification.jsx handleFrameworkChange).
        const preset = key === 'custom' ? null : presetForFramework(presets, key);
        return {
          ...prev,
          qualificationFramework: key,
          bantConfig: preset ?? prev.bantConfig,
        };
      });
    },
    [presets],
  );

  const toggleFlag = useCallback((flagKey: string, next: boolean) => {
    setSaveError(null);
    setDraft((prev) =>
      prev ? { ...prev, featureFlags: { ...prev.featureFlags, [flagKey]: next } } : prev,
    );
  }, []);

  const setConfigField = useCallback((configKey: string, storedValue: number) => {
    setSaveError(null);
    setDraft((prev) =>
      prev ? { ...prev, widgetConfig: { ...prev.widgetConfig, [configKey]: storedValue } } : prev,
    );
  }, []);

  const dirty = useMemo(
    () => draft !== null && initial !== null && !draftsEqual(draft, initial),
    [draft, initial],
  );

  const handleDiscard = useCallback(() => {
    setSaveError(null);
    setDraft(initial);
  }, [initial]);

  const handleSave = useCallback(async () => {
    if (agentId === null || !draft || !initial) return;
    setSaving(true);
    setSaveError(null);
    try {
      const frameworkChanged = draft.qualificationFramework !== initial.qualificationFramework;

      // Widget-scoped settings persist through the settings endpoint; the
      // qualification framework is a distinct concern saved via updateBot
      // (mirrors Qualification.jsx), including its preset scoring config.
      const tasks: Array<Promise<unknown>> = [
        updateClientSettings(
          {
            relevance_threshold: draft.relevanceThreshold,
            feature_flags: draft.featureFlags,
            widget_config: draft.widgetConfig,
          },
          agentId,
        ),
      ];
      if (frameworkChanged) {
        const qualificationPayload: Record<string, unknown> = {
          qualification_framework: draft.qualificationFramework,
        };
        if (draft.bantConfig) qualificationPayload.bant_config = draft.bantConfig;
        tasks.push(updateBot(agentId, qualificationPayload));
      }

      await Promise.all(tasks);
      setInitial(draft);
      setSavedTick((tick) => tick + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Something went wrong while saving.');
    } finally {
      setSaving(false);
    }
  }, [agentId, draft, initial]);

  // ── States: no agent / loading / error ──────────────────────────────────────
  if (agentId === null && !agentLoading) {
    return (
      <div className="px-4 py-6 md:px-8">
        <PageContainer title="Advanced">
          <EmptyState
            icon={SlidersHorizontal}
            title={agentError ? 'Couldn’t load this agent' : 'Agent not found'}
            description={
              agentError
                ? 'We couldn’t load this agent’s settings. Please try again.'
                : 'Pick an agent to configure its technical behaviour.'
            }
          />
        </PageContainer>
      </div>
    );
  }

  const loading = draft === null && loadError === null;

  return (
    <div className="px-4 py-6 md:px-8">
      <PageContainer
        title="Advanced"
        description="How your agent decides what to answer, qualifies leads, and behaves in the widget. These are power-user settings — the defaults suit most sites."
      >
        {loadError ? (
          <Card className="flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center">
            <AlertTriangle size={18} className="shrink-0 text-[var(--ds-danger)]" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-[var(--ds-text)]">
                We couldn’t load these settings
              </p>
              <p className="mt-1 text-[12px] text-[var(--ds-text-subtle)]">{loadError}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
              Try again
            </Button>
          </Card>
        ) : loading || !draft ? (
          <div className="space-y-6" aria-busy="true" aria-label="Loading settings">
            <Skeleton className="h-5 w-40" />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-56 w-full" />
          </div>
        ) : (
          <>
            <ScopeStrictnessSection
              value={draft.relevanceThreshold}
              onChange={setRelevanceThreshold}
            />

            <div className="border-t border-[var(--ds-border)]" />

            <QualificationSection
              framework={draft.qualificationFramework}
              bantConfig={draft.bantConfig}
              onFrameworkChange={setFramework}
            />

            <div className="border-t border-[var(--ds-border)]" />

            <WidgetBehaviorSection flags={draft.featureFlags} onToggle={toggleFlag} />

            <div className="border-t border-[var(--ds-border)]" />

            <TimingReliabilitySection config={draft.widgetConfig} onChange={setConfigField} />

            {/* Save bar — appears once there are unsaved edits. A saved
                confirmation persists (keyed by savedTick) until the next edit. */}
            {dirty ? (
              <div className="sticky bottom-4 z-10 mt-2">
                <Card className="flex flex-col items-stretch gap-3 p-4 shadow-[var(--ds-shadow-md)] sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-[13px] text-[var(--ds-text-muted)]">
                    {saveError ? (
                      <span className="inline-flex items-center gap-2 text-[var(--ds-danger)]">
                        <AlertTriangle size={14} aria-hidden="true" />
                        {saveError}
                      </span>
                    ) : (
                      'You have unsaved changes.'
                    )}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={handleDiscard} disabled={saving}>
                      Discard
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={saving}>
                      {saving ? (
                        <>
                          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                          Saving…
                        </>
                      ) : (
                        'Save changes'
                      )}
                    </Button>
                  </div>
                </Card>
              </div>
            ) : (
              savedTick > 0 && (
                <div
                  className="flex items-center gap-2 text-[13px] text-[var(--ds-success)]"
                  role="status"
                >
                  <CheckCircle2 size={16} aria-hidden="true" />
                  <span className="font-medium">All changes saved.</span>
                </div>
              )
            )}
          </>
        )}
      </PageContainer>
    </div>
  );
}
