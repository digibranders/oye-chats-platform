import { useMemo, useState } from 'react';
import { t as translateNow } from '../../i18n/i18n';
import { Star } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Drawer,
  ErrorState,
  Field,
  LoadingRows,
  Progress,
  PropertyGrid,
  SaveBar,
  Skeleton,
  TabPanel,
  Tabs,
  TagInput,
  Textarea,
  WidgetTranscript,
  appearanceFromBot,
  cn,
  formatDateTime,
  formatRelative,
  formatTime,
  type PropertyItem,
} from '../../ui';
import { formatDayLabel } from '../../lib/messageDay';
import { useBotContext } from '../../context/BotContext';
import { replayMessages } from './replayModel';
import type { Lead } from '../../types/domain';
import { LeadJourney } from './LeadInsights';
import { asRecord, asText, engagementBand, truncate } from './leadSource';
import { LeadSection } from './LeadSection';
import { LeadQualification } from './LeadQualification';
import { LeadQuotation } from './LeadQuotation';
import { VisitorIntelligenceSection } from './VisitorIntelligenceSection';
import { TRANSCRIPT_PAGE_SIZE, useLeadDetail } from './useLeadDetail';
import type { LeadAnnotationController, LeadAnnotationsStore } from './useLeadAnnotations';
import type { DrawerTab } from './leadsUrl';
import {
  TIER_META,
  companyDisplay,
  formatLocation,
  hasIntelligence,
  leadDisplayName,
  normalizeTier,
} from './leadModel';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * One lead, one panel, two tabs.
 *
 * The drawer this replaces had two faces fixed at open time by which control
 * the user clicked: the row opened a profile with no transcript, and a separate
 * "View chat" button opened a transcript with no profile. Reading a lead and
 * then wanting to see what they actually said meant closing the panel, finding
 * the row again, and clicking a different button. Both faces are here, both are
 * reachable from either, and which one is showing lives in the URL.
 *
 * **It is a record, not a document.** The profile was seven `<section>`s of
 * equal weight — Verdict, Contact, What we learned, Where they came from, How
 * they behaved, Network and email, Your notes — each with an `h3` set at exactly
 * the size and weight of the drawer's own title, and each wrapped in a bordered
 * box invented inline. Eleven such boxes, three paddings, two radii, about
 * 1,900px of scroll in a 672px column. Now: an identity band, one score strip,
 * one property grid, the qualification rows, the journey behind a disclosure,
 * and the notes. Inside a drawer a section is a heading and a hairline — the
 * drawer *is* the surface.
 */

export interface LeadDrawerProps {
  /** `null` closes the drawer and stops every fetch behind it. */
  sessionId: string | null;
  tab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  onClose: () => void;
  /** The workspace's plan does not include scores, tiers or location. */
  intelligenceLocked: boolean;
  /** This chatbot's plan includes the network and email enrichment. */
  visitorIntelligence: boolean;
  annotations: LeadAnnotationsStore;
}

