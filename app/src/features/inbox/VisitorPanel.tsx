import { useMemo, useState } from 'react';
import { ExternalLink, UserRound } from 'lucide-react';
import {
  Alert,
  Avatar,
  Button,
  Disclosure,
  EmptyState,
  ErrorState,
  Eyebrow,
  PaneHeader,
  PropertyGrid,
  Skeleton,
  Textarea,
  TagInput,
  Tooltip,
  cn,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelative,
  toast,
  type PropertyItem,
} from '../../ui';
import { ConversationLanguageBadge } from './ConversationLanguageBadge';
import { useLeadAnnotations } from '../leads/useLeadAnnotations';
import type { VisitorProfile } from './visitorProfile';
import { useTranslation } from '../../i18n/useTranslation';

const BANT_LABEL: Record<keyof NonNullable<VisitorProfile['bant']>, string> = {
  budget: 'Budget',
  authority: 'Authority',
  need: 'Need',
  timeline: 'Timeline',
};

/**
 * A URL, short enough to read.
 *
 * `break-all` on a UTM-tagged page URL inside a 288px column renders five or
 * six lines of mid-word breaks — the single ugliest block on this surface. The
 * host and path are what a reader recognises; the whole string is on the
 * tooltip and in the link itself.
 */
function prettyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const path = `${url.pathname}${url.search}`.replace(/\/$/, '');
    return `${url.host.replace(/^www\./, '')}${path}`;
  } catch {
    return raw.replace(/^https?:\/\/(www\.)?/, '');
  }
}

/**
 * Private notes and tags for this visitor.
 *
 * There is no server API for either, so they live in this browser under the
 * session id — the same store the Leads surface reads, which is what makes a
 * note written mid-conversation still there when the lead is followed up a week
 * later. It says so inside the disclosure, where it will actually be read,
 * rather than in an 11px caption above a form.
 *
 * Collapsed by default: the pane's contract is read-only fact about the
 * visitor, and 200px of editable chrome under eleven facts is not that.
 */
