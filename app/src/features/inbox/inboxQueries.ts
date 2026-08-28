import { useCallback, useEffect, useRef, useState } from 'react';
import { getChatHistory, getQualifiedBotSessions, getSessionDetails } from '../../services/api';
import { parseHistoryMessage } from './liveChatHelpers';
import type { OperatorMessage, QualifiedSession, SessionDetails } from './liveChatProtocol';
import { t as translateNow } from '../../i18n/i18n';

/**
 * The inbox's REST reads.
 *
 * Everything real-time comes down the operator socket; these three are the state
 * the socket does not carry — the AI's own conversations, a visitor's profile,
 * and the transcript of a conversation nobody has accepted yet. They live
 * together because they share one rule: a poll that fails keeps the last good
 * answer on screen rather than blanking a panel the operator is reading.
 */

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** Coerce the loose qualified-sessions payload into typed rows. */
export function parseQualifiedSessions(raw: Record<string, unknown>): QualifiedSession[] {
  const list = Array.isArray(raw.sessions) ? (raw.sessions as Array<Record<string, unknown>>) : [];
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
  return list
    .map((session) => ({
      session_id: String(session.session_id ?? ''),
      bot_id: typeof session.bot_id === 'number' ? session.bot_id : null,
      bot_name: str(session.bot_name),
      name: str(session.name) ?? (translateNow('inbox.visitor') || 'Visitor'),
      email: str(session.email),
      phone: str(session.phone),
      company: str(session.company),
      location: str(session.location),
      device: str(session.device),
      bant_tier: str(session.bant_tier) ?? 'unqualified',
      bant_score: num(session.bant_score),
      bant_dimensions_count: num(session.bant_dimensions_count),
      last_message_preview: str(session.last_message_preview),
      last_message_at: str(session.last_message_at),
    }))
    .filter((session) => session.session_id.length > 0);
}

/** Coerce the loose session-detail payload into the panel's shape. */
export function parseSessionDetails(raw: Record<string, unknown>): SessionDetails {
  const bant = (raw.bant ?? null) as Record<string, unknown> | null;
  const lead = (raw.lead_info ?? null) as Record<string, unknown> | null;
  return {
    session_id: String(raw.session_id ?? ''),
    status: str(raw.status),
    location: str(raw.location),
    device: str(raw.device),
    handoff_reason: str(raw.handoff_reason),
    created_at: str(raw.created_at),
    last_active_at: str(raw.last_active_at),
    message_count: typeof raw.message_count === 'number' ? raw.message_count : null,
    bot_name: str(raw.bot_name),
    department_name: str(raw.department_name),
    operator_name: str(raw.operator_name),
    visitor_metadata: (raw.visitor_metadata as Record<string, unknown> | null) ?? null,
    page_url: str(raw.page_url),
    referrer: str(raw.referrer),
    visitor_rating:
      typeof raw.visitor_rating === 'number' && raw.visitor_rating > 0 ? raw.visitor_rating : null,
    // The BASE language the conversation settled into ("hi"), and the full
    // tag it was pinned to ("hi-IN"). Both are null until Phase 2 resolves
    // one, which is the normal state for a single-language chatbot.
    language_code: str(raw.language_code),
    locale: str(raw.locale),
    bant: bant
      ? {
          need: str(bant.need),
          timeline: str(bant.timeline),
          authority: str(bant.authority),
          budget: str(bant.budget),
        }
      : null,
    lead_info: lead
      ? {
          name: str(lead.name),
          email: str(lead.email),
          phone: str(lead.phone),
          company: str(lead.company),
        }
      : null,
    // Passed through as the server built it. The panel renders it with the
    // same component the lead record uses, so narrowing it twice would be two
    // shapes to keep in step.
    quotation: (raw.quotation as SessionDetails['quotation']) ?? null,
  };
}