/** Every fact about this lead, in one list. */
function leadProperties(lead: Lead): PropertyItem[] {
  const company = companyDisplay(lead.contact);
  const location = formatLocation(lead.location);
  const source = asRecord(lead.source);
  const utm = asRecord(source.utm_params);
  const behavioural = lead.behavioral ?? {};
  const visits = Number(behavioural.visit_count) || 0;
  const engagement = lead.behavioral_score ?? 0;

  const items: PropertyItem[] = [
    { label: translateNow('leads.email') || 'Email', value: lead.contact?.email || undefined },
    { label: translateNow('leads.phone') || 'Phone', value: lead.contact?.phone || undefined },
    { label: (translateNow('leads.company') || 'Company'), value: company?.value, note: company?.secondary ?? undefined },
    { label: translateNow('leads.location') || 'Location', value: location === 'Unknown' ? undefined : location },
    {
      label: translateNow('leads.device') || 'Device',
      value: lead.device && lead.device !== 'Unknown' ? lead.device : undefined,
    },
    {
      label: translateNow('leads.firstSeen') || 'First seen',
      value: lead.created_at ? formatDateTime(lead.created_at) : undefined,
    },
  ];

  // Attribution and behaviour exist only on the plans that produce them, so an
  // absent field here means "not on your plan" rather than "no value" — and an
  // em dash would say the wrong thing about it. Omitted instead.
  const campaign = asText(utm.utm_campaign);
  const medium = asText(utm.utm_medium);
  const adDetail = asText(utm.utm_content) ?? asText(utm.utm_term);
  const referrer = asText(source.referrer);
  const landing = asText(source.landing_page);
  const utmSource = asText(utm.utm_source);

  if (utmSource) items.push({ label: translateNow('leads.source') || 'Source', value: utmSource });
  if (campaign) items.push({ label: translateNow('leads.campaign') || 'Campaign', value: campaign });
  if (medium) items.push({ label: translateNow('leads.medium') || 'Medium', value: medium });
  if (adDetail) items.push({ label: translateNow('leads.adDetail') || 'Ad detail', value: truncate(adDetail) });
  if (referrer) items.push({ label: translateNow('leads.referrer') || 'Referrer', value: truncate(referrer) });
  if (landing) items.push({ label: translateNow('leads.landedOn') || 'Landed on', value: truncate(landing) });
  if (Object.keys(source).length > 0 && !utmSource && !campaign && !medium && !referrer) {
    items.push({ label: translateNow('leads.source') || 'Source', value: translateNow('leads.directNoCampaignOrReferrer') || 'Direct, no campaign or referrer' });
  }

  if (engagement > 0) items.push({ label: translateNow('leads.engagement') || 'Engagement', value: engagementBand(engagement) });
  if (visits > 1) {
    items.push({ label: translateNow('leads.visits') || 'Visits', value: <span className="figure">{visits}</span> });
  }

  return items;
}



/** A post-chat rating, as stars and as a word. Colour is never the only signal. */
function VisitorRating({ rating }: { rating: number }) {
  const { t } = useTranslation();
  const unhappy = rating <= 2;
  return (
    <span className="flex items-center gap-2">
      <span role="img" aria-label={translateNow('leads.ratedOutOf5', { rating }) || `Rated ${rating} out of 5`} className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((step) => (
          <Star
            key={step}
            aria-hidden
            className={cn(
              'h-icon-sm w-icon-sm',
              step <= rating ? 'fill-current text-warning' : 'text-text-tertiary',
            )}
          />
        ))}
      </span>
      <Badge tone={unhappy ? 'danger' : rating >= 4 ? 'success' : 'neutral'}>
        {unhappy ? t('leads.unhappy') || 'Unhappy' : rating >= 4 ? t('leads.happy') || 'Happy' : t('leads.mixed') || 'Mixed'}
      </Badge>
    </span>
  );
}

/**
 * How good this lead is, in one band.
 *
 * It used to be a `bg-surface-sunken` `rounded-lg` panel — the well token used
 * as a hero, at a radius no other box in the same scroll shared. It is not a
 * box: it is the first thing under the panel's own header, and the hairline
 * below it is the only chrome it needs.
 *
 * It does not repeat the name. The drawer's header carries it, and the version
 * this replaces set every section heading at `text-lg font-semibold` — the same
 * rung as `Drawer.Title` — so the record's name and six section headings read as
 * seven peers.
 */
/** Company and recency, as the drawer's one-line subtitle. */
function subtitle(lead: Lead): string | undefined {
  const company = companyDisplay(lead.contact)?.value;
  // The chatbot, because the Conversation tab is painted in ITS colours and
  // shows ITS avatar. Without the name the reader is looking at a stranger's
  // brand with nothing to attach it to — and a workspace with six chatbots has
  // six different-looking transcripts.
  const bot = lead.bot_name?.trim() || null;
  const active = lead.last_active_at
    ? translateNow('leads.lastActiveWhen', { when: formatRelative(lead.last_active_at) }) ||
      `Last active ${formatRelative(lead.last_active_at)}`
    : null;
  return [company, bot, active].filter(Boolean).join(' · ') || undefined;
}

