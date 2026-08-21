import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import {
  Card,
  CardBody,
  CardHeader,
  Columns,
  CopyField,
  EmptyState,
  ErrorState,
  LockedState,
  Page,
  PageHeader,
  Skeleton,
  Stack,
  TabPanel,
  Tabs,
  buttonClass,
} from '../../../ui';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getBotDemoUrl, trackDemoShareClick } from '../../../services/api';
import { agentPath } from '../../../shell/nav';
import { platforms } from '../../../data/platformIntegrations';
import { useDeployData } from './useDeployData';
import { widgetHeartbeat } from './deployModel';
import { InstallStatusCard } from './InstallStatusCard';
import { SnippetSection } from './SnippetSection';
import { PlatformGuide } from './PlatformGuide';
import { TroubleshootSection } from './TroubleshootSection';

type HelpTab = 'platform' | 'troubleshoot';

/** The page while the chatbot is still being fetched. Shaped like what arrives. */
function DeploySkeleton() {
  return (
    <Columns
      asideWidth="sm"
      aside={
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
      }
      main={
        <Stack>
          <Card>
            <CardBody className="space-y-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-control-md w-full" />
              <Skeleton className="h-32 w-full rounded-md" />
              <Skeleton className="h-control-md w-72" />
            </CardBody>
          </Card>
          {/* The help tabs are part of the shape that arrives, and they are in
              this column: without them the page grew by ~300px under the reader
              the moment the chatbot landed. */}
          <div className="space-y-6">
            <Skeleton className="h-10 w-72" />
            <Card>
              <CardBody className="space-y-3">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-control-md w-80" />
              </CardBody>
            </Card>
          </div>
        </Stack>
      }
    />
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
 * Crisp and Chatbase all do instead is put the artefact and the verification
 * state on screen together: the snippet on the left, the install status pinned
 * on the right, and everything else behind one tabbed help card.
 *
 * **The settings that were here are not install steps.** The origin allow-list
 * and the session-continuity parent are on Behaviour ▸ Access now, under that
 * page's single draft and single save bar; the in-widget credit line is on
 * Experience ▸ Branding, which already owned its on/off switch. Deploy carries
 * no save state of its own at all.
 *
 * Nothing on this page is a wizard step and nothing blocks: the customer can
 * copy the snippet, hand it to a developer, close the tab, and come back in a
 * week to a page that still tells them the truth.
 */
export function DeployPage() {
  const { agent, loading: agentLoading } = useAgent();
  const deploy = useDeployData();
  const { hasFeature, loading: entitlementsLoading } = useEntitlements();
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [helpTab, setHelpTab] = useState<HelpTab | null>(null);

  // The snippet variant is entitlement-driven and keys off the plan, not off the
  // chatbot's own `show_branding` flag: a paid customer who chooses to keep the
  // badge still gets an anchor-free snippet, because the anchor and the badge
  // are different things.
  const attribution = !hasFeature('branding_removable');

  const bot = deploy.bot;
  const platform = platforms.find((p) => p.id === platformId) ?? null;

  const header = (
    <PageHeader
      title="Deploy"
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
            Try it now
            <span className="sr-only"> (opens a hosted preview in a new tab)</span>
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
          title="This chatbot is not in your workspace"
          description="It may belong to another workspace."
          action={
            <Link to="/chatbots" className={buttonClass('primary', 'sm')}>
              See your chatbots
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
          title="We could not load this chatbot"
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
          title="No chatbot open"
          action={
            <Link to="/chatbots" className={buttonClass('primary', 'sm')}>
              See your chatbots
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
          title="This chatbot has no embed key yet"
          description="Open it from the list and finish setting it up."
          action={
            <Link to="/chatbots" className={buttonClass('secondary', 'sm')}>
              See your chatbots
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

  // A broken install opens on the checklist; everyone else opens on the steps
  // for their own stack. The reader's own choice always wins once they make one.
  const activeHelpTab: HelpTab =
    helpTab ?? (deploy.status.state === 'not-detected' ? 'troubleshoot' : 'platform');

  return (
    <Page>
      {header}

      <Stack>
        <Columns
          asideWidth="sm"
          stickyAside
          asideLabel="Install status"
          main={
            <Stack>
              <SnippetSection
                botKey={botKey}
                botName={bot.name || 'OyeChats'}
                botId={agentId}
                env={deploy.env}
                apiBaseUrl={deploy.apiBaseUrl}
                platform={platform}
                attribution={attribution}
                resolving={entitlementsLoading}
              />

              {/* Help, only when wanted: two tabs over one card, instead of two
                  more cards the reader has to scroll past to reach anything. A
                  broken install opens on the checklist.

                  It sits in `main`, not under the grid. `Columns` is exactly as
                  tall as its taller column, and the snippet alone was shorter
                  than the status rail beside it — so the left column ended in
                  about 290px of empty page, and the help card below then ran the
                  full width, changing the reader's measure mid-scroll. Both are
                  the same fix: put the longer block in `main`. */}
              <Tabs
                label="Install help"
                value={activeHelpTab}
                onValueChange={(next) => setHelpTab(next as HelpTab)}
                items={[
                  { value: 'platform', label: 'Instructions for your platform' },
                  { value: 'troubleshoot', label: 'Not showing up' },
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
            </Stack>
          }
          aside={
            <Stack>
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
                accessHref={agentPath(agentId, 'behaviour')}
                verifiedNow={deploy.verifiedNow}
                checking={deploy.checking}
                onStartVerifying={deploy.startVerifying}
                onStopVerifying={deploy.stopVerifying}
                onTroubleshoot={() => setHelpTab('troubleshoot')}
              />

              {/* A hosted page that runs this chatbot, for a customer whose site
                  is not ready — or who wants a colleague to try it before it
                  goes live. How often it is opened is counted on this chatbot's
                  Overview, under "Demo shares", where every other figure about
                  it already lives — this card carries the link and nothing else.
                  It used to carry a second ghost control labelled "Opens", which
                  read as a truncated label rather than as a destination. */}
              <Card>
                <CardHeader size="sm" titleAs="h2" title="Share a link instead" />
                <CardBody className="space-y-2">
                  <CopyField value={demoUrl} label="demo link" compact />
                  <a
                    href={demoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass('ghost', 'sm')}
                    onClick={() => {
                      // Attribution is best-effort and deliberately unawaited: a
                      // failed count must never stand between the customer and
                      // the link they just clicked.
                      void trackDemoShareClick(agentId).catch(() => undefined);
                    }}
                  >
                    <ExternalLink aria-hidden />
                    Open it
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </CardBody>
              </Card>
            </Stack>
          }
        />
      </Stack>
    </Page>
  );
}
