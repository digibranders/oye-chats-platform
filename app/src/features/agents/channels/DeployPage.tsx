import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import {
  Card,
  CardBody,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Grid,
  LockedState,
  Page,
  PageHeader,
  SaveBar,
  SettingGroup,
  Skeleton,
  Stack,
  TabPanel,
  Tabs,
  buttonClass,
} from '../../../ui';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getBotDemoUrl, getClientSettings, updateBot } from '../../../services/api';
import { platforms } from '../../../data/platformIntegrations';
import { useSettingsDraft } from '../advanced/useSettingsDraft';
import { useDeployData } from './useDeployData';
import { ownSiteRisk, widgetHeartbeat } from './deployModel';
import { AccessSection } from './AccessSection';
import {
  type AccessDraft,
  accessChanged,
  parseAccess,
  sessionShareDomainError,
  toAccessPayload,
} from './accessModel';
import { DemoLinkCard } from './DemoLinkCard';
import { InstallStatusCard } from './InstallStatusCard';
import { SnippetSection } from './SnippetSection';
import { PlatformGuide } from './PlatformGuide';
import { TroubleshootSection } from './TroubleshootSection';
import { useTranslation } from '../../../i18n/useTranslation';

type HelpTab = 'platform' | 'troubleshoot';

/** The page while the chatbot is still being fetched. Shaped like what arrives. */
function DeploySkeleton() {
  return (
    <Grid cols={2} align="start">
      {/* Row 1, left — snippet */}
      <Card>
        <CardBody className="space-y-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-control-md w-full" />
          <Skeleton className="h-32 w-full rounded-md" />
          <Skeleton className="h-control-md w-72" />
        </CardBody>
      </Card>
      {/* Row 1, right — help tabs */}
      <div className="space-y-6">
        <Skeleton className="h-10 w-full" />
        <Card>
          <CardBody className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-control-md w-full" />
          </CardBody>
        </Card>
      </div>
      {/* Row 2, left — access */}
      <Card>
        <CardBody className="space-y-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-control-md w-full" />
        </CardBody>
      </Card>
      {/* Row 2, right — install status + demo link */}
      <Stack>
        <Card>
          <CardBody className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-control-sm w-32" />
          </CardBody>
        </Card>
        <Card>
          <CardBody className="space-y-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-control-md w-full" />
          </CardBody>
        </Card>
      </Stack>
    </Grid>
  );
}

/**
 * Deploy — "is my chatbot actually live on my site?"
 *
 * Installation is the highest-stakes moment in this product. A customer who
 * cannot get the snippet working never becomes a customer, and every previous
 * version of this screen answered the wrong question: the tab was called
 * "Channels", it was a plural noun over exactly one channel, and it opened on a
 * grid of platform logos rather than on whether the thing was working.
 *
 * **Two regions, not eight cards.** The page used to be a 1440px column of eight
 * stacked cards — 4,081px of scroll, with roughly 850px spent on card chrome
 * before a single control, and a first fold of prose around one snippet that
 * ended by telling the reader to scroll further down the page. What Intercom,
 * Crisp and Chatbase all do instead is put the artefact and its help on screen
 * together: the snippet and its access allow-list run down the left, and the
 * right column leads with the platform instructions beside the snippet, then
 * drops the live install reading beside Access — the control most likely to be
 * keeping that reading empty — with the shareable hosted demo beneath it.
 *
 * **Access is here, under one draft and one save bar.** The origin allow-list
 * and the session-continuity parent spent a release on Behaviour. What was
 * wrong with them on the old version of this page was never the address: it was
 * that each sat in its own card with its own Save button and its own unguarded
 * dirty state, three hand-rolled save contracts on one screen. They are back
 * because the allow-list is the most common reason a correctly-pasted snippet
 * shows nothing, and the reader diagnosing that is here, reading the install
 * status and the checklist that names it. The in-widget credit line stayed on
 * Experience ▸ Branding, which already owned its on/off switch.
 *
 * Nothing on this page is a wizard step and nothing blocks: the customer can
 * copy the snippet, hand it to a developer, close the tab, and come back in a
 * week to a page that still tells them the truth.
 */
