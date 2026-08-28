import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBot, updateBot } from '../../../services/api';
import { keys } from '../../../query/keys';
import { useAgent } from '../../../context/AgentContext';
import { asApiError, errorMessage, isForbidden } from './experience-api';
import {
  answerIsStale,
  changedSections,
  draftFromBot,
  draftsEqual,
  isSavable,
  metaFromBot,
  normalizeDraft,
  patchFromDraft,
  validateDraft,
  type DraftErrors,
  type ExperienceDraft,
  type ExperienceMeta,
  type SectionKey,
} from './experience-model';
import { t as translateNow } from '../../../i18n/i18n';

/**
 * Everything this surface reads and writes, keyed by the chatbot in the URL.
 *
 * **The URL is the only source of the chatbot's identity here.** Not the
 * shell's chatbot switcher, which is a workspace-scope control the user sets
 * for the inbox and the analytics pages and which has no business naming the
 * record an agent-scoped editor writes to. The console this replaces read it
 * from the switcher in two places, and the two bugs that produced are the
 * reason this hook exists as the only door: the preview streamed replies from
 * whichever chatbot the switcher happened to hold (B6), and the business-hours
 * editor wrote to `bots[0]` regardless of anything (B1), so chatbots 2..N could
 * never be given a schedule at all.
 *
 * The route id is used directly rather than resolved through the workspace's
 * chatbot list first. That list is a convenience; making the page wait for it
 * only adds a way for the id the page edits to disagree with the id in the
 * address bar.
 */

export type LoadState = 'loading' | 'ready' | 'missing' | 'forbidden' | 'error';

export interface ExperienceState {
  /** The chatbot in the URL. `null` only when the route param is not a number. */
  agentId: number | null;
  /** The chatbot's name, for chrome that must render before the record loads. */
  agentName: string;

  status: LoadState;
  loadError: string | null;
  retry: () => void;

  draft: ExperienceDraft | null;
  baseline: ExperienceDraft | null;
  meta: ExperienceMeta | null;

  errors: DraftErrors;
  dirty: boolean;
  dirtySections: SectionKey[];
  /** True when a saved-settings preview would answer with superseded wording. */
  answerStale: boolean;

  update: (patch: Partial<ExperienceDraft>) => void;
  /** Commit values the server has already stored, without them reading as edits. */
  commitServerValues: (patch: Partial<ExperienceDraft>) => void;
  discard: () => void;
  save: () => Promise<void>;

  saving: boolean;
  saveError: string | null;
  /** Set after a save that changed nothing on the server but tidied the draft. */
  savedAt: number | null;
  /** True once a write has been refused: the seat may read but not reconfigure. */
  readOnly: boolean;
}

interface Loaded {
  agentId: number;
  draft: ExperienceDraft;
  baseline: ExperienceDraft;
  meta: ExperienceMeta;
}

/** How long the "Saved" confirmation stays up before the bar retires itself. */
const SAVED_NOTICE_MS = 4000;

const NO_ERRORS: DraftErrors = {};
const NO_SECTIONS: SectionKey[] = [];

