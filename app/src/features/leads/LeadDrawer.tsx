import { useState } from 'react';
import Markdown from 'react-markdown';
import { Star } from 'lucide-react';
import {
  ABSENT,
  Alert,
  Badge,
  Button,
  DefinitionList,
  Drawer,
  ErrorState,
  Field,
  Input,
  LoadingRows,
  Progress,
  Skeleton,
  TabPanel,
  Tabs,
  Textarea,
  cn,
  formatDateTime,
  formatTime,
} from '../../ui';
import type { Lead } from '../../types/domain';
import { LeadInsights } from './LeadInsights';
import { LeadQualification } from './LeadQualification';
import { VisitorIntelligenceSection } from './VisitorIntelligenceSection';
import { useLeadDetail, type TranscriptMessage } from './useLeadDetail';
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
 * It is the design system's `Drawer`, which is also how the focus trap gets
 * fixed: the hand-rolled one queried only the panel for focusable elements
 * while the scrim was a focusable `button` *outside* it, so the one control it
 * was trying to keep reachable was the one nobody could tab to.
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
              'h-3.5 w-3.5',
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

function Verdict({ lead, rating }: { lead: Lead; rating: number | null }) {
  const tier = TIER_META[normalizeTier(lead.status)];
  return (
    <section className="rounded-lg border border-border bg-surface-sunken px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="figure text-2xl font-semibold leading-none text-text-primary">
          {lead.score}
          <span className="text-base text-text-tertiary"> / 100</span>
        </p>
        <Badge tone={tier.tone}>{tier.label}</Badge>
        {rating !== null ? <VisitorRating rating={rating} /> : null}
      </div>
      <Progress
        className="mt-2.5"
        value={lead.score}
        label={`Quality score: ${lead.score} out of 100`}
        tone={tier.tone === 'success' ? 'success' : tier.tone === 'warning' ? 'warning' : 'accent'}
      />
      <p className="mt-2 text-prose text-text-secondary">{tier.hint}</p>
    </section>
  );
}

