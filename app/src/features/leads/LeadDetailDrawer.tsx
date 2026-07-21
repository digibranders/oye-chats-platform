/**
 * LeadDetailDrawer — a right-anchored slide-over that answers "who is this lead
 * and what do they want?" without leaving the list.
 *
 * It shows the captured contact, a plain-language quality verdict with a score
 * ring, the qualification breakdown that produced that score, and the full chat
 * transcript. Implemented as an accessible dialog: `role="dialog"` +
 * `aria-modal`, an Escape-to-close handler, focus moved into the panel on open
 * and returned to the trigger on close, and a click-away scrim.
 */
import { type ReactElement, useEffect, useRef } from 'react';
import {
  AlertCircle,
  Building2,
  Mail,
  MapPin,
  MessageSquare,
  Monitor,
  Phone,
  User,
  X,
} from 'lucide-react';
import { Button, EmptyState, Skeleton, StatusBadge, cn } from '../../design-system';
import { type ChatMessage } from '../../types/domain';
import { type LeadDetailData } from './useLeadDetail';
import {
  SCORE_TONE_VAR,
  TIER_META,
  formatDateTime,
  humanizeDimension,
  normalizeTier,
  scoreTone,
} from './leadModel';

/** Highest score any single qualification dimension can contribute (BANT default). */
const DIMENSION_MAX = 25;

export interface LeadDetailDrawerProps {
  data: LeadDetailData;
  onClose: () => void;
}

/** A compact circular score gauge (0–100), tinted by tier tone. */
function ScoreRing({ score }: { score: number }): ReactElement {
  const clamped = Math.max(0, Math.min(100, score));
  const size = 96;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;
  const color = SCORE_TONE_VAR[scoreTone(clamped)];

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Qualification score ${clamped} out of 100`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--ds-bg-sunken)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.6s ease-out' }}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-[var(--ds-text)] text-xl font-bold"
      >
        {clamped}
      </text>
    </svg>
  );
}

function ContactRow({ icon: Icon, value }: { icon: typeof Mail; value: string }): ReactElement {
  return (
    <div className="flex items-center gap-2.5 text-[13px] text-[var(--ds-text)]">
      <Icon size={15} className="shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
      <span className="break-words">{value}</span>
    </div>
  );
}

function TranscriptBubble({ message }: { message: ChatMessage }): ReactElement {
  const text = message.content ?? message.message ?? '';
  const isVisitor = message.role === 'user';
  return (
    <div className={cn('flex', isVisitor ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed',
          isVisitor
            ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-text)]'
            : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text)]',
        )}
      >
        <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
          {isVisitor ? 'Visitor' : message.role === 'operator' ? 'Teammate' : 'AI agent'}
        </p>
        {text ? <p className="whitespace-pre-wrap break-words">{text}</p> : <p className="italic text-[var(--ds-text-subtle)]">(no text)</p>}
      </div>
    </div>
  );
}

export function LeadDetailDrawer({ data, onClose }: LeadDetailDrawerProps): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = 'lead-detail-heading';

  // Move focus into the panel on open; restore it to the trigger on close so a
  // keyboard user isn't dumped back at the top of the document.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // Escape closes the drawer.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const { status, detail, error } = data;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Scrim */}
      <button
        type="button"
        aria-label="Close lead details"
        onClick={onClose}
        className="absolute inset-0 bg-black/30 backdrop-blur-[1px] dark:bg-black/50"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)] outline-none"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-5 py-4">
          <h2 id={headingId} className="text-base font-bold text-[var(--ds-text)]">
            Lead details
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X size={18} aria-hidden="true" />
          </Button>
        </header>

        {status === 'loading' && (
          <div className="space-y-4 p-5">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {status === 'error' && (
          <div className="p-5">
            <EmptyState
              icon={AlertCircle}
              title="Couldn't load this lead"
              description={error ?? 'Please close this panel and try again.'}
            />
          </div>
        )}

        {status === 'ready' && detail && (
          <div className="space-y-6 p-5">
            {/* Quality verdict */}
            {(() => {
              const tier = TIER_META[normalizeTier(detail.status)];
              return (
                <section className="flex items-center gap-4 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-4">
                  <ScoreRing score={detail.score} />
                  <div className="min-w-0">
                    <StatusBadge tone={tier.tone}>{tier.label}</StatusBadge>
                    <p className="mt-2 text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
                      {tier.hint}
                    </p>
                  </div>
                </section>
              );
            })()}

            {/* Contact */}
            <section className="space-y-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
                Contact
              </h3>
              <div className="space-y-2 rounded-xl border border-[var(--ds-border)] p-4">
                {detail.contact?.name && <ContactRow icon={User} value={detail.contact.name} />}
                {detail.contact?.email && <ContactRow icon={Mail} value={detail.contact.email} />}
                {detail.contact?.phone && <ContactRow icon={Phone} value={detail.contact.phone} />}
                {detail.contact?.company && (
                  <ContactRow icon={Building2} value={detail.contact.company} />
                )}
                {detail.location && <ContactRow icon={MapPin} value={detail.location} />}
                {detail.device && <ContactRow icon={Monitor} value={detail.device} />}
                {!detail.contact?.name &&
                  !detail.contact?.email &&
                  !detail.contact?.phone &&
                  !detail.contact?.company && (
                    <p className="text-[13px] text-[var(--ds-text-subtle)]">
                      This visitor didn't share contact details.
                    </p>
                  )}
              </div>
            </section>

            {/* Qualification breakdown */}
            {detail.bant && Object.keys(detail.bant).length > 0 && (
              <section className="space-y-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
                  What we learned
                </h3>
                <div className="space-y-2.5">
                  {Object.entries(detail.bant).map(([key, dim]) => {
                    const pct = Math.min((dim.score / DIMENSION_MAX) * 100, 100);
                    return (
                      <div key={key} className="rounded-xl border border-[var(--ds-border)] p-3.5">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <span className="text-[13px] font-semibold text-[var(--ds-text)]">
                            {humanizeDimension(key)}
                          </span>
                          <span className="text-[11px] font-semibold text-[var(--ds-text-subtle)]">
                            {dim.score}/{DIMENSION_MAX}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: SCORE_TONE_VAR[scoreTone(dim.score * 4)],
                            }}
                          />
                        </div>
                        {dim.value && (
                          <p className="mt-2 text-[13px] text-[var(--ds-text-muted)]">{dim.value}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Transcript */}
            <section className="space-y-3">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
                <MessageSquare size={13} aria-hidden="true" />
                Conversation
              </h3>
              {detail.messages && detail.messages.length > 0 ? (
                <div className="space-y-2.5">
                  {detail.messages.map((message) => (
                    <TranscriptBubble key={message.id} message={message} />
                  ))}
                </div>
              ) : (
                <p className="rounded-xl border border-[var(--ds-border)] p-4 text-[13px] text-[var(--ds-text-subtle)]">
                  No conversation was recorded for this lead.
                </p>
              )}
            </section>

            <footer className="border-t border-[var(--ds-border)] pt-4 text-[12px] text-[var(--ds-text-subtle)]">
              Last active {formatDateTime(detail.last_active_at)}
              {/* TODO(leads): source attribution (UTM, referrer, page journey) is on
                  `detail.source` for eligible plans — render once a typed reader
                  and plan-entitlement gate land. */}
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
