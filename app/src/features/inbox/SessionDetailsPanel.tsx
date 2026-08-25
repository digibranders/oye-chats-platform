import { useEffect, useState, type ReactElement } from 'react';
import { Building2, Globe, Link2, Mail, MapPin, Monitor, Phone, Star, Tag, User } from 'lucide-react';
import { Button, Skeleton, StatusBadge, Textarea } from '../../design-system';
import { getSessionDetails } from '../../services/api';
import { useLeadAnnotations, type LeadAnnotationController } from '../leads/useLeadAnnotations';
import type { SessionDetails } from './liveChatProtocol';
import { relativeTime } from './liveChatHelpers';
import { ConversationLanguageBadge } from './ConversationLanguageBadge';

export interface SessionDetailsPanelProps {
  sessionId: string;
}

/** Coerce the loosely-typed REST payload into the local `SessionDetails` shape. */
function toSessionDetails(raw: Record<string, unknown>): SessionDetails {
  const bantRaw = (raw.bant ?? null) as Record<string, unknown> | null;
  const leadRaw = (raw.lead_info ?? null) as Record<string, unknown> | null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
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
    language_code: str(raw.language_code),
    locale: str(raw.locale),
    bant: bantRaw
      ? {
          need: str(bantRaw.need),
          timeline: str(bantRaw.timeline),
          authority: str(bantRaw.authority),
          budget: str(bantRaw.budget),
        }
      : null,
    lead_info: leadRaw
      ? {
          name: str(leadRaw.name),
          email: str(leadRaw.email),
          phone: str(leadRaw.phone),
          company: str(leadRaw.company),
        }
      : null,
  };
}

function Row({ icon, value }: { icon: ReactElement; value: string }): ReactElement {
  return (
    <div className="flex items-center gap-2 text-[13px] text-[var(--ds-text)]">
      <span className="text-[var(--ds-text-subtle)]" aria-hidden="true">
        {icon}
      </span>
      <span className="truncate">{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">{label}</p>
      {children}
    </div>
  );
}

/**
 * PrivateNotesSection - operator-only notes & tags for this session, shared with
 * the Leads page via the same localStorage-backed store. Rendered inside the
 * "Private notes" field. Local drafts seed from the controller via `useState`
 * initializers; the parent panel is keyed by session id, so switching
 * conversations remounts this and resets the drafts - no effect needed.
 */
function PrivateNotesSection({ controller }: { controller: LeadAnnotationController }): ReactElement {
  const { note, tags, saveNote, saveTags } = controller;
  const [noteDraft, setNoteDraft] = useState(note?.text ?? '');
  const [tagDraft, setTagDraft] = useState(tags.join(', '));

  const noteChanged = noteDraft.trim() !== (note?.text ?? '');
  const tagsChanged = tagDraft.trim() !== tags.join(', ');

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-[var(--ds-text-subtle)]">
        Only your team sees this - it stays in this browser and is shared with the Leads page for this session.
      </p>

      {/* Note editor */}
      <div className="space-y-2">
        <label
          htmlFor="session-note"
          className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]"
        >
          Note
        </label>
        <Textarea
          id="session-note"
          rows={3}
          value={noteDraft}
          placeholder="Add context for your team - next steps, who to loop in…"
          onChange={(event) => setNoteDraft(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--ds-text-subtle)]">
            {note ? `Last edited ${relativeTime(note.ts)} ago` : 'Not saved yet'}
          </span>
          <Button size="sm" variant="outline" onClick={() => saveNote(noteDraft)} disabled={!noteChanged}>
            Save note
          </Button>
        </div>
      </div>

      {/* Tag editor */}
      <div className="space-y-2 border-t border-[var(--ds-border)] pt-3">
        <label
          htmlFor="session-tags"
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]"
        >
          <Tag size={12} aria-hidden="true" />
          Tags
        </label>
        {tags.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Saved tags">
            {tags.map((tag) => (
              <li
                key={tag}
                className="inline-flex items-center rounded-full bg-[var(--ds-accent-soft)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--ds-accent-text)]"
              >
                {tag}
              </li>
            ))}
          </ul>
        )}
        <input
          id="session-tags"
          type="text"
          value={tagDraft}
          placeholder="e.g. enterprise, follow-up, demo-requested"
          onChange={(event) => setTagDraft(event.target.value)}
          onBlur={() => {
            if (tagsChanged) saveTags(tagDraft);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (tagsChanged) saveTags(tagDraft);
            }
          }}
          className="h-9 w-full rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 text-[13px] text-[var(--ds-text)] outline-none transition-colors placeholder:text-[var(--ds-text-subtle)] focus-visible:border-[var(--ds-accent)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--ds-text-subtle)]">Separate tags with commas</span>
          <Button size="sm" variant="outline" onClick={() => saveTags(tagDraft)} disabled={!tagsChanged}>
            Save tags
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * SessionDetailsPanel - the right rail. Loads and displays the visitor's identity,
 * geo/device, qualification (BANT), and conversation metadata for the selected
 * live chat via `getSessionDetails`.
 */
