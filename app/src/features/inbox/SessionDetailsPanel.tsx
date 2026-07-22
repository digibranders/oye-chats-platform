import { useEffect, useState, type ReactElement } from 'react';
import { Building2, Mail, MapPin, Monitor, Phone, User } from 'lucide-react';
import { Skeleton, StatusBadge } from '../../design-system';
import { getSessionDetails } from '../../services/api';
import type { SessionDetails } from './liveChatProtocol';
import { relativeTime } from './liveChatHelpers';

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
 * SessionDetailsPanel — the right rail. Loads and displays the visitor's identity,
 * geo/device, qualification (BANT), and conversation metadata for the selected
 * live chat via `getSessionDetails`.
 */
export function SessionDetailsPanel({ sessionId }: SessionDetailsPanelProps): ReactElement {
  const [details, setDetails] = useState<SessionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

      <Field label="Context">
        <div className="space-y-1.5">
          {details.location && <Row icon={<MapPin size={14} />} value={details.location} />}
          {details.device && <Row icon={<Monitor size={14} />} value={details.device} />}
          <div className="flex flex-wrap gap-1.5 pt-1">
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

      <Field label="Session">
        <div className="space-y-1 text-[12px] text-[var(--ds-text-muted)]">
          {details.created_at && <p>Started {relativeTime(details.created_at)} ago</p>}
          {details.last_active_at && <p>Last active {relativeTime(details.last_active_at)} ago</p>}
          {details.operator_name && <p>Handled by {details.operator_name}</p>}
        </div>
      </Field>
    </div>
  );
}