function ContactCard({ lead }: { lead: Lead }) {
  const company = companyDisplay(lead.contact);
  const location = formatLocation(lead.location);
  const items = [
    { label: 'Name', value: lead.contact?.name || ABSENT },
    { label: 'Email', value: lead.contact?.email || ABSENT },
    { label: 'Phone', value: lead.contact?.phone || ABSENT },
    {
      label: 'Company',
      value: company ? (
        <>
          {company.value}
          {company.secondary ? (
            <span className="block text-xs text-text-tertiary">{company.secondary}</span>
          ) : null}
        </>
      ) : (
        ABSENT
      ),
    },
    { label: 'Location', value: location === 'Unknown' ? ABSENT : location },
    { label: 'Device', value: lead.device && lead.device !== 'Unknown' ? lead.device : ABSENT },
  ];

  return (
    <section className="space-y-2">
      <h3 className="text-lg font-semibold text-text-primary">Contact</h3>
      <div className="rounded-md border border-border px-3.5 py-3">
        <DefinitionList columns={2} items={items} />
        {lead.contact?.company_description ? (
          <p className="mt-3 border-t border-border pt-3 text-prose text-text-secondary">
            {lead.contact.company_description}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Bubble({ message }: { message: TranscriptMessage }) {
  const text = message.content ?? message.message ?? '';
  const visitor = message.role === 'user';
  const who = visitor ? 'Visitor' : message.role === 'operator' ? 'Operator' : 'Chatbot';
  const at = message.created_at ?? message.timestamp ?? null;

  return (
    <li className={cn('flex', visitor ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-md px-3 py-2',
          visitor ? 'bg-accent-50' : 'bg-surface-sunken',
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
 * The copy is the fix here. It used to say "only your team sees these", which is
 * false in the way that matters: there is no server API for lead notes, so they
 * live in this browser's `localStorage` and a colleague opening the same lead
 * sees nothing. The export column says the same thing.
 */
function Annotations({ controller }: { controller: LeadAnnotationController }) {
  const { note, tags, saveNote, saveTags } = controller;
  const [noteDraft, setNoteDraft] = useState(note?.text ?? '');
  const [tagDraft, setTagDraft] = useState(tags.join(', '));
  const [savedWhat, setSavedWhat] = useState<'note' | 'tags' | null>(null);

  const noteChanged = noteDraft.trim() !== (note?.text ?? '');
  const tagsChanged = tagDraft.trim() !== tags.join(', ');

  return (
    <section className="space-y-2">
      <h3 className="text-lg font-semibold text-text-primary">Your notes</h3>
      <Alert>
        These stay in this browser. They are not sent to the visitor, they are not stored on your
        workspace, and nobody else on your team can see them — not even on another machine.
      </Alert>

      <div className="space-y-4 rounded-md border border-border px-3.5 py-3">
        <Field
          label="Note"
          hint={note ? `Last edited ${formatDateTime(note.ts)}` : 'Nothing saved yet.'}
        >
          <Textarea
            rows={3}
            value={noteDraft}
            placeholder="Context for yourself — next steps, who to loop in…"
            onChange={(event) => {
              setNoteDraft(event.target.value);
              setSavedWhat(null);
            }}
          />
        </Field>
        <div className="flex items-center justify-end">
          <Button
            size="sm"
            disabled={!noteChanged}
            onClick={() => {
              saveNote(noteDraft);
              setSavedWhat('note');
            }}
          >
            Save note
          </Button>
        </div>

        <Field label="Tags" hint="Separate them with commas.">
          <Input
            value={tagDraft}
            placeholder="enterprise, follow-up, demo-requested"
            onChange={(event) => {
              setTagDraft(event.target.value);
              setSavedWhat(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              saveTags(tagDraft);
              setSavedWhat('tags');
            }}
          />
        </Field>
        {tags.length > 0 ? (
          <ul aria-label="Saved tags" className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <li key={tag}>
                <Badge>{tag}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center justify-end">
          <Button
            size="sm"
            disabled={!tagsChanged}
            onClick={() => {
              saveTags(tagDraft);
              setSavedWhat('tags');
            }}
          >
            Save tags
          </Button>
        </div>

        {savedWhat ? (
          <Alert tone="success" live>
            {savedWhat === 'note' ? 'Note saved in this browser.' : 'Tags saved in this browser.'}
          </Alert>
        ) : null}
      </div>
    </section>
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

  return (
    <Drawer
      open={sessionId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width="lg"
      title={detail ? leadDisplayName(detail) : 'Lead'}
      description={
        detail?.last_active_at ? `Last active ${formatDateTime(detail.last_active_at)}` : undefined
      }
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
          <TabPanel value="profile" className="space-y-6">
            {intelligenceLocked || !hasIntelligence(detail) ? (
              <Alert tone="plan" title="Lead scoring is not on your plan">
                The conversation and the contact details below are yours on every plan. The quality
                score, the qualification breakdown and the visitor&rsquo;s location arrive with a
                paid plan.
              </Alert>
            ) : (
              <Verdict lead={detail} rating={data.visitorRating} />
            )}

            <ContactCard lead={detail} />

            {hasIntelligence(detail) ? (
              <LeadQualification
                lead={detail}
                onOverride={data.overrideDimension}
                saving={data.overriding}
              />
            ) : null}

            <LeadInsights lead={detail} />

            <VisitorIntelligenceSection lead={detail} unlocked={visitorIntelligence} />

            {controller ? <Annotations key={detail.session_id} controller={controller} /> : null}
          </TabPanel>

          <TabPanel value="conversation" className="space-y-3">
            {transcript.error ? (
              <ErrorState
                compact
                title="We could not load the conversation"
                description={transcript.error.message}
                onRetry={transcript.retry}
              />
            ) : transcript.loading ? (
              <LoadingRows rows={5} />
            ) : transcript.messages.length === 0 ? (
              <p className="rounded-md border border-border px-3.5 py-3 text-prose text-text-secondary">
                No messages were recorded for this conversation.
              </p>
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
                      Load earlier messages
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