function PrivateNotes({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const store = useLeadAnnotations();
  const controller = store.controllerFor(sessionId);
  const [note, setNote] = useState(() => controller?.note?.text ?? '');
  const [tags, setTags] = useState<string[]>(() => [...(controller?.tags ?? [])]);

  if (!controller) return null;
  const dirty = note.trim() !== (controller.note?.text ?? '');

  return (
    <Disclosure
      headingLevel={3}
      summary={<span className="text-sm font-medium text-text-primary">Private notes</span>}
      regionLabel="Private notes about this visitor"
      trailing={
        controller.note ? (
          <span className="text-2xs text-text-tertiary">
            Edited {formatRelative(controller.note.ts)}
          </span>
        ) : null
      }
    >
      <div className="space-y-2.5">
        <Alert tone="neutral">
          {t('inbox.theseNotesAndTagsStay') || 'These notes and tags stay in this browser. Nobody else on your team can see them.'}
        </Alert>
        <Textarea
          rows={3}
          aria-label={t('inbox.privateNoteAboutThisVisitor') || 'Private note about this visitor'}
          placeholder={t('inbox.contextForLaterWhatThey') || 'Context for later — what they need, who to loop in…'}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          // Saved on blur rather than by a button: this console has a `SaveBar`
          // for real forms, and a manual save on a browser-local scratchpad is
          // one more thing to forget.
          onBlur={() => {
            if (!dirty) return;
            controller.saveNote(note);
            toast.success(t('inbox.noteSaved') || 'Note saved');
          }}
        />
        <TagInput
          label={t('inbox.tags') || 'Tags'}
          values={tags}
          onValuesChange={(next) => {
            setTags(next);
            controller.saveTags(next.join(', '));
          }}
          placeholder={t('inbox.addATag') || 'Add a tag…'}
        />
      </div>
    </Disclosure>
  );
}

export interface VisitorPanelProps {
  profile: VisitorProfile | null;
  sessionId: string | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /**
   * Where it is mounted.
   *
   * `pane` is the third column: its own left hairline, its own `PaneHeader`,
   * its own scroller and its own gutter. `drawer` is the same content inside
   * `Drawer`, which already draws all four — the panel used to render every one
   * of them a second time, so fields sat 36px from the edge behind a doubled
   * border with two scrollbars, the inner of which never reached the footer.
   */
  variant?: 'pane' | 'drawer';
  className?: string;
}

/**
 * Who you are talking to.
 *
 * One pane rather than the four scattered places this used to live: the row, a
 * tooltip, a modal and a separate details tab. Everything here is read-only fact
 * about the visitor, so it never competes with the conversation's own actions —
 * those stay in the conversation header, where the thing they act on is.
 *
 * The facts are a `PropertyGrid`, stacked rather than label-left/value-right:
 * this panel is 288px wide in the pane and 320px in the drawer that stands in
 * for it, and `rows` leaves 71px for the value at that measure. See the note in
 * the body.
 */
export function VisitorPanel({
  profile,
  sessionId,
  loading = false,
  error = null,
  onRetry,
  variant = 'pane',
  className,
}: VisitorPanelProps) {
  const { t } = useTranslation();
  const pane = variant === 'pane';
  // Stacked, in both presentations, because both are about 288px wide.
  //
  // `PropertyGrid`'s `rows` keeps a `minmax(7rem,10rem)` label column, so in
  // this pane the value column resolved to **71px**: `amara@example.com` broke
  // as `amara@ex / ample.com`, and `Northwind Logistics`, `Chrome · macOS` and
  // `20 Aug 2026, 08:24` each took two lines. Measured, the two layouts cost
  // the pane exactly the same 1,153px of scroll — because `rows` was already
  // spending two lines on most values — so this is legibility for free rather
  // than a trade. `stacked` is documented as the layout for "a column too
  // narrow to hold both", and 288px is that column.
  // No `Email` row: the header above renders the same address as a `mailto:`
  // link two lines higher. It was the same fact twice, and the copy in the
  // grid was the one that broke mid-word.
  const identity = useMemo<PropertyItem[]>(
    () =>
      profile
        ? [
            { label: t('inbox.phone') || 'Phone', value: profile.phone },
            { label: t('inbox.company') || 'Company', value: profile.company },
            { label: t('inbox.location') || 'Location', value: profile.location },
            { label: t('inbox.device') || 'Device', value: profile.device },
          ]
        : [],
    [profile, t],
  );

  const source = useMemo<PropertyItem[]>(() => {
    if (!profile) return [];
    const rows: PropertyItem[] = [];
    if (profile.pageUrl) {
      rows.push({
        label: t('inbox.onPage') || 'On page',
        value: (
          <Tooltip content={profile.pageUrl}>
            <a
              href={profile.pageUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="flex min-w-0 items-center gap-1.5 text-accent-600 underline-offset-2 hover:underline"
            >
              <span className="min-w-0 truncate">{prettyUrl(profile.pageUrl)}</span>
              <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
            </a>
          </Tooltip>
        ),
      });
    }
    if (profile.referrer) {
      rows.push({
        label: t('inbox.referredBy') || 'Referred by',
        value: (
          <Tooltip content={profile.referrer}>
            <span className="block min-w-0 truncate">{prettyUrl(profile.referrer)}</span>
          </Tooltip>
        ),
      });
    }
    return rows;
  }, [profile, t]);

  // An offline message has no session, so five of these seven are facts that
  // cannot exist for it rather than facts we looked for and did not find. Seven
  // em dashes in a row is a pane that looks broken and says nothing; `—` is
  // reserved for a value that is genuinely absent (DESIGN.md rule 10).
  const context = useMemo<PropertyItem[]>(() => {
    if (!profile) return [];
    const rows: PropertyItem[] = [{ label: t('inbox.chatbot') || 'Chatbot', value: profile.botName }];
    if (profile.kind === 'offline') {
      rows.push({
        label: t('inbox.received') || 'Received',
        value: profile.startedAt ? formatDateTime(profile.startedAt) : null,
      });
      return rows;
    }
    rows.push(
      { label: t('inbox.department') || 'Department', value: profile.departmentName },
      { label: t('inbox.assignedTo') || 'Assigned to', value: profile.operatorName },
      { label: t('inbox.started') || 'Started', value: profile.startedAt ? formatDateTime(profile.startedAt) : null },
      {
        label: t('inbox.lastActive') || 'Last active',
        value: profile.lastActiveAt ? formatRelative(profile.lastActiveAt) : null,
      },
      {
        label: t('inbox.messages') || 'Messages',
        value: profile.messageCount != null ? formatNumber(profile.messageCount) : null,
      },
      {
        label: t('inbox.ratedThisChat') || 'Rated this chat',
        value:
          profile.rating != null ? (
            <>
              <span className="figure">{profile.rating.toFixed(1)}</span>
              <span className="text-text-tertiary"> {t('inbox.outOf5') || 'out of 5'}</span>
            </>
          ) : null,
      },
    );
    return rows;
  }, [profile, t]);

  // A badge as the *label* of a paragraph made "Budget" green whenever a value
  // existed — colour carrying "has a value", which no other badge in the system
  // means. These are facts, so they are a property list, and `—` already says
  // "not established".
  const bant = useMemo<PropertyItem[]>(
    () =>
      profile?.bant
        ? (Object.keys(BANT_LABEL) as Array<keyof typeof BANT_LABEL>).map((key) => ({
            label: BANT_LABEL[key],
            value: profile.bant?.[key],
          }))
        : [],
    [profile],
  );

  const body = (() => {
    if (loading && !profile) {
      // The shape that arrives: an avatar and a title, then a run of 32px
      // property rows. Four naked bars made the pane jump on every selection.
      return (
        <div aria-busy className={cn(pane && 'p-cell')}>
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
          <div className="mt-4 space-y-3">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-3 w-full" />
            ))}
          </div>
        </div>
      );
    }

    if (error && !profile) {
      return <ErrorState size="panel" polite description={error} onRetry={onRetry} />;
    }

    if (!profile) {
      return (
        <EmptyState
          size="panel"
          icon={UserRound}
          title={t('inbox.noConversationOpen') || 'No conversation open'}
          description={t('inbox.pickAConversationToSee') || 'Pick a conversation to see who is on the other end.'}
        />
      );
    }

    return (
      <div className={cn('space-y-4', pane && 'p-cell')}>
        {/* Stale figures with a failed refetch behind them. The pane used to
            show them silently — `onRetry` was only reachable with no profile. */}
        {error ? (
          <Alert
            tone="warning"
            action={
              onRetry ? (
                <Button size="sm" onClick={onRetry}>
                  {t('inbox.tryAgain') || 'Try again'}
                </Button>
              ) : undefined
            }
          >
            {t('inbox.theseDetailsMayBeOut') || 'These details may be out of date.'}
          </Alert>
        ) : null}

        <div className="flex items-center gap-3">
          <Avatar size="lg" name={profile.name} />
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate text-base font-semibold text-text-primary">
              {profile.name}
              {/* Beside the name, not down in the fact list: which language
                  someone is writing in changes how the operator reads every
                  line above it. */}
              <ConversationLanguageBadge languageCode={profile.languageCode} />
            </p>
            {profile.email ? (
              <a
                href={`mailto:${profile.email}`}
                className="block truncate text-xs text-accent-600 underline-offset-2 hover:underline"
              >
                {profile.email}
              </a>
            ) : (
              <p className="text-xs text-text-tertiary">{t('inbox.noContactDetailsCaptured') || 'No contact details captured'}</p>
            )}
          </div>
        </div>

        {profile.handoffReason ? (
          <div className="border-l-[3px] border-l-border-strong pl-3">
            <Eyebrow>{t('inbox.whyTheyWantedAPerson') || 'Why they wanted a person'}</Eyebrow>
            <p className="mt-0.5 text-xs text-text-primary">{profile.handoffReason}</p>
          </div>
        ) : null}

        <PropertyGrid label={t('inbox.contactDetails') || 'Contact details'} layout="stacked" density="compact" items={identity} />

        {source.length > 0 ? (
          <div>
            <Eyebrow>{t('inbox.whereTheyCameFrom') || 'Where they came from'}</Eyebrow>
            <PropertyGrid layout="stacked" density="compact" items={source} className="mt-1" />
          </div>
        ) : null}

        <div>
          <Eyebrow>{t('inbox.thisConversation') || 'This conversation'}</Eyebrow>
          <PropertyGrid layout="stacked" density="compact" items={context} className="mt-1" />
        </div>

        {bant.length > 0 ? (
          <div>
            <Eyebrow>{t('inbox.whatTheAiLearned') || 'What the AI learned'}</Eyebrow>
            <PropertyGrid layout="stacked" density="compact" items={bant} className="mt-1" />
          </div>
        ) : null}

        {profile.quotation && profile.quotation.line_items.length > 0 ? (
          <div>
            <Eyebrow>{t('inbox.whatTheyPricedUp') || 'What they priced up'}</Eyebrow>
            <PropertyGrid
              layout="stacked"
              density="compact"
              className="mt-1"
              items={profile.quotation.line_items.map((line) => ({
                label: line.label,
                value: `${formatNumber(line.quantity)} × ${formatMoney(
                  Math.round(line.price * 100),
                  profile.quotation?.currency ?? 'INR',
                )}`,
              }))}
            />
            <p className="mt-1 text-xs text-text-secondary">
              Estimated total{' '}
              <span className="figure text-text-primary">
                {formatMoney(
                  Math.round(profile.quotation.total * 100),
                  profile.quotation.currency,
                )}
              </span>
            </p>
          </div>
        ) : null}

        {sessionId ? <PrivateNotes key={sessionId} sessionId={sessionId} /> : null}
      </div>
    );
  })();

  return (
    <aside
      aria-label={t('inbox.visitorDetails') || 'Visitor details'}
      className={cn(
        'flex min-h-0 flex-col',
        // No `border-l`: `SplitPane`'s inspector section draws it, and two
        // adjacent 1px hairlines render as a 2px rule beside a 1px one.
        pane && 'h-full bg-surface',
        className,
      )}
    >
      {pane ? (
        <>
          <PaneHeader title={t('inbox.details') || 'Details'} />
          <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
        </>
      ) : (
        body
      )}
    </aside>
  );
}