function ScoreBand({ lead, rating }: { lead: Lead; rating: number | null }) {
  const tier = TIER_META[normalizeTier(lead.status)];
  return (
    <div className="border-b border-border pb-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="figure text-2xl font-semibold leading-none text-text-primary">
          {lead.score}
          <span className="text-base text-text-tertiary"> / 100</span>
        </p>
        <Badge tone={tier.tone}>{tier.label}</Badge>
        {rating !== null ? <VisitorRating rating={rating} /> : null}
      </div>
      {/* `hideLabel`: the figure above the bar is "82 / 100" at 2xl beside the
          tier badge. A label row would restate it in 12px grey directly
          underneath. */}
      <Progress
        className="mt-3"
        hideLabel
        value={lead.score}
        label={
          translateNow('leads.qualityScoreOutOf100', { score: lead.score }) ||
          `Quality score: ${lead.score} out of 100`
        }
        tone={tier.tone === 'success' ? 'success' : tier.tone === 'warning' ? 'warning' : 'accent'}
      />
      <p className="mt-2 text-xs text-text-secondary">{tier.hint}</p>
    </div>
  );
}

/**
 * Private notes and tags.
 *
 * Mounted with the lead's session id as its `key` by the caller, so switching
 * leads remounts it and the drafts reset from the incoming controller without a
 * synchronous `setState` in an effect.
 *
 * **One save bar for both fields.** It had two `justify-end` buttons — one per
 * field, each with its own dirty state — plus a success `Alert` appended below
 * them that pushed the tag list down whenever it appeared. That is the fourth
 * hand-rolled save contract in a codebase whose design system ships exactly one.
 *
 * The copy is the other fix. It used to say "only your team sees these", which
 * is false in the way that matters: there is no server API for lead notes, so
 * they live in this browser's `localStorage` and a colleague opening the same
 * lead sees nothing.
 */
function Annotations({ controller }: { controller: LeadAnnotationController }) {
  const { t } = useTranslation();
  const { note, tags, saveNote, saveTags } = controller;
  const [noteDraft, setNoteDraft] = useState(note?.text ?? '');
  const [tagDraft, setTagDraft] = useState<string[]>(() => [...tags]);
  const [saved, setSaved] = useState(false);

  const noteChanged = noteDraft.trim() !== (note?.text ?? '');
  const tagsChanged = tagDraft.join(',') !== tags.join(',');
  const dirty = noteChanged || tagsChanged;

  return (
    <LeadSection title={t('leads.yourNotes') || 'Your notes'}>
      <p className="text-xs text-text-secondary">
        {t('leads.savedInThisBrowserOnly') || 'Saved in this browser only. Teammates cannot see these.'}
      </p>

      <div className="mt-3 space-y-4">
        <Field label={t('leads.note') || 'Note'} hint={
            note
              ? t('leads.lastEditedWhen', { when: formatDateTime(note.ts) }) ||
                `Last edited ${formatDateTime(note.ts)}`
              : undefined
          }>
          <Textarea
            rows={3}
            value={noteDraft}
            placeholder={t('leads.contextForYourselfNextSteps') || 'Context for yourself: next steps, who to loop in…'}
            onChange={(event) => {
              setNoteDraft(event.target.value);
              setSaved(false);
            }}
          />
        </Field>

        <Field label={t('leads.tags') || 'Tags'}>
          <TagInput
            label={t('leads.tags') || 'Tags'}
            values={tagDraft}
            placeholder={t('leads.enterpriseFollowUp') || 'enterprise, follow-up…'}
            onValuesChange={(next) => {
              setTagDraft(next);
              setSaved(false);
            }}
          />
        </Field>

        <SaveBar
          dirty={dirty}
          saved={saved}
          summary="your note and tags"
          onSave={() => {
            if (noteChanged) saveNote(noteDraft);
            if (tagsChanged) saveTags(tagDraft.join(','));
            setSaved(true);
          }}
          onDiscard={() => {
            setNoteDraft(note?.text ?? '');
            setTagDraft([...tags]);
            setSaved(false);
          }}
        />
      </div>
    </LeadSection>
  );
}

