import { useCallback, useEffect, useMemo, useState } from 'react';
import { draftsEqual } from './draftDiff';

export interface SettingsDraftOptions<T> {
  /** The chatbot being edited, or null while the URL is still resolving. */
  agentId: number | null;
  /** Fetch the saved values. Rejections become the page's error state. */
  load: (agentId: number, signal: { cancelled: boolean }) => Promise<T>;
  /**
   * Persist. Receives the edited draft and the values it was loaded from, so a
   * caller can send only the slices that actually changed — the qualification
   * config goes to a different endpoint from the widget settings, and PATCHing
   * both on every save would rewrite a config the user never opened.
   */
  save: (agentId: number, draft: T, initial: T) => Promise<void>;
}

export interface SettingsDraftState<T> {
  draft: T | null;
  /** The values currently on the server, for a diff-aware save. */
  initial: T | null;
  loading: boolean;
  /** Non-null when the initial load failed. `retry` is the way back. */
  loadError: string | null;
  retry: () => void;
  update: (updater: (previous: T) => T) => void;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  /** True after a successful save, until the next edit. */
  saved: boolean;
  commit: () => Promise<void>;
  discard: () => void;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The load → edit → save contract shared by Qualification and Behaviour.
 *
 * Both pages are long forms over the same `Bot` record, and both had exactly one
 * way to lose work: the previous single Advanced page kept its draft in state
 * with no guard on the *initial* load failing, so a network blip rendered a
 * skeleton that never resolved. Everything about staleness lives here instead of
 * twice in two page components:
 *
 * - **A chatbot switch resets the surface during render**, not in an effect, so
 *   the skeleton appears immediately and no draft, error or saved banner from
 *   the previous chatbot is ever shown under the new one's name.
 * - **Every state write happens inside the async task**, never synchronously in
 *   the effect body, and a superseded load is discarded by its own cancel flag.
 * - **`saved` clears on the next edit**, so "All changes saved" can never sit
 *   above an edited field.
 */
export function useSettingsDraft<T>({
  agentId,
  load,
  save,
}: SettingsDraftOptions<T>): SettingsDraftState<T> {
  const [draft, setDraft] = useState<T | null>(null);
  const [initial, setInitial] = useState<T | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Render-phase reset on a chatbot change — React's own documented pattern for
  // deriving state from a changed input, and the only version of this that does
  // not paint one frame of the previous chatbot's settings.
  const [loadedAgentId, setLoadedAgentId] = useState<number | null>(agentId);
  if (agentId !== loadedAgentId) {
    setLoadedAgentId(agentId);
    setDraft(null);
    setInitial(null);
    setLoadError(null);
    setSaveError(null);
    setSaved(false);
  }

  useEffect(() => {
    if (agentId === null) return undefined;
    const signal = { cancelled: false };
    void (async () => {
      try {
        const loaded = await load(agentId, signal);
        if (signal.cancelled) return;
        setDraft(loaded);
        setInitial(loaded);
        setLoadError(null);
      } catch (error) {
        if (signal.cancelled) return;
        setLoadError(message(error, 'We could not load these settings.'));
      }
    })();
    return () => {
      signal.cancelled = true;
    };
  }, [agentId, reloadKey, load]);

  const retry = useCallback(() => {
    setLoadError(null);
    setReloadKey((key) => key + 1);
  }, []);

  const update = useCallback((updater: (previous: T) => T) => {
    setSaveError(null);
    setSaved(false);
    setDraft((previous) => (previous === null ? previous : updater(previous)));
  }, []);

  const dirty = useMemo(
    () => draft !== null && initial !== null && !draftsEqual(draft, initial),
    [draft, initial],
  );

  const discard = useCallback(() => {
    setSaveError(null);
    setSaved(false);
    setDraft(initial);
  }, [initial]);

  const commit = useCallback(async () => {
    if (agentId === null || draft === null || initial === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await save(agentId, draft, initial);
      setInitial(draft);
      setSaved(true);
    } catch (error) {
      setSaveError(message(error, 'Something went wrong while saving.'));
    } finally {
      setSaving(false);
    }
  }, [agentId, draft, initial, save]);

  return {
    draft,
    initial,
    loading: agentId !== null && draft === null && loadError === null,
    loadError,
    retry,
    update,
    dirty,
    saving,
    saveError,
    saved,
    commit,
    discard,
  };
}