export function DeployPage() {
  const { t } = useTranslation();
  const { agent, loading: agentLoading } = useAgent();
  const deploy = useDeployData();
  const { hasFeature, loading: entitlementsLoading } = useEntitlements();
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [helpTab, setHelpTab] = useState<HelpTab | null>(null);
  const [confirmingLockout, setConfirmingLockout] = useState(false);

  // The access slice is loaded and saved on its own rather than through
  // `useDeployData`. That hook owns the install *reading* — a polled query with
  // its own cache and its own refetch on every verification tick — and an
  // editable draft sharing it would have the customer's half-typed allow-list
  // replaced by a poll. `load` is memoised because it is an effect dependency.
  const loadAccess = useCallback(
    async (id: number): Promise<AccessDraft> => parseAccess(await getClientSettings(id)),
    [],
  );
  const saveAccess = useCallback(
    async (id: number, draft: AccessDraft, initial: AccessDraft) => {
      // Only when the slice actually moved. Writing an untouched allow-list back
      // is how a security control gets rewritten by someone who never opened it.
      if (accessChanged(draft, initial)) await updateBot(id, toAccessPayload(draft));
    },
    [],
  );
  const access = useSettingsDraft<AccessDraft>({
    agentId: deploy.agentId ?? null,
    load: loadAccess,
    save: saveAccess,
  });

  // `update` is stable where `access` is not, so the memoised section below
  // actually stays memoised instead of taking a fresh callback every render.
  const { update: updateAccess } = access;
  const setAccess = useCallback(
    (patch: {
      allowedDomains?: string[];
      domainCheckEnabled?: boolean;
      sessionShareDomain?: string;
    }) => updateAccess((previous) => ({ ...previous, ...patch })),
    [updateAccess],
  );

  // The snippet variant is entitlement-driven and keys off the plan, not off the
  // chatbot's own `show_branding` flag: a paid customer who chooses to keep the
  // badge still gets an anchor-free snippet, because the anchor and the badge
  // are different things.
  const attribution = !hasFeature('branding_removable');

  const bot = deploy.bot;
  const platform = platforms.find((p) => p.id === platformId) ?? null;

  const header = (
    <PageHeader
      title={t('agents.deploy') || 'Deploy'}
      eyebrow={agent?.name}
      actions={
        bot?.bot_key ? (
          <a
            href={getBotDemoUrl(bot.bot_key)}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass('secondary', 'sm')}
          >
            <ExternalLink aria-hidden />
            {t('agents.tryItNow') || 'Try it now'}
            <span className="sr-only"> {t('agents.opensAHostedPreviewIn') || '(opens a hosted preview in a new tab)'}</span>
          </a>
        ) : undefined
      }
    />
  );

  // ── Forbidden ────────────────────────────────────────────────────────────
  // A 403 or 404 on the chatbot means it is not this workspace's to configure.
  // That is a different answer from "it failed to load", and rendering both as
  // one error card is what makes people retry something that will never work.
  if (deploy.failure?.kind === 'forbidden') {
    return (
      <Page>
        {header}
        <LockedState
          title={t('agents.thisChatbotIsNotIn') || 'This chatbot is not in your workspace'}
          description={t('agents.itMayBelongToAnother') || 'It may belong to another workspace.'}
          action={
            <Link to="/chatbots" className={buttonClass('primary', 'sm')}>
              {t('agents.seeYourChatbots') || 'See your chatbots'}
            </Link>
          }
        />
      </Page>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (deploy.failure) {
    return (
      <Page>
        {header}
        <ErrorState
          framed
          title={t('agents.weCouldNotLoadThis') || 'We could not load this chatbot'}
          description={deploy.failure.message}
          onRetry={deploy.retry}
        />
      </Page>
    );
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (deploy.loading) {
    return (
      <Page>
        {header}
        <DeploySkeleton />
      </Page>
    );
  }

  // ── Empty ────────────────────────────────────────────────────────────────
  // Two different emptinesses, answered differently: no chatbot in the URL at
  // all, and a chatbot that has no embed key to give out yet.
  if (!agentLoading && !agent) {
    return (
      <Page>
        {header}
        <EmptyState
          framed
          title={t('agents.noChatbotOpen') || 'No chatbot open'}
          action={
            <Link to="/chatbots" className={buttonClass('primary', 'sm')}>
              {t('agents.seeYourChatbots') || 'See your chatbots'}
            </Link>
          }
        />
      </Page>
    );
  }

  if (!bot || !bot.bot_key || deploy.agentId == null) {
    return (
      <Page>
        {header}
        <EmptyState
          framed
          title={t('agents.thisChatbotHasNoEmbed') || 'This chatbot has no embed key yet'}
          description={t('agents.openItFromTheList') || 'Open it from the list and finish setting it up.'}
          action={
            <Link to="/chatbots" className={buttonClass('secondary', 'sm')}>
              {t('agents.seeYourChatbots') || 'See your chatbots'}
            </Link>
          }
        />
      </Page>
    );
  }

  // Hoisted after the guards above so the rest of the page works with a plain
  // `number` rather than re-asserting the same narrowing at each call site.
  const agentId = deploy.agentId;
  const botKey = bot.bot_key;
  const website = bot.website ?? null;
  const demoUrl = getBotDemoUrl(botKey);
  const domains = bot.allowed_domains ?? [];

  // The status rail and the troubleshooting checklist read the *saved* list, not
  // the draft: they report what the server is enforcing right now, and an
  // unsaved edit is not that. `deploy.retry()` after a commit is what keeps the
  // two in step.
  const accessDraft = access.draft;
  const accessInitial = access.initial;
  const sessionError = accessDraft ? sessionShareDomainError(accessDraft.sessionShareDomain) : null;

  // The one save on this page that can take the customer's own widget offline.
  const risk = accessDraft
    ? ownSiteRisk({
        website,
        domains: accessDraft.allowedDomains,
        enabled: accessDraft.domainCheckEnabled,
      })
    : null;
  const lockingOut =
    risk !== null &&
    accessDraft !== null &&
    accessInitial !== null &&
    accessChanged(accessDraft, accessInitial);

  // Commit, then re-read the chatbot, so the status rail and the troubleshooting
  // checklist stop reporting the allow-list that was enforced a moment ago.
  // `commit` resolves either way and reports its own failure through `saveError`;
  // re-reading after a failed save is harmless, it returns the same row.
  const commitAccess = async () => {
    await access.commit();
    deploy.retry();
  };

  // A broken install opens on the checklist; everyone else opens on the steps
  // for their own stack. The reader's own choice always wins once they make one.
  const activeHelpTab: HelpTab =
    helpTab ?? (deploy.status.state === 'not-detected' ? 'troubleshoot' : 'platform');

  return (
    <Page>
      {header}

      <Stack>
        {/* A row-paired 2-up. Each left card has its right neighbour locked to
            the same row, which two independent columns could not guarantee: the
            platform instructions sit beside the snippet, and the live install
            reading sits beside Access — the allow-list most likely to be keeping
            that reading empty. `align="start"` lets each card keep its own
            height rather than stretching to the tallest in its row. */}
        <Grid cols={2} align="start">
          {/* Row 1, left — the artefact. */}
          <SnippetSection
            botKey={botKey}
            botName={bot.name || 'OyeChats'}
            botId={agentId}
            env={deploy.env}
            apiBaseUrl={deploy.apiBaseUrl}
            platform={platform}
            attribution={attribution}
            resolving={entitlementsLoading}
            devInviteEmail={bot.dev_invite_email ?? null}
            devInviteSentAt={bot.dev_invite_sent_at ?? null}
          />

          {/* Row 1, right — help beside the snippet: a reader who has just
              copied the tag wants their platform's steps next, and a broken
              install opens on the checklist. Two tabs over one card. */}
          <Tabs
            label={t('agents.installHelp') || 'Install help'}
            value={activeHelpTab}
            onValueChange={(next) => setHelpTab(next as HelpTab)}
            items={[
              { value: 'platform', label: t('agents.instructionsForYourPlatform') || 'Instructions for your platform' },
              { value: 'troubleshoot', label: t('agents.notShowingUp') || 'Not showing up' },
            ]}
          >
            <TabPanel value="platform">
              <Card>
                <CardBody>
                  <PlatformGuide
                    botKey={botKey}
                    env={deploy.env}
                    platformId={platformId}
                    onPlatformChange={setPlatformId}
                    attribution={attribution}
                    resolving={entitlementsLoading}
                  />
                </CardBody>
              </Card>
            </TabPanel>
            <TabPanel value="troubleshoot">
              <Card>
                <CardBody flush>
                  <TroubleshootSection
                    botKey={botKey}
                    env={deploy.env}
                    apiBaseUrl={deploy.apiBaseUrl}
                    website={website}
                    domains={domains}
                    domainsConfigured={domains.length}
                    domainCheckEnabled={Boolean(bot.domain_check_enabled)}
                  />
                </CardBody>
              </Card>
            </TabPanel>
          </Tabs>

          {/* Row 2, left — Access. `scroll-mt` keeps the heading clear of the
              sticky topbar when the status card's "Allowed domains" link jumps
              here. The cell always renders — a skeleton while the access slice
              loads — so the row pairing does not collapse mid-load. */}
          <div id="access" className="scroll-mt-24">
            {accessDraft ? (
              <SettingGroup
                title="Access"
                description="Where this chatbot is allowed to run, and how far a conversation follows a visitor."
              >
                <AccessSection
                  website={website}
                  domains={accessDraft.allowedDomains}
                  domainCheckEnabled={accessDraft.domainCheckEnabled}
                  sessionShareDomain={accessDraft.sessionShareDomain}
                  onChange={setAccess}
                />
              </SettingGroup>
            ) : (
              <Card>
                <CardBody className="space-y-3">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-control-md w-full" />
                </CardBody>
              </Card>
            )}
          </div>

          {/* Row 2, right — the live install reading beside Access, and the
              shareable hosted demo beneath it. Nudged down by the Access
              section's title+description header (~56px), so the card lines up
              with the Access card rather than its heading. Only in two-column
              mode; single-column stacks flush with no gap. */}
          <Stack className="@3xl/page:mt-14">
            <InstallStatusCard
              status={deploy.status}
              installedAt={bot.widget_installed_at ?? null}
              heartbeat={widgetHeartbeat({
                installedAt: bot.widget_installed_at,
                lastSeenAt: bot.widget_last_seen_at,
                lastOrigin: bot.widget_last_origin,
              })}
              website={website}
              domains={domains}
              installs={deploy.domains}
              domainsLoading={deploy.domainsLoading}
              domainsChecking={deploy.domainsChecking}
              domainsCheckedAt={deploy.domainsCheckedAt}
              onCheckDomains={deploy.checkDomains}
              domainsCheckError={deploy.domainsCheckError}
              accessHref="#access"
              verifiedNow={deploy.verifiedNow}
              checking={deploy.checking}
              onStartVerifying={deploy.startVerifying}
              onStopVerifying={deploy.stopVerifying}
              onTroubleshoot={() => setHelpTab('troubleshoot')}
            />

            {/* A hosted page that runs this chatbot, for a customer whose site
                is not ready, or who wants a colleague to try it before it goes
                live. It opens the customer's OWN website with the chat on it,
                from a screenshot captured during training, so the card also has
                to say when that capture is missing, running, failed or old: in
                every one of those cases the link quietly falls back to a
                stand-in page, and a customer sending it to a prospect needs to
                know that before they send it.

                How often it is opened is counted on this chatbot's Overview,
                under "Demo shares", where every other figure about it lives. */}
            <DemoLinkCard
              agentId={agentId}
              demoUrl={demoUrl}
              website={website}
              screenshotStatus={bot.demo_screenshot_status}
              screenshotCapturedAt={bot.demo_screenshot_captured_at}
              onRefresh={deploy.retry}
            />
          </Stack>
        </Grid>
      </Stack>

      {/* Outside the grid, because it spans the form it saves. It appears only
          once there is a draft to save, so a page whose access request is still
          in flight does not show a save bar over nothing. */}
      {accessDraft ? (
        <SaveBar
          dirty={access.dirty}
          saving={access.saving}
          saved={access.saved}
          saveError={access.saveError}
          blockedReason={sessionError ? 'Fix the pinned parent domain under Access to save.' : null}
          onSave={() => {
            if (lockingOut) setConfirmingLockout(true);
            else void commitAccess();
          }}
          onDiscard={access.discard}
          guard="this chatbot’s access settings"
        />
      ) : null}

      {/* The allow-list is the fastest way in the product for a customer to take
          their own widget offline, so saving one that does not cover their own
          site is confirmed rather than merely accepted. The guard exists because
          of one exact asymmetry: the backend strips `www.` from a stored entry
          and does not strip it from the browser's `Origin` header. */}
      <ConfirmDialog
        open={confirmingLockout}
        onOpenChange={setConfirmingLockout}
        title="This will block your own website"
        description={
          risk
            ? `Your chatbot is set up for ${risk.host}, and that address does not match anything on this list. Save it and the widget will stop loading there — visitors will see nothing at all. Adding ${risk.suggestions.join(' and ')} fixes it.`
            : ''
        }
        confirmLabel="Save anyway"
        cancelLabel="Go back and fix it"
        destructive
        onConfirm={async () => {
          await commitAccess();
          setConfirmingLockout(false);
        }}
      />
    </Page>
  );
}