export function SessionDetailsPanel({ sessionId }: SessionDetailsPanelProps): ReactElement {
  const [details, setDetails] = useState<SessionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Operator-private notes & tags (localStorage-backed) shared with the Leads
  // page for this session. The store reads synchronously, so the controller is
  // available immediately - independent of the async details fetch above.
  const annotations = useLeadAnnotations();
  const controller = annotations.controllerFor(sessionId);

  // The parent keys this panel by session id, so it mounts fresh per conversation:
  // initial state already reflects "loading", so no synchronous setState is needed.
  useEffect(() => {
    let active = true;
    getSessionDetails(sessionId)
      .then((raw) => {
        if (!active) return;
        setDetails(toSessionDetails(raw));
      })
      .catch(() => {
        if (!active) return;
        setError('Couldn’t load visitor details.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-4 w-24 rounded" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    );
  }

  if (error || !details) {
    return <div className="p-4 text-[13px] text-[var(--ds-text-muted)]">{error ?? 'No details available.'}</div>;
  }

  const lead = details.lead_info;
  const bant = details.bant;
  const meta = details.visitor_metadata;
  const browser =
    meta && (typeof meta.browser === 'string' || typeof meta.os === 'string')
      ? [meta.browser, meta.os].filter((v): v is string => typeof v === 'string' && v.length > 0).join(' · ')
      : null;
  // Show a compact hostname for URLs; fall back to the raw string.
  const shortUrl = (url: string): string => {
    try {
      return new URL(url).hostname.replace(/^www\./, '') + new URL(url).pathname.replace(/\/$/, '');
    } catch {
      return url;
    }
  };
  const bantEntries = bant
    ? (['need', 'budget', 'authority', 'timeline'] as const)
        .map((k) => [k, bant[k]] as const)
        .filter(([, v]) => Boolean(v))
    : [];

  return (
    <div className="space-y-5 overflow-y-auto p-4">
      <Field label="Visitor">
        <div className="space-y-1.5">
          <Row icon={<User size={14} />} value={lead?.name || 'Anonymous'} />
          {lead?.email && <Row icon={<Mail size={14} />} value={lead.email} />}
          {lead?.phone && <Row icon={<Phone size={14} />} value={lead.phone} />}
          {lead?.company && <Row icon={<Building2 size={14} />} value={lead.company} />}
        </div>
      </Field>

      {typeof details.visitor_rating === 'number' && (
        <Field label="Satisfaction">
          <div className="flex items-center gap-1" aria-label={`Rated ${details.visitor_rating} out of 5`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Star
                key={n}
                size={15}
                aria-hidden="true"
                className={
                  n <= (details.visitor_rating ?? 0)
                    ? 'fill-[var(--ds-warning)] text-[var(--ds-warning)]'
                    : 'text-[var(--ds-text-subtle)]'
                }
              />
            ))}
            <span className="ml-1 text-[12px] text-[var(--ds-text-muted)]">{details.visitor_rating}/5</span>
          </div>
        </Field>
      )}

      <Field label="Context">
        <div className="space-y-1.5">
          {details.location && <Row icon={<MapPin size={14} />} value={details.location} />}
          {details.device && <Row icon={<Monitor size={14} />} value={details.device} />}
          {browser && <Row icon={<Monitor size={14} />} value={browser} />}
          {details.page_url && <Row icon={<Globe size={14} />} value={shortUrl(details.page_url)} />}
          {details.referrer && <Row icon={<Link2 size={14} />} value={`from ${shortUrl(details.referrer)}`} />}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <ConversationLanguageBadge languageCode={details.language_code} />
            {details.bot_name && <StatusBadge tone="neutral">{details.bot_name}</StatusBadge>}
            {details.department_name && <StatusBadge tone="neutral">{details.department_name}</StatusBadge>}
            {typeof details.message_count === 'number' && (
              <StatusBadge tone="neutral">{details.message_count} messages</StatusBadge>
            )}
          </div>
        </div>
      </Field>

      {bantEntries.length > 0 && (
        <Field label="Qualification">
          <div className="space-y-2">
            {bantEntries.map(([dim, value]) => (
              <div key={dim}>
                <p className="text-[11px] font-medium capitalize text-[var(--ds-text-muted)]">{dim}</p>
                <p className="text-[13px] text-[var(--ds-text)]">{value}</p>
              </div>
            ))}
          </div>
        </Field>
      )}

      <Field label="Conversation">
        <div className="space-y-1 text-[12px] text-[var(--ds-text-muted)]">
          {details.created_at && <p>Started {relativeTime(details.created_at)} ago</p>}
          {details.last_active_at && <p>Last active {relativeTime(details.last_active_at)} ago</p>}
          {details.operator_name && <p>Handled by {details.operator_name}</p>}
        </div>
      </Field>

      {controller && (
        <Field label="Private notes">
          <PrivateNotesSection key={sessionId} controller={controller} />
        </Field>
      )}
    </div>
  );
}
