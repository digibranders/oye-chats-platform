import { useState } from 'react';
import Markdown from 'react-markdown';
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
  cn,
  formatDateTime,
  formatRelative,
  formatTime,
  type PropertyItem,
} from '../../ui';
import type { Lead } from '../../types/domain';
import { LeadJourney } from './LeadInsights';
import { asRecord, asText, engagementBand, truncate } from './leadSource';
import { LeadSection } from './LeadSection';
import { LeadQualification } from './LeadQualification';
import { VisitorIntelligenceSection } from './VisitorIntelligenceSection';
import { TRANSCRIPT_PAGE_SIZE, useLeadDetail, type TranscriptMessage } from './useLeadDetail';
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
    { label: 'Email', value: lead.contact?.email || undefined },
    { label: 'Phone', value: lead.contact?.phone || undefined },
    { label: 'Company', value: company?.value, note: company?.secondary ?? undefined },
    { label: 'Location', value: location === 'Unknown' ? undefined : location },
    {
      label: 'Device',
      value: lead.device && lead.device !== 'Unknown' ? lead.device : undefined,
    },
    {
      label: 'First seen',
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

  if (utmSource) items.push({ label: 'Source', value: utmSource });
  if (campaign) items.push({ label: 'Campaign', value: campaign });
  if (medium) items.push({ label: 'Medium', value: medium });
  if (adDetail) items.push({ label: 'Ad detail', value: truncate(adDetail) });
  if (referrer) items.push({ label: 'Referrer', value: truncate(referrer) });
  if (landing) items.push({ label: 'Landed on', value: truncate(landing) });
  if (Object.keys(source).length > 0 && !utmSource && !campaign && !medium && !referrer) {
    items.push({ label: 'Source', value: 'Direct — no campaign or referrer' });
  }

  if (engagement > 0) items.push({ label: 'Engagement', value: engagementBand(engagement) });
  if (visits > 1) {
    items.push({ label: 'Visits', value: <span className="figure">{visits}</span> });
  }

  return items;
}



/** A post-chat rating, as stars and as a word. Colour is never the only signal. */
function VisitorRating({ rating }: { rating: number }) {
  const unhappy = rating <= 2;
  return (
    <span className="flex items-center gap-2">
      <span role="img" aria-label={`Rated ${rating} out of 5`} className="flex items-center gap-0.5">
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
        {unhappy ? 'Unhappy' : rating >= 4 ? 'Happy' : 'Mixed'}
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
  const active = lead.last_active_at ? `Last active ${formatRelative(lead.last_active_at)}` : null;
  return [company, active].filter(Boolean).join(' · ') || undefined;
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
        label={`Quality score: ${lead.score} out of 100`}
        tone={tier.tone === 'success' ? 'success' : tier.tone === 'warning' ? 'warning' : 'accent'}
      />
      <p className="mt-2 text-xs text-text-secondary">{tier.hint}</p>
    </div>
  );
}