/** Key beside the English: a module constant cannot be translated in place. */
// @i18n-exempt: fallbacks. Each row carries its own key, resolved at render.
const ACTION_LABELS: Record<string, { key: string; text: string }> = {
  handoff_requested: { key: 'leads.requestedAPerson', text: 'Requested a person' },
  accepted: { key: 'leads.operatorJoined', text: 'Operator joined' },
  closed: { key: 'leads.closed', text: 'Closed' },
  transferred: { key: 'leads.transferred', text: 'Transferred' },
  timeout: { key: 'leads.timedOut', text: 'Timed out' },
  visitor_cancelled: { key: 'leads.visitorLeftTheQueue', text: 'Visitor left the queue' },
};

/**
 * What an audit action says, inside the transcript.
 *
 * These used to be an "Activity" disclosure filed under the last message. They
 * are moments in the conversation, not a footnote to it, so they are now quiet
 * centred lines at the time they happened — which is also how the widget showed
 * them to the visitor.
 */
function humanizeAction(action: string): string {
  const known = ACTION_LABELS[action];
  // An unrecognised action falls back to its own de-underscored name rather
  // than to a key: it is a server string we have no copy for at all.
  return known ? translateNow(known.key) || known.text : action.replace(/_/g, ' ');
}

export function LeadDrawer({
  sessionId,
  tab,
  onTabChange,
  onClose,
  intelligenceLocked,
  visitorIntelligence,
  annotations,
}: LeadDrawerProps) {
  const { t } = useTranslation();
  const { bots } = useBotContext();
  const data = useLeadDetail(sessionId);
  const { detail, transcript } = data;
  const controller = annotations.controllerFor(sessionId);

  const properties: PropertyItem[] = detail ? leadProperties(detail) : [];

  // The chatbot's own colours and mark, because the transcript is a replay of
  // what the visitor saw on that chatbot's site. A lead outlives the chatbot
  // that captured it, and `appearanceFromBot` answers `null` with the widget's
  // own defaults rather than leaving the panel unstyled.
  const bot = detail?.bot_id != null ? bots.find((candidate) => candidate.id === detail.bot_id) : undefined;
  const appearance = useMemo(() => appearanceFromBot(bot ?? null), [bot]);

  const replay = useMemo(
    () => replayMessages(transcript.messages, data.audit, humanizeAction),
    [transcript.messages, data.audit],
  );

  return (
    <Drawer
      open={sessionId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      // The resting width, not the only one. A transcript is read at whatever
      // width the reader's monitor and habit want, so the leading edge is
      // draggable and the result is remembered. See `Drawer`'s own stops.
      width="xl"
      resizable
      storageKey="oyechats.leads.drawer-width"
      // No eyebrow. The page is called Leads and this opened from one of its
      // rows: "Lead / Siddique / Digibranders" was the record's own name said
      // three times before the first fact about it.
      title={detail ? leadDisplayName(detail) : t('leads.lead') || 'Lead'}
      // Relative, not `formatDateTime`. The description is 12px secondary text;
      // an absolute timestamp there is neither readable nor scannable.
      description={detail ? subtitle(detail) : undefined}
      // The tab row directly below draws the header's bottom edge. Two rules
      // 40px apart, plus the row's own active underline, is three horizontal
      // lines in the first 80px of the panel.
      headerHairline={false}
      // The tab row runs to the panel's edges and the panel below it scrolls,
      // so the body's own 20px padding moves inside the tabs.
      flush
    >
      {data.loading ? (
        <div className="space-y-4 p-5">
          <Skeleton className="h-24 w-full" />
          <LoadingRows rows={4} />
        </div>
      ) : data.error ? (
        <ErrorState
          className="p-5"
          title={t('leads.weCouldNotLoadThis') || 'We could not load this lead'}
          description={data.error.message}
          onRetry={data.retry}
        />
      ) : detail ? (
        <Tabs
          fill
          listClassName="px-5"
          label={t('leads.leadDetails') || 'Lead details'}
          value={tab}
          onValueChange={(next) => onTabChange(next as DrawerTab)}
          items={[
            { value: 'profile', label: t('leads.profile') || 'Profile' },
            {
              value: 'conversation',
              label: t('leads.conversation') || 'Conversation',
              badge: detail.chats ? (
                <span className="figure text-xs text-text-tertiary">{detail.chats}</span>
              ) : undefined,
            },
          ]}
        >
          <TabPanel value="profile" scroll className="space-y-5 px-5 pb-5">
            {/* No second plan notice. The page this drawer opens from carries the
                page-level one, and the columns are silently absent as a third
                signal — three statements of one lock on one screen. */}
            {intelligenceLocked || !hasIntelligence(detail) ? null : (
              <ScoreBand lead={detail} rating={data.visitorRating} />
            )}

            <LeadSection title={t('leads.details') || 'Details'}>
              {/* No `label`: the heading above already names these facts, and a
                  second `role="group"` name would announce "Details" twice. */}
              <PropertyGrid density="compact" items={properties} />
            </LeadSection>

            {hasIntelligence(detail) ? <LeadQualification lead={detail} /> : null}

            <LeadQuotation lead={detail} />

            <LeadJourney lead={detail} />

            <VisitorIntelligenceSection lead={detail} unlocked={visitorIntelligence} />

            {controller ? <Annotations key={detail.session_id} controller={controller} /> : null}
          </TabPanel>

          <TabPanel value="conversation" scroll className="space-y-3 px-5 pb-5">
            {transcript.error ? (
              <ErrorState
                size="panel"
                title={t('leads.weCouldNotLoadThe') || 'We could not load the conversation'}
                description={transcript.error.message}
                onRetry={transcript.retry}
              />
            ) : transcript.loading ? (
              <LoadingRows rows={5} />
            ) : replay.length === 0 ? (
              <Alert tone="neutral">{t('leads.noMessagesRecorded') || 'No messages recorded.'}</Alert>
            ) : (
              <>
                {/* Paged backwards from the most recent message. The panel used
                    to render every message it was given, so a 200-message
                    conversation loaded in full into a narrow column and opened
                    at the part nobody wanted.

                    A link, not a `Button`: a filled control at the top of a
                    transcript reads as the panel's primary action, and it is
                    the least important thing on the screen. */}
                {transcript.hasEarlier ? (
                  <div className="flex justify-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={transcript.loadingEarlier}
                      onClick={transcript.loadEarlier}
                    >
                      {t('leads.loadNEarlierMessages', { count: TRANSCRIPT_PAGE_SIZE }) ||
                        `Load ${TRANSCRIPT_PAGE_SIZE} earlier messages`}
                    </Button>
                  </div>
                ) : (
                  <p className="text-center text-xs text-text-tertiary">
                    {t('leads.thisIsTheStartOf') || 'This is the start of the conversation.'}
                  </p>
                )}
                {/* The conversation as the visitor saw it, in that chatbot's own
                    colours: their turns in its bubble colour, the AI as its
                    avatar and rendered markdown, an operator as a name and
                    plain text. The panel this replaces drew all three in
                    console greys under an uppercase mono label — 23 of them
                    down one column.

                    `showTimes`: the widget shows the visitor no clocks, because
                    they are watching it happen. This is a record read weeks
                    later, so each run ends with one. A widget session survives
                    in the visitor's browser and can span days, so the day
                    dividers are what stop "14:32" meaning last Tuesday. */}
                <WidgetTranscript
                  appearance={appearance}
                  messages={replay}
                  operatorName={data.operatorName}
                  showTimes
                  dayLabel={(at) => formatDayLabel(at) || null}
                  timeLabel={formatTime}
                  operatorFallback={t('leads.operator') || 'Operator'}
                  imageLabel={t('leads.attachment') || 'Attachment'}
                />
              </>
            )}
          </TabPanel>
        </Tabs>
      ) : null}
    </Drawer>
  );
}
