import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { useBlocker } from 'react-router-dom';
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
import { DeveloperAccessSection } from './DeveloperAccessSection';

/**
 * Order-independent serialization. `bantConfig` is an opaque server object whose
 * key order isn't guaranteed, so a plain `JSON.stringify` could report a false
 * "dirty" if the payload ever re-serializes with a different key order. Sorting
 * keys recursively makes the comparison depend on values, not insertion order.
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** Stable structural equality for the plain-data draft. */
function draftsEqual(a: AdvancedDraft, b: AdvancedDraft): boolean {
  return stableStringify(a) === stableStringify(b);
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

  // Reset the surface when the URL switches to a different agent (the component
  // stays mounted across `:agentId` changes). Done as a render-phase adjustment
  // — React's recommended pattern for resetting state on a prop change — so the
  // skeleton shows immediately and no stale draft, saved banner, or error card
  // from the previous agent leaks in before the new fetch resolves.
  const [loadedAgentId, setLoadedAgentId] = useState<number | null>(agentId);
  if (agentId !== loadedAgentId) {
    setLoadedAgentId(agentId);
    setDraft(null);
    setInitial(null);
    setSavedTick(0);
    setSaveError(null);
    setLoadError(null);
  }

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

  const setBantConfig = useCallback((config: Record<string, unknown>) => {
    setSaveError(null);
    setDraft((prev) => (prev ? { ...prev, bantConfig: config } : prev));
  }, []);

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

  // Guard unsaved edits: block in-app navigation to another route while dirty…
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) =>
        dirty && currentLocation.pathname !== nextLocation.pathname,
      [dirty],
    ),
  );

  // …and warn before a full-page unload (tab close / refresh).
  useEffect(() => {
    if (!dirty) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty]);

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
      const bantConfigChanged =
        stableStringify(draft.bantConfig) !== stableStringify(initial.bantConfig);

      // Widget-scoped settings persist through the settings endpoint; the
      // qualification framework + scoring config are a distinct concern saved via
      // updateBot (mirrors Qualification.jsx). Persist the framework whenever it
      // OR the bant_config changed, keeping the stored `framework` field in sync
      // with the selected framework.
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
      if (frameworkChanged || bantConfigChanged) {
        const qualificationPayload: Record<string, unknown> = {
          qualification_framework: draft.qualificationFramework,
        };
        if (draft.bantConfig) {
          qualificationPayload.bant_config = {
            ...draft.bantConfig,
            framework: draft.qualificationFramework,
          };
        }
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
      <div>
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
    <div>
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
              onBantConfigChange={setBantConfig}
            />

            <div className="border-t border-[var(--ds-border)]" />

            <WidgetBehaviorSection flags={draft.featureFlags} onToggle={toggleFlag} />

            <div className="border-t border-[var(--ds-border)]" />

            <TimingReliabilitySection config={draft.widgetConfig} onChange={setConfigField} />

            <div className="border-t border-[var(--ds-border)]" />

            <DeveloperAccessSection />

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

      {blocker.state === 'blocked' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="advanced-leave-title"
        >
          <Card className="w-full max-w-sm space-y-4 p-5 shadow-[var(--ds-shadow-md)]">
            <div>
              <h2
                id="advanced-leave-title"
                className="text-[15px] font-semibold text-[var(--ds-text)]"
              >
                Discard unsaved changes?
              </h2>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
                You have unsaved changes to this agent’s advanced settings. If you leave now, they’ll
                be discarded.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => blocker.reset?.()}>
                Keep editing
              </Button>
              <Button size="sm" onClick={() => blocker.proceed?.()}>
                Discard &amp; leave
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