function Bubble({ message }: { message: TranscriptMessage }) {
  const text = message.content ?? message.message ?? '';
  const visitor = message.role === 'user';
  const operator = message.role === 'operator';
  const who = visitor ? 'Visitor' : operator ? 'Operator' : 'Chatbot';
  const at = message.created_at ?? message.timestamp ?? null;

  return (
    <li className={cn('flex', visitor ? 'justify-end' : 'justify-start')}>
      {/* One radius and one ground per speaker role, matching the first-run
          transcript. The visitor used to sit on `bg-accent-50`, which is accent
          used as a status — blue means interactive in this system and nothing
          else. */}
      <div
        className={cn(
          'max-w-[85%] rounded-md px-3 py-2',
          visitor
            ? 'bg-surface-sunken'
            : operator
              ? 'bg-neutral-tint'
              : 'border border-border bg-surface',
        )}
      >
        <p className="mb-0.5 flex items-center gap-2 font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
          <span>{who}</span>
          {at ? <span className="figure normal-case tracking-normal">{formatTime(at)}</span> : null}
        </p>
        {text ? (
          visitor ? (
            // Verbatim: this is exactly what the visitor typed, and rendering it
            // as markdown would reformat their own words.
            <p className="whitespace-pre-wrap break-words text-prose text-text-primary">{text}</p>
          ) : (
            <div className="break-words text-prose text-text-primary [&_a]:text-accent-600 [&_a]:underline [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-0 [&_strong]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4">
              <Markdown>{text}</Markdown>
            </div>
          )
        ) : (
          <p className="text-prose text-text-tertiary">No text in this message.</p>
        )}
      </div>
    </li>
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
  const { note, tags, saveNote, saveTags } = controller;
  const [noteDraft, setNoteDraft] = useState(note?.text ?? '');
  const [tagDraft, setTagDraft] = useState<string[]>(() => [...tags]);
  const [saved, setSaved] = useState(false);

  const noteChanged = noteDraft.trim() !== (note?.text ?? '');
  const tagsChanged = tagDraft.join(',') !== tags.join(',');
  const dirty = noteChanged || tagsChanged;

  return (
    <LeadSection title="Your notes">
      <p className="text-xs text-text-secondary">
        Saved in this browser only — teammates cannot see these.
      </p>

      <div className="mt-3 space-y-4">
        <Field label="Note" hint={note ? `Last edited ${formatDateTime(note.ts)}` : undefined}>
          <Textarea
            rows={3}
            value={noteDraft}
            placeholder="Context for yourself — next steps, who to loop in…"
            onChange={(event) => {
              setNoteDraft(event.target.value);
              setSaved(false);
            }}
          />
        </Field>

        <Field label="Tags">
          <TagInput
            label="Tags"
            values={tagDraft}
            placeholder="enterprise, follow-up…"
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

export function LeadDrawer({
  sessionId,
  tab,
  onTabChange,
  onClose,
  intelligenceLocked,
  visitorIntelligence,
  annotations,
}: LeadDrawerProps) {
  const data = useLeadDetail(sessionId);
  const { detail, transcript } = data;
  const controller = annotations.controllerFor(sessionId);

  const properties: PropertyItem[] = detail ? leadProperties(detail) : [];

  return (
    <Drawer
      open={sessionId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      // 768, not 672. A panel holding a property grid *and* a transcript at 672
      // wraps everything in it, which is most of why every value in here needed
      // its own line.
      width="xl"
      eyebrow="Lead"
      title={detail ? leadDisplayName(detail) : 'Lead'}
      // Relative, not `formatDateTime`. The description is 12px secondary text;
      // an absolute timestamp there is neither readable nor scannable.
      description={detail ? subtitle(detail) : undefined}
    >
      {data.loading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <LoadingRows rows={4} />
        </div>
      ) : data.error ? (
        <ErrorState
          title="We could not load this lead"
          description={data.error.message}
          onRetry={data.retry}
        />
      ) : detail ? (
        <Tabs
          label="Lead details"
          value={tab}
          onValueChange={(next) => onTabChange(next as DrawerTab)}
          items={[
            { value: 'profile', label: 'Profile' },
            {
              value: 'conversation',
              label: 'Conversation',
              badge: detail.chats ? (
                <span className="figure text-xs text-text-tertiary">{detail.chats}</span>
              ) : undefined,
            },
          ]}
        >
          <TabPanel value="profile" className="space-y-5">
            {/* No second plan notice. The page this drawer opens from carries the
                page-level one, and the columns are silently absent as a third
                signal — three statements of one lock on one screen. */}
            {intelligenceLocked || !hasIntelligence(detail) ? null : (
              <ScoreBand lead={detail} rating={data.visitorRating} />
            )}

            <LeadSection title="Details">
              {/* No `label`: the heading above already names these facts, and a
                  second `role="group"` name would announce "Details" twice. */}
              <PropertyGrid density="compact" items={properties} />
            </LeadSection>

            {hasIntelligence(detail) ? (
              <LeadQualification
                lead={detail}
                onOverride={data.overrideDimension}
                saving={data.overriding}
              />
            ) : null}

            <LeadJourney lead={detail} />

            <VisitorIntelligenceSection lead={detail} unlocked={visitorIntelligence} />

            {controller ? <Annotations key={detail.session_id} controller={controller} /> : null}
          </TabPanel>

          <TabPanel value="conversation" className="space-y-3">
            {transcript.error ? (
              <ErrorState
                size="panel"
                title="We could not load the conversation"
                description={transcript.error.message}
                onRetry={transcript.retry}
              />
            ) : transcript.loading ? (
              <LoadingRows rows={5} />
            ) : transcript.messages.length === 0 ? (
              <Alert tone="neutral">No messages recorded.</Alert>
            ) : (
              <>
                {/* Paged backwards from the most recent message. The panel used
                    to render every message it was given, so a 200-message
                    conversation loaded in full into a narrow column and opened
                    at the part nobody wanted. */}
                {transcript.hasEarlier ? (
                  <div className="flex justify-center">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={transcript.loadingEarlier}
                      onClick={transcript.loadEarlier}
                    >
                      Load {TRANSCRIPT_PAGE_SIZE} earlier messages
                    </Button>
                  </div>
                ) : (
                  <p className="text-center text-xs text-text-tertiary">
                    This is the start of the conversation.
                  </p>
                )}
                <ul className="space-y-2.5">
                  {transcript.messages.map((message) => (
                    <Bubble key={message.id} message={message} />
                  ))}
                </ul>
              </>
            )}
          </TabPanel>
        </Tabs>
      ) : null}
    </Drawer>
  );
}
