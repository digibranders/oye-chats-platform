/**
 * useLeadAnnotations — operator-private notes and tags for leads.
 *
 * There is no server API for lead notes/tags, so these live in the browser's
 * `localStorage`, keyed by `session_id` (the same approach the legacy Leads page
 * used). The store is loaded once via a `useState` initializer — never a
 * synchronous `setState` inside an effect — and every write is an event-handler
 * mutation that updates React state and persists in the same tick.
 *
 * A single instance owns the whole map so the list (tag chips in a row) and the
 * detail drawer (the editor) stay in sync: the page holds the hook and hands a
 * per-session {@link LeadAnnotationController} down to the drawer.
 */
import { useCallback, useMemo, useState } from 'react';

/** A timestamped, free-text note attached to one lead. */
export interface LeadNote {
  /** The note body. Empty means "no note" (the entry is dropped). */
  readonly text: string;
  /** ISO timestamp of the last edit — rendered as "Last edited …". */
  readonly ts: string;
}

/** The per-session slice the drawer edits, with its persistence callbacks. */
export interface LeadAnnotationController {
  readonly note: LeadNote | null;
  readonly tags: readonly string[];
  /** Persist (or clear, when blank) this lead's note. */
  readonly saveNote: (text: string) => void;
  /** Persist this lead's tags from a raw comma-separated string. */
  readonly saveTags: (raw: string) => void;
}

export interface LeadAnnotationsStore {
  readonly notes: Readonly<Record<string, LeadNote>>;
  readonly tags: Readonly<Record<string, readonly string[]>>;
  /** Tags for one session (empty array when none) — a stable read for row chips. */
  readonly tagsFor: (sessionId: string) => readonly string[];
  /** Build the editing controller for one session (or `null` for no session). */
  readonly controllerFor: (sessionId: string | null) => LeadAnnotationController | null;
}

const NOTES_KEY = 'oyechats:lead-notes';
const TAGS_KEY = 'oyechats:lead-tags';
/** Cap tag count per lead so a paste can't bloat storage or the row layout. */
const MAX_TAGS = 12;

type NotesMap = Record<string, LeadNote>;
type TagsMap = Record<string, readonly string[]>;

/** Parse a stored note map defensively — a corrupt value yields an empty map. */
function readNotes(): NotesMap {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(NOTES_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: NotesMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as LeadNote).text === 'string' &&
        typeof (value as LeadNote).ts === 'string'
      ) {
        out[key] = { text: (value as LeadNote).text, ts: (value as LeadNote).ts };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Parse a stored tag map defensively — non-string entries are dropped. */
function readTags(): TagsMap {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TAGS_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: TagsMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        const clean = value.filter((v): v is string => typeof v === 'string');
        if (clean.length > 0) out[key] = clean;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Normalise a raw comma-separated string into a deduped, trimmed tag list. */
function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const tag = part.trim();
    if (!tag) continue;
    const dedupeKey = tag.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

const EMPTY_TAGS: readonly string[] = Object.freeze([]);

export function useLeadAnnotations(): LeadAnnotationsStore {
  const [notes, setNotes] = useState<NotesMap>(readNotes);
  const [tags, setTags] = useState<TagsMap>(readTags);

  const saveNote = useCallback((sessionId: string, text: string): void => {
    setNotes((prev) => {
      const next: NotesMap = { ...prev };
      const trimmed = text.trim();
      if (trimmed) {
        next[sessionId] = { text: trimmed, ts: new Date().toISOString() };
      } else {
        delete next[sessionId];
      }
      try {
        localStorage.setItem(NOTES_KEY, JSON.stringify(next));
      } catch {
        /* Storage full or unavailable (private mode) — keep the in-memory copy. */
      }
      return next;
    });
  }, []);

  const saveTags = useCallback((sessionId: string, raw: string): void => {
    setTags((prev) => {
      const next: TagsMap = { ...prev };
      const parsed = parseTags(raw);
      if (parsed.length > 0) {
        next[sessionId] = parsed;
      } else {
        delete next[sessionId];
      }
      try {
        localStorage.setItem(TAGS_KEY, JSON.stringify(next));
      } catch {
        /* See saveNote. */
      }
      return next;
    });
  }, []);

  const tagsFor = useCallback(
    (sessionId: string): readonly string[] => tags[sessionId] ?? EMPTY_TAGS,
    [tags],
  );

  const controllerFor = useCallback(
    (sessionId: string | null): LeadAnnotationController | null => {
      if (sessionId === null) return null;
      return {
        note: notes[sessionId] ?? null,
        tags: tags[sessionId] ?? EMPTY_TAGS,
        saveNote: (text: string) => saveNote(sessionId, text),
        saveTags: (raw: string) => saveTags(sessionId, raw),
      };
    },
    [notes, tags, saveNote, saveTags],
  );

  return useMemo(
    () => ({ notes, tags, tagsFor, controllerFor }),
    [notes, tags, tagsFor, controllerFor],
  );
}
