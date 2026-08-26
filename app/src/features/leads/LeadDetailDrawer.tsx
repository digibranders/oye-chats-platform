/**
 * LeadDetailDrawer - a right-anchored slide-over that answers "who is this lead
 * and what do they want?" without leaving the list.
 *
 * It shows the captured contact, a plain-language quality verdict with a score
 * ring, the qualification breakdown that produced that score, and the full chat
 * transcript. Implemented as an accessible dialog: `role="dialog"` +
 * `aria-modal`, an Escape-to-close handler, focus moved into the panel on open
 * and returned to the trigger on close, and a click-away scrim.
 */
import { Fragment, type ReactElement, useEffect, useRef, useState } from 'react';
import { formatTime } from '../../i18n/formatters';
import Markdown from 'react-markdown';
import {
  AlertCircle,
  Building2,
  Check,
  Mail,
  MapPin,
  MessageSquare,
  Monitor,
  Phone,
  StickyNote,
  Tag,
  User,
  X,
} from 'lucide-react';
import {
  Button,
  DayDivider,
  EmptyState,
  LockedFeatureCard,
  Skeleton,
  StatusBadge,
  Textarea,
  cn,
} from '../../design-system';
import { formatDayLabel, isNewDay } from '../../lib/messageDay';
import { useCountUp } from '../../hooks/useCountUp';
import { type ChatMessage, type LeadSignal } from '../../types/domain';
import { type LeadDetailData } from './useLeadDetail';
import { type LeadAnnotationController } from './useLeadAnnotations';
import { LeadInsights } from './LeadInsights';
import { VisitorIntelligenceSection } from './VisitorIntelligenceSection';
import {
  SCORE_TONE_VAR,
  TIER_META,
  companyDisplay,
  formatDateTime,
  formatLocation,
  humanizeDimension,
  normalizeTier,
  scoreTone,
} from './leadModel';
import { useTranslation } from '../../i18n/useTranslation';
import { t as translateNow } from '../../i18n/i18n';

export interface LeadDetailDrawerProps {
  data: LeadDetailData;
  onClose: () => void;
  /**
   * Which face of the drawer to show. `'detail'` (default) is the full lead
   * profile WITHOUT the transcript; `'chat'` shows ONLY the conversation
   * (opened by the list's "View chat" action). The two are intentionally
   * split so each surface answers one question.
   */
  view?: 'detail' | 'chat';
  /**
   * Free plan: the lead-intelligence detail is a paid surface. When `true`, the
   * `'detail'` face renders an upgrade teaser instead of the score / contact /
   * qualification sections. The `'chat'` face (conversation) is never locked.
   */
  locked?: boolean;
  /**
   * True when the caller's plan includes Visitor Intelligence
   * (Professional). Controls whether `VisitorIntelligenceSection` renders
   * the company signal / email validity / follow-up action, or a locked
   * teaser in their place. Independent of `locked`, a Starter client
   * (unlocked lead intelligence, no Visitor Intelligence) sees the full
   * drawer with only this one section gated.
   */
  visitorIntelligenceUnlocked?: boolean;
  /**
   * Operator-private notes & tags for this lead (localStorage-backed). Optional
   * so the drawer still renders standalone; when present, a "Private notes"
   * editor is shown. Owned by the page so list-row tag chips stay in sync.
   */
  annotations?: LeadAnnotationController | null;
}

/** A compact circular score gauge (0 to 100), tinted by tier tone. */
function ScoreRing({ score }: { score: number }): ReactElement {
  const clamped = Math.max(0, Math.min(100, score));
  // Tally the score up from 0 whenever a lead is selected; the ring sweep and
  // the number share this value so they animate in lockstep. Colour stays fixed
  // to the FINAL tier so it doesn't flicker through tones while counting.
  const animated = useCountUp(clamped);
  const size = 96;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (animated / 100) * circumference;
  const color = SCORE_TONE_VAR[scoreTone(clamped)];

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={
        translateNow('leads.qualificationScoreOutOf', { score: clamped }) ||
        `Qualification score ${clamped} out of 100`
      }
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
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-[var(--ds-text)] text-xl font-bold"
      >
        {animated}
      </text>
    </svg>
  );
}