export function useExperience(): ExperienceState {
  const { agent, agentId: routeParam, refresh } = useAgent();
  const queryClient = useQueryClient();

  const parsed = Number(routeParam);
  const agentId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;

  const record = useQuery({
    queryKey: keys.agents.detail(agentId ?? 0),
    queryFn: () => getBot(agentId as number),
    enabled: agentId !== null,
    // A 403 is a seat's answer and a 404 is a wrong id. Neither becomes true by
    // asking again, and the shared client already declines to retry a 4xx.
    staleTime: 30_000,
  });

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [readOnly, setReadOnly] = useState(false);

  // The chatbot an in-flight save belongs to, so a response that lands after
  // the user has navigated to a different chatbot cannot write onto it.
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;

  /**
   * Adopt the server's record.
   *
   * A fresh record replaces the draft when the chatbot changed, or when there
   * is nothing unsaved to lose — the second case is what lets a crawl that
   * derived an avatar while this page sat open show up without a reload. When
   * the draft *is* dirty the server's copy is ignored: silently replacing
   * someone's unsaved work with a background refetch is the worst outcome
   * available, and it is invisible until they notice the field they edited.
   */
  useEffect(() => {
    const data = record.data;
    if (!data || agentId === null) return;
    const raw = data as unknown as Record<string, unknown>;
    setLoaded((prev) => {
      const next: Loaded = {
        agentId,
        draft: draftFromBot(raw),
        baseline: draftFromBot(raw),
        meta: metaFromBot(raw),
      };
      if (!prev || prev.agentId !== agentId) return next;
      if (!draftsEqual(prev.draft, prev.baseline)) return prev;
      if (draftsEqual(prev.baseline, next.baseline)) return prev;
      return next;
    });
  }, [record.data, agentId]);

  // Transient feedback belongs to one chatbot. Without this, saving chatbot A
  // and switching to B shows "saved" over B's untouched form.
  useEffect(() => {
    setSaveError(null);
    setSavedAt(null);
    setReadOnly(false);
  }, [agentId]);

  // The confirmation is transient. A save bar that never leaves stops being a
  // status and becomes furniture, and the next real "unsaved changes" then has
  // to compete with it for the user's attention.
  useEffect(() => {
    if (savedAt === null) return undefined;
    const timer = window.setTimeout(() => setSavedAt(null), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [savedAt]);

  const current = loaded && loaded.agentId === agentId ? loaded : null;

  const errors = useMemo(
    () => (current ? validateDraft(current.draft) : NO_ERRORS),
    [current],
  );
  const dirtySections = useMemo(
    () => (current ? changedSections(current.draft, current.baseline) : NO_SECTIONS),
    [current],
  );

  const update = useCallback((patch: Partial<ExperienceDraft>): void => {
    setSaveError(null);
    setSavedAt(null);
    setLoaded((prev) => (prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev));
  }, []);

  const commitServerValues = useCallback((patch: Partial<ExperienceDraft>): void => {
    setSaveError(null);
    setLoaded((prev) =>
      prev
        ? { ...prev, draft: { ...prev.draft, ...patch }, baseline: { ...prev.baseline, ...patch } }
        : prev,
    );
  }, []);

  const discard = useCallback((): void => {
    setSaveError(null);
    setSavedAt(null);
    setLoaded((prev) => (prev ? { ...prev, draft: prev.baseline } : prev));
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (!current || agentId === null || saving) return;
    if (!isSavable(validateDraft(current.draft))) return;

    const normalized = normalizeDraft(current.draft);
    const patch = patchFromDraft(normalized, current.baseline);
    const saveAgentId = agentId;

    // Nothing the server needs to hear — an added-then-emptied row, or a value
    // typed back to what it already was. Commit the tidy-up locally so the save
    // bar clears rather than sending an empty PATCH.
    if (Object.keys(patch).length === 0) {
      setLoaded((prev) =>
        prev && prev.agentId === saveAgentId
          ? { ...prev, draft: normalized, baseline: normalized }
          : prev,
      );
      setSavedAt(Date.now());
      return;
    }

    // The widget's display name IS the chatbot's name, and the rail, the top
    // bar and the switcher all render its avatar — so those have to be told.
    const identityChanged =
      normalized.displayName !== current.baseline.displayName ||
      normalized.avatarType !== current.baseline.avatarType ||
      normalized.botLogo !== current.baseline.botLogo ||
      normalized.orbColor !== current.baseline.orbColor ||
      normalized.primaryColor !== current.baseline.primaryColor;

    setSaving(true);
    setSaveError(null);
    try {
      await updateBot(saveAgentId, patch);
      if (agentIdRef.current !== saveAgentId) return;
      setLoaded((prev) =>
        prev && prev.agentId === saveAgentId
          ? { ...prev, draft: normalized, baseline: normalized }
          : prev,
      );
      setSavedAt(Date.now());
      // `PATCH /bots/{id}` answers with a status message rather than the bot, so
      // the cache is invalidated rather than written through.
      void queryClient.invalidateQueries({ queryKey: keys.agents.detail(saveAgentId) });
      if (identityChanged) void refresh();
    } catch (cause) {
      if (agentIdRef.current !== saveAgentId) return;
      if (isForbidden(cause)) {
        setReadOnly(true);
        setSaveError(
          errorMessage(
            cause,
            translateNow('agents.yourSeatCanReadThis') || 'Your seat can read this chatbot but not change it. Ask a workspace admin to make this edit.',
          ),
        );
      } else {
        setSaveError(errorMessage(cause, translateNow('agents.weCouldNotSaveYour') || 'We could not save your changes. Please try again.'));
      }
    } finally {
      if (agentIdRef.current === saveAgentId) setSaving(false);
    }
  }, [current, agentId, saving, queryClient, refresh]);

  const status: LoadState = (() => {
    if (agentId === null) return 'missing';
    if (current) return 'ready';
    if (record.isPending) return 'loading';
    if (record.isError) {
      if (isForbidden(record.error)) return 'forbidden';
      if (asApiError(record.error).status === 404) return 'missing';
      return 'error';
    }
    return 'loading';
  })();

  return {
    agentId,
    agentName: current?.draft.displayName.trim() || agent?.name || translateNow('agents.thisChatbot') || 'This chatbot',
    status,
    loadError:
      status === 'error' ? errorMessage(record.error, translateNow('agents.weCouldNotLoadThis2') || 'We could not load this chatbot.') : null,
    retry: () => void record.refetch(),

    draft: current?.draft ?? null,
    baseline: current?.baseline ?? null,
    meta: current?.meta ?? null,

    errors,
    dirty: dirtySections.length > 0,
    dirtySections,
    answerStale: current ? answerIsStale(current.draft, current.baseline) : false,

    update,
    commitServerValues,
    discard,
    save,

    saving,
    saveError,
    savedAt,
    readOnly,
  };
}