export interface QualifiedSessionsState {
  sessions: QualifiedSession[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * The AI's live conversations, ranked by qualification.
 *
 * Refetched when the socket says the set may have changed (`version`), not on a
 * timer: the backend already tells us, and a 10-second poll against a list this
 * expensive is how the previous console spent its request budget.
 */
export function useQualifiedSessions(enabled: boolean, version: number): QualifiedSessionsState {
  const [sessions, setSessions] = useState<QualifiedSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let active = true;

    // Every `setState` sits inside this async function rather than the effect
    // body, so none of them runs synchronously during the effect — the rule the
    // whole codebase follows, and the reason a load never cascades a render.
    async function load(): Promise<void> {
      setLoading(true);
      try {
        const raw = await getQualifiedBotSessions(50);
        if (!active) return;
        setSessions(parseQualifiedSessions(raw));
        setError(null);
      } catch (err: unknown) {
        if (!active) return;
        setError(err instanceof Error ? err.message : translateNow('inbox.couldNotLoadQualifiedConversations') || 'Could not load qualified conversations.');
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [enabled, version, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { sessions, loading, error, reload };
}

export interface SessionDetailsState {
  details: SessionDetails | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** A visitor's profile for the details pane. */
export function useSessionDetails(sessionId: string | null): SessionDetailsState {
  const [details, setDetails] = useState<SessionDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const tokenRef = useRef(0);

  useEffect(() => {
    const token = (tokenRef.current += 1);
    let active = true;

    async function load(): Promise<void> {
      if (!sessionId) {
        setDetails(null);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      // Cleared before the request, not after it succeeds: a stale profile under
      // a newly-selected visitor's name is worse than a moment of skeleton.
      setDetails(null);
      try {
        const raw = await getSessionDetails(sessionId);
        if (!active || token !== tokenRef.current) return;
        setDetails(parseSessionDetails(raw));
        setError(null);
      } catch (err: unknown) {
        if (!active || token !== tokenRef.current) return;
        setError(err instanceof Error ? err.message : translateNow('inbox.couldNotLoadThisVisitor') || 'Could not load this visitor.');
      } finally {
        if (active && token === tokenRef.current) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [sessionId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { details, loading, error, reload };
}

export interface TranscriptState {
  messages: OperatorMessage[];
  loading: boolean;
  error: string | null;
  /** Re-run the fetch. Wired to the transcript's own "Try again". */
  reload: () => void;
}

const TRANSCRIPT_POLL_MS = 5000;

/**
 * A read-only transcript, for a conversation this operator has not accepted.
 *
 * Polled while it is on screen so the operator watches the AI answer in near
 * real time — which is the whole reason to look at one of these before deciding
 * to step in. A failed poll is swallowed on purpose: the previous transcript is
 * still true, and replacing it with an error banner every time a request times
 * out makes the panel unreadable on a weak connection.
 */
export function useTranscript(sessionId: string | null, poll: boolean): TranscriptState {
  const [messages, setMessages] = useState<OperatorMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by `reload`, which re-runs the effect from the top — the same path
  // a session change takes, so a retry cannot diverge from a first load.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let first = true;

    async function fetchOnce(): Promise<void> {
      if (!sessionId) return;
      try {
        const history = await getChatHistory(sessionId, { limit: 100 });
        if (!active) return;
        setMessages(history.map(parseHistoryMessage));
        setError(null);
      } catch (err: unknown) {
        // Only the very first attempt may show an error: after that there is a
        // transcript on screen, and a transient failure must not remove it.
        if (!active || !first) return;
        setError(err instanceof Error ? err.message : translateNow('inbox.couldNotLoadThisConversation') || 'Could not load this conversation.');
      } finally {
        if (active) {
          first = false;
          setLoading(false);
        }
      }
    }

    async function start(): Promise<void> {
      setMessages([]);
      setError(null);
      setLoading(Boolean(sessionId));
      await fetchOnce();
    }

    void start();
    if (!sessionId || !poll) {
      return () => {
        active = false;
      };
    }
    const timer = window.setInterval(() => void fetchOnce(), TRANSCRIPT_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId, poll, attempt]);

  const reload = useCallback(() => setAttempt((count) => count + 1), []);

  return { messages, loading, error, reload };
}