function ContactRow({
  icon: Icon,
  value,
  secondary,
  logoUrl,
  description,
}: {
  icon: typeof Mail;
  value: string;
  /** Quieter line beneath the value. Used to keep the raw email domain
   *  visible under a resolved company name, rather than replacing it. */
  secondary?: string;
  /** Company logo, when the resolver found one. Replaces the generic icon. */
  logoUrl?: string;
  /** One-line company description from the resolver. */
  description?: string;
}): ReactElement {
  const [logoBroken, setLogoBroken] = useState(false);
  const showLogo = Boolean(logoUrl) && !logoBroken;

  return (
    <div className="flex items-start gap-2.5 text-[13px] text-[var(--ds-text)]">
      {showLogo ? (
        <img
          src={logoUrl}
          alt=""
          // Third-party URL from the company's own site. It can 404, move, or
          // be hotlink-blocked at any time, so a failure falls back to the
          // generic icon rather than leaving a broken-image glyph.
          onError={() => setLogoBroken(true)}
          // No referrer, matching `ProfileMenu`'s third-party avatar. The
          // visitor chooses which domain we crawl by typing an email at it,
          // so a hostile site can set `og:image` to a beacon and read the
          // operator's IP, UA and the moment they opened the lead. Lazy so it
          // only fires for a drawer actually scrolled into view.
          referrerPolicy="no-referrer"
          loading="lazy"
          className="mt-0.5 h-[15px] w-[15px] shrink-0 rounded-sm object-contain"
        />
      ) : (
        <Icon size={15} className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
      )}
      <span className="min-w-0">
        <span className="block break-words">{value}</span>
        {secondary && (
          <span className="block break-all text-[12px] text-[var(--ds-text-subtle)]">{secondary}</span>
        )}
        {description && (
          <span className="mt-1 block text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
            {description}
          </span>
        )}
      </span>
    </div>
  );
}

/** Short clock time (e.g. "2:34 PM") for a message's timestamp; empty if absent. */
function formatClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';
  return formatTime(new Date(parsed), { hour: 'numeric', minute: '2-digit' });
}

/**
 * Every distinct value a visitor stated for one dimension, in the order they
 * said them. Backs the per-dimension evidence list so a lead who mentioned
 * three different needs shows all three, not just the highest-scoring one.
 *
 * Operator score overrides are excluded. Their ``extracted_value`` is the raw
 * numeric score, not visitor-stated text. Values are de-duplicated
 * case-insensitively so a repeated identical mention appears once.
 */
