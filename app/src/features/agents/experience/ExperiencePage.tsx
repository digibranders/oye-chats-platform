import { type ReactElement, useEffect } from 'react';
import { Link, useBlocker, useSearchParams } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { Badge, buttonClass, Card, CardBody, Columns, ConfirmDialog, EmptyState, ErrorState, LockedState, Page, PageHeader, SaveBar, Skeleton, Stack, StatusDot, TabPanel, Tabs, type TabItem } from '../../../ui';
import { useExperience } from './useExperience';
import { BrandingSection } from './BrandingSection';
import { MessagesSection } from './MessagesSection';
import { VoiceSection } from './VoiceSection';
import { HandoffSection } from './HandoffSection';
import { PreviewPanel } from './PreviewPanel';
import { isSectionKey, SECTION_KEYS, SECTION_LABELS, summarizeSections, type SectionKey } from './experience-model';

/**
 * A chatbot's Experience: what a visitor sees and hears.
 *
 * The whole page is one form over one record, with the preview beside it. Three
 * things that were wrong before are structural here rather than fixed
 * case-by-case.
 *
 * **The chatbot is the one in the URL.** `useExperience` reads the route and
 * nothing else, so the preview cannot stream from a different chatbot than the
 * form is editing (B6) and a write cannot land on `bots[0]` (B1). No module in
 * this directory imports the shell's chatbot switcher, and a test asserts it.
 *
 * **One draft, one save.** The page it replaces held two independent drafts
 * over the same record — a page-level save bar for appearance and a save button
 * per card for everything else — so "did that save?" had five different
 * answers on one screen. There is one bar, it names which tabs hold unsaved
 * work, and leaving with it up is intercepted.
 *
 * **The preview never claims to be live when it is not.** It reflects the
 * draft, debounced; it is badged Live only when the draft matches what is
 * stored; and it says outright that a generated *reply* still comes from the
 * saved record.
 */

const TAB_PARAM = 'tab';

/** The tab row, with a dot on any tab holding unsaved work.
 *
 * The save bar names which tabs are dirty, but it sits at the bottom of a long
 * column and the user may be four tabs away from the change they made. The dot
 * carries the same fact where the choice is: it is `warning` toned and, because
 * colour is never the only signal, its accessible name says "unsaved changes". */
function tabItems(dirtySections: readonly SectionKey[]): TabItem[] {
  return SECTION_KEYS.map((key) => ({
    value: key,
    label: SECTION_LABELS[key],
    badge: dirtySections.includes(key) ? (
      <StatusDot tone="warning" label={`${SECTION_LABELS[key]} has unsaved changes`} />
    ) : undefined,
  }));
}