function distinctSignalValues(
  signals: LeadSignal[] | undefined,
  dimension: string,
): string[] {
  if (!signals?.length) return [];
  const target = dimension.toLowerCase();
  const seen = new Set<string>();
  const values: string[] = [];
  for (const signal of signals) {
    if ((signal.dimension ?? '').toLowerCase() !== target) continue;
    if (signal.source === 'operator_override') continue;
    const value = (signal.extracted_value ?? '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

/** A message's time — the lead-detail API sends `timestamp`; fall back to
 *  `created_at` for any other shape. */
function messageTime(message: ChatMessage): string | null | undefined {
  return message.timestamp ?? message.created_at;
}

function TranscriptBubble({ message }: { message: ChatMessage }): ReactElement {
  const { t } = useTranslation();
  const text = message.content ?? message.message ?? '';
  const isVisitor = message.role === 'user';
  const roleLabel = isVisitor ? 'Visitor' : message.role === 'operator' ? 'Operator' : 'Chatbot';
  const time = formatClock(messageTime(message));
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
        <p className="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
          <span>{roleLabel}</span>
          {time && (
            <span className="font-normal normal-case tracking-normal opacity-80">{time}</span>
          )}
        </p>
        {text ? (
          isVisitor ? (
            // Visitor text is plain: render verbatim so their exact input shows.
            <p className="whitespace-pre-wrap break-words">{text}</p>
          ) : (
            // Bot/operator replies are markdown (bold, lists, links) - render it
            // so the transcript reads like the live chat, not raw `**asterisks**`.
            <div className="break-words [&_a]:underline [&_a]:underline-offset-2 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-0 [&_p]:empty:hidden [&_strong]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4">
              <Markdown>{text}</Markdown>
            </div>
          )
        ) : (
          <p className="italic text-[var(--ds-text-subtle)]">{t('leads.noText') || '(no text)'}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The private notes + tags editor. Mounted with a `key` of the lead's session
 * id by the caller, so switching leads remounts it and its local draft resets
 * from the incoming controller - no synchronous setState in an effect.
 */
function LeadAnnotationsSection({
  controller,
}: {
  controller: LeadAnnotationController;
}): ReactElement {
  const { t } = useTranslation();
  const { note, tags, saveNote, saveTags } = controller;
  const [noteDraft, setNoteDraft] = useState(note?.text ?? '');
  const [tagDraft, setTagDraft] = useState(tags.join(', '));
  const [noteJustSaved, setNoteJustSaved] = useState(false);
  const [tagsJustSaved, setTagsJustSaved] = useState(false);

  const noteChanged = noteDraft.trim() !== (note?.text ?? '');
  // Cheap dirty check - the controller re-normalises on save, so the worst case
  // is a redundant (idempotent) write, never lost input.
  const tagsChanged = tagDraft.trim() !== tags.join(', ');

  function handleSaveNote(): void {
    saveNote(noteDraft);
    setNoteJustSaved(true);
  }

  function handleSaveTags(): void {
    saveTags(tagDraft);
    setTagsJustSaved(true);
  }

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
        <StickyNote size={13} aria-hidden="true" />
        {t('leads.privateNotes') || 'Private notes'}
      </h3>
      <div className="space-y-4 rounded-xl border border-[var(--ds-border)] p-4">
        <p className="text-[12px] text-[var(--ds-text-subtle)]">
          {t('leads.onlyYourTeamSeesThese') || 'Only your team sees these - they stay in this browser and aren’t sent to the visitor.'}
        </p>

        {/* Note editor */}
        <div className="space-y-2">
          <label
            htmlFor="lead-note"
            className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]"
          >
            {t('leads.note') || 'Note'}
          </label>
          <Textarea
            id="lead-note"
            rows={3}
            value={noteDraft}
            placeholder={t('leads.addContextForYourTeam') || 'Add context for your team - next steps, who to loop in…'}
            onChange={(event) => {
              setNoteDraft(event.target.value);
              setNoteJustSaved(false);
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--ds-text-subtle)]">
              {noteJustSaved && !noteChanged ? (
                <span className="inline-flex items-center gap-1 text-[var(--ds-success)]">
                  <Check size={12} aria-hidden="true" />
                  {t('leads.saved') || 'Saved'}
                </span>
              ) : note ? (
                (t('leads.lastEdited', { when: formatDateTime(note.ts) }) || `Last edited ${formatDateTime(note.ts)}`)
              ) : (
                t('leads.notSavedYet') || 'Not saved yet'
              )}
            </span>
            <Button size="sm" variant="outline" onClick={handleSaveNote} disabled={!noteChanged}>
              {t('leads.saveNote') || 'Save note'}
            </Button>
          </div>
        </div>

        {/* Tag editor */}
        <div className="space-y-2 border-t border-[var(--ds-border)] pt-4">
          <label
            htmlFor="lead-tags"
            className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]"
          >
            <Tag size={12} aria-hidden="true" />
            {t('leads.tags') || 'Tags'}
          </label>
          {tags.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label={t('leads.savedTags') || 'Saved tags'}>
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
            id="lead-tags"
            type="text"
            value={tagDraft}
            placeholder={t('leads.eGEnterpriseFollowUp') || 'e.g. enterprise, follow-up, demo-requested'}
            onChange={(event) => {
              setTagDraft(event.target.value);
              setTagsJustSaved(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSaveTags();
              }
            }}
            className="h-9 w-full rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 text-[13px] text-[var(--ds-text)] outline-none transition-colors placeholder:text-[var(--ds-text-subtle)] focus-visible:border-[var(--ds-accent)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--ds-text-subtle)]">
              {tagsJustSaved && !tagsChanged ? (
                <span className="inline-flex items-center gap-1 text-[var(--ds-success)]">
                  <Check size={12} aria-hidden="true" />
                  {t('leads.saved') || 'Saved'}
                </span>
              ) : (
                t('leads.separateTagsWithCommas') || 'Separate tags with commas'
              )}
            </span>
            <Button size="sm" variant="outline" onClick={handleSaveTags} disabled={!tagsChanged}>
              {t('leads.saveTags') || 'Save tags'}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function LeadDetailDrawer({
  data,
  onClose,
  view = 'detail',
  locked = false,
  visitorIntelligenceUnlocked = false,
  annotations,
}: LeadDetailDrawerProps): ReactElement {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = 'lead-detail-heading';

  // Move focus into the panel on open; restore it to the trigger on close so a
  // keyboard user isn't dumped back at the top of the document. Lock body
  // scroll while open so the page behind the scrim can't scroll under the
  // full-height slide-over.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  // Escape closes the drawer; Tab / Shift+Tab is trapped inside the panel so a
  // keyboard user can't walk into the inert page behind an aria-modal dialog
  // (WAI-ARIA dialog pattern / WCAG 2.4.3).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        // Nothing focusable inside - keep focus pinned to the panel itself.
        event.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === panel) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
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
        aria-label={t('leads.closeLeadDetails') || 'Close lead details'}
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
            {view === 'chat' ? 'Conversation' : t('leads.leadDetails') || 'Lead details'}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('leads.close') || 'Close'}>
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
              title={t('leads.couldntLoadThisLead') || 'Couldn\'t load this lead'}
              description={error ?? (t('leads.pleaseCloseThisPanelAnd') || 'Please close this panel and try again.')}
            />
          </div>
        )}

        {status === 'ready' && detail && (
          <div className="space-y-6 p-5">
            {/* Free plan: the lead-intelligence detail is locked behind an
                upgrade teaser. The conversation ('chat' view) stays open. */}
            {view === 'detail' && locked && (
              <LockedFeatureCard intent="view_leads" />
            )}

            {view === 'detail' && !locked && (
              <>
            {/* Quality verdict */}
            {(() => {
              const tierKey = normalizeTier(detail.status);
              const tier = TIER_META[tierKey];
              return (
                <section className="flex items-center gap-4 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-4">
                  <ScoreRing score={detail.score} />
                  <div className="min-w-0">
                    <StatusBadge tone={tier.tone}>{t(`leads.tier.${tierKey}`) || tier.label}</StatusBadge>
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
                {t('leads.contact') || 'Contact'}
              </h3>
              <div className="space-y-2 rounded-xl border border-[var(--ds-border)] p-4">
                {detail.contact?.name && <ContactRow icon={User} value={detail.contact.name} />}
                {detail.contact?.email && <ContactRow icon={Mail} value={detail.contact.email} />}
                {detail.contact?.phone && <ContactRow icon={Phone} value={detail.contact.phone} />}
                {(() => {
                  // Resolved name with the raw domain beneath it, never
                  // instead of it. See `companyDisplay`.
                  const company = companyDisplay(detail.contact);
                  if (!company) return null;
                  const logo = detail.contact?.company_logo_url;
                  return (
                    <ContactRow
                      icon={Building2}
                      value={company.value}
                      secondary={company.secondary}
                      // The resolver returns a logo and a description too, and
                      // both were stored, plan-gated and typed while being
                      // rendered nowhere, two thirds of what the paid
                      // enrichment produces was invisible.
                      logoUrl={typeof logo === 'string' ? logo : undefined}
                      description={detail.contact?.company_description ?? undefined}
                    />
                  );
                })()}
                {formatLocation(detail.location) !== 'Unknown' && (
                  <ContactRow icon={MapPin} value={formatLocation(detail.location)} />
                )}
                {detail.device && <ContactRow icon={Monitor} value={detail.device} />}
                {!detail.contact?.name &&
                  !detail.contact?.email &&
                  !detail.contact?.phone &&
                  !detail.contact?.company && (
                    <p className="text-[13px] text-[var(--ds-text-subtle)]">
                      {t('leads.thisVisitorDidntShareContact') || 'This visitor didn\'t share contact details.'}
                    </p>
                  )}
              </div>
            </section>

            {/* Qualification breakdown */}
            {detail.bant && Object.keys(detail.bant).length > 0 && (
              <section className="space-y-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
                  {t('leads.whatWeLearned') || 'What we learned'}
                </h3>
                <div className="space-y-2.5">
                  {(() => {
                    // Derive the per-dimension max from the framework instead of a
                    // hardcoded 25 (a BANT-only assumption): the total score is 100
                    // shared across the framework's dimensions, so equal-weight max
                    // = 100 / dimensionCount (25 for BANT, 20 for a 5-dimension
                    // framework like MEDDIC). Floor it at the highest observed score
                    // so an unevenly-weighted dimension never overflows its bar.
                    const bant = detail.bant;
                    if (!bant) return null;
                    const dimensions = Object.entries(bant);
                    const scores = dimensions.map(([, dim]) => dim.score);
                    const dimensionMax = Math.max(
                      Math.round(100 / Math.max(dimensions.length, 1)),
                      ...scores,
                      1,
                    );
                    return dimensions.map(([key, dim]) => {
                      const ratio = dim.score / dimensionMax;
                      const pct = Math.min(ratio * 100, 100);
                      return (
                        <div key={key} className="rounded-xl border border-[var(--ds-border)] p-3.5">
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <span className="text-[13px] font-semibold text-[var(--ds-text)]">
                              {humanizeDimension(key)}
                            </span>
                            <span className="text-[11px] font-semibold text-[var(--ds-text-subtle)]">
                              {dim.score}/{dimensionMax}
                            </span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: SCORE_TONE_VAR[scoreTone(pct)],
                              }}
                            />
                          </div>
                          {(() => {
                            // Prefer the full evidence trail (every distinct
                            // value the visitor stated for this dimension); fall
                            // back to the single rolling value when signals
                            // aren't available (older leads, or the query was
                            // skipped). A multi-value list is what surfaces the
                            // 3 to 4 separate needs a visitor mentioned.
                            const values = distinctSignalValues(detail.signals, key);
                            if (values.length > 1) {
                              return (
                                <ul className="mt-2 space-y-1">
                                  {values.map((value, index) => (
                                    <li
                                      key={index}
                                      className="flex gap-2 text-[13px] text-[var(--ds-text-muted)]"
                                    >
                                      <span
                                        aria-hidden
                                        className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-[var(--ds-text-subtle)]"
                                      />
                                      <span>{value}</span>
                                    </li>
                                  ))}
                                </ul>
                              );
                            }
                            const single = values[0] ?? dim.value;
                            return single ? (
                              <p className="mt-2 text-[13px] text-[var(--ds-text-muted)]">
                                {single}
                              </p>
                            ) : null;
                          })()}
                        </div>
                      );
                    });
                  })()}
                </div>
              </section>
            )}

            {/* Source attribution + behavioural signals (rendered only when present) */}
            <LeadInsights detail={detail} />

            {/* Company signal, email validity, and the manual follow-up action */}
            <VisitorIntelligenceSection detail={detail} unlocked={visitorIntelligenceUnlocked} />
              </>
            )}

            {/* Conversation transcript, the ONLY thing the "View chat" face shows */}
            {view === 'chat' && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
                  <MessageSquare size={13} aria-hidden="true" />
                  {t('leads.conversation') || 'Conversation'}
                </h3>
                {detail.messages && detail.messages.length > 0 && (
                  <span className="text-[11px] text-[var(--ds-text-subtle)]">
                    {/* When the conversation took place (session start), NOT the
                        most recent activity. That lives in the "Last active"
                        footer below. ``created_at`` is fixed at session creation;
                        ``last_active_at`` moves on every new message. */}
                    {formatDateTime(detail.created_at ?? detail.last_active_at)}
                  </span>
                )}
              </div>
              {detail.messages && detail.messages.length > 0 ? (
                <div className="space-y-2.5">
                  {detail.messages.map((message, index, all) => {
                    // Insert a "Today / Yesterday / Aug 14" divider whenever the
                    // calendar day changes, so a conversation that spans several
                    // days (returning visitor) stays readable instead of a wall
                    // of bare clock times.
                    const prev = all[index - 1];
                    const showDivider = isNewDay(
                      messageTime(message),
                      prev ? messageTime(prev) : undefined,
                    );
                    return (
                      <Fragment key={message.id}>
                        {showDivider && <DayDivider label={formatDayLabel(messageTime(message))} />}
                        <TranscriptBubble message={message} />
                      </Fragment>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-xl border border-[var(--ds-border)] p-4 text-[13px] text-[var(--ds-text-subtle)]">
                  {t('leads.noConversationWasRecordedFor') || 'No conversation was recorded for this lead.'}
                </p>
              )}
            </section>
            )}

            {/* Operator-private notes & tags. Unlocked detail face only. */}
            {view === 'detail' && !locked && annotations && (
              <LeadAnnotationsSection key={detail.session_id} controller={annotations} />
            )}

            <footer className="border-t border-[var(--ds-border)] pt-4 text-[12px] text-[var(--ds-text-subtle)]">
              {t('leads.lastActive') || 'Last active'} {formatDateTime(detail.last_active_at)}
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