export function ExperiencePage(): ReactElement {
  const experience = useExperience();
  const [params, setParams] = useSearchParams();

  const requested = params.get(TAB_PARAM);
  const tab: SectionKey = requested && isSectionKey(requested) ? requested : 'branding';

  const { dirty, discard } = experience;

  // In-app navigation. The router asks before it leaves, and the answer is a
  // real choice — "stay" is the default and discarding is the deliberate act.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  // A real navigation — reload, close, an external link — where only the
  // browser's own prompt is available.
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Chrome requires the legacy assignment; the string itself is ignored.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const selectTab = (next: string): void => {
    if (!isSectionKey(next)) return;
    const updated = new URLSearchParams(params);
    updated.set(TAB_PARAM, next);
    // Replace, so walking the tabs does not bury the page the user arrived from
    // under four history entries.
    setParams(updated, { replace: true });
  };

  // No description: it listed the four tab labels rendered 40px below it.
  const header = <PageHeader title="Experience" eyebrow={experience.agentName} />;

  if (experience.status === 'loading') {
    return (
      <Page width="wide">
        {header}
        <LoadingLayout />
      </Page>
    );
  }

  if (experience.status === 'missing') {
    return (
      <Page width="wide">
        {header}
        <EmptyState
          framed
          icon={Bot}
          title="This chatbot does not exist"
          description="It may have been deleted."
          action={
            <Link to="/chatbots" className={buttonClass('primary', 'sm')}>
              All chatbots
            </Link>
          }
        />
      </Page>
    );
  }

  if (experience.status === 'forbidden') {
    return (
      <Page width="wide">
        {header}
        <LockedState
          title="Your seat cannot configure this chatbot"
          description="Changing what visitors see needs an owner or admin seat."
          action={
            <Link to="/inbox" className={buttonClass('primary', 'sm')}>
              Go to the inbox
            </Link>
          }
        />
      </Page>
    );
  }

  if (experience.status === 'error' || !experience.draft || !experience.meta) {
    return (
      <Page width="wide">
        {header}
        <ErrorState
          framed
          title="We could not load this chatbot"
          description={experience.loadError ?? 'Something went wrong on the way to the server.'}
          onRetry={experience.retry}
        />
      </Page>
    );
  }

  const { draft, meta, errors, readOnly } = experience;
  const blocked = Object.keys(errors).length > 0;
  const tabs = tabItems(experience.dirtySections);

  return (
    <Page width="wide">
      {header}

      {readOnly ? (
        // `mb-8`, matching the rhythm below it: a 24px margin above a 32px gap
        // read as two different separations of the same kind.
        <div className="mb-8">
          <LockedState
            size="panel"
            title="These settings are now read-only"
            description="Your last save was refused. Copy anything you need before leaving."
          />
        </div>
      ) : null}

      <Stack>
        <Columns
          asideWidth="md"
          stickyAside
          asideLabel="Widget preview"
          main={
            /* `scroll-mb-*` on every control in this column is what keeps the
               sticky save bar from landing on top of the field a keyboard user
               just tabbed to (WCAG 2.2 SC 2.4.11): the browser scrolls a focused
               element into view honouring its scroll margin, so the bar's height
               is reserved below it. */
            <div className="flex min-w-0 flex-col [&_:is(input,textarea,select,button,a)]:scroll-mb-24">
              <Tabs items={tabs} value={tab} onValueChange={selectTab} label="Experience settings">
                {tabs.map((item) => (
                  <TabPanel key={item.value} value={item.value}>
                    {item.value === 'branding' ? (
                      <BrandingSection
                        draft={draft}
                        meta={meta}
                        errors={errors}
                        readOnly={readOnly}
                        onChange={experience.update}
                      />
                    ) : null}
                    {item.value === 'messages' ? (
                      <MessagesSection
                        draft={draft}
                        errors={errors}
                        agentId={experience.agentId}
                        readOnly={readOnly}
                        onChange={experience.update}
                      />
                    ) : null}
                    {item.value === 'voice' ? (
                      <VoiceSection
                        draft={draft}
                        meta={meta}
                        errors={errors}
                        agentId={experience.agentId}
                        readOnly={readOnly}
                        onChange={experience.update}
                        onServerCommit={experience.commitServerValues}
                      />
                    ) : null}
                    {item.value === 'handoff' ? (
                      <HandoffSection
                        draft={draft}
                        meta={meta}
                        errors={errors}
                        readOnly={readOnly}
                        onChange={experience.update}
                      />
                    ) : null}
                  </TabPanel>
                ))}
              </Tabs>
            </div>
          }
          aside={
            // `max-w-96` — the aside's own 24rem. `Columns` drops to one column
            // below 56rem of page, and without a ceiling the preview then became
            // a 930px-wide card holding a 380px chat window: the same panel,
            // three times the width, under a segmented control stretched across
            // all of it. Capped, the stacked layout is the column layout with
            // the preview moved below the form, which is what it should read as.
            <div className="max-w-96">
              <PreviewPanel
                draft={draft}
                agentName={experience.agentName}
                agentId={experience.agentId}
                dirty={dirty}
                answerStale={experience.answerStale}
                botKey={meta.botKey}
                website={meta.website}
                brandingText={draft.brandingText || meta.brandingText}
                onEditState={selectTab}
              />
            </div>
          }
        />

        {/* Outside the grid, so the bar spans the form it saves. Inside the left
            column it stopped dead at the preview's left edge and read as
            belonging to the tab panel rather than to the page. */}
        <SaveBar
          dirty={dirty}
          saving={experience.saving}
          saved={experience.savedAt !== null}
          saveError={experience.saveError}
          blockedReason={blocked ? 'Fix the highlighted fields to save.' : null}
          summary={summarizeSections(experience.dirtySections)}
          onSave={() => void experience.save()}
          onDiscard={discard}
          guard="this chatbot’s experience"
        />
      </Stack>

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.state === 'blocked') blocker.reset();
        }}
        title="Leave without saving?"
        description={
          <>
            You have unsaved changes in{' '}
            {experience.dirtySections.map((section, index) => (
              <span key={section}>
                {index > 0 ? ', ' : ''}
                <Badge tone="neutral">{SECTION_LABELS[section]}</Badge>
              </span>
            ))}
            . Leaving now discards them — the widget on your site keeps the settings it already has.
          </>
        }
        confirmLabel="Discard and leave"
        cancelLabel="Stay on this page"
        destructive
        onConfirm={() => {
          discard();
          if (blocker.state === 'blocked') blocker.proceed();
        }}
      />
    </Page>
  );
}

/** Shaped like what arrives, so the load does not shift the page under the cursor. */
function LoadingLayout(): ReactElement {
  return (
    <Columns
      asideWidth="md"
      aside={
        <Card>
          <CardBody className="flex flex-col gap-3">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-control-sm w-full" />
            <Skeleton className="h-128 w-full" />
          </CardBody>
        </Card>
      }
      main={
        <div className="flex flex-col gap-6">
          {/* The tab row is part of the shape that arrives. */}
          <Skeleton className="h-10 w-full" />
          {[0, 1].map((index) => (
            <Card key={index}>
              <CardBody className="flex flex-col gap-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-control-md w-full max-w-sm" />
                <Skeleton className="h-16 w-full" />
              </CardBody>
            </Card>
          ))}
        </div>
      }
    />
  );
}
