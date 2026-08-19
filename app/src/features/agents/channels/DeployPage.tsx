import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import {
  Card,
  CardBody,
  CardHeader,
  CopyField,
  EmptyState,
  ErrorState,
  LockedState,
  Page,
  PageHeader,
  Skeleton,
  Stack,
  buttonClass,
} from '../../../ui';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getBotDemoUrl, trackDemoShareClick } from '../../../services/api';
import { agentPath } from '../../../shell/nav';
import { platforms } from '../../../data/platformIntegrations';
import { useDeployData } from './useDeployData';
import { InstallStatusCard } from './InstallStatusCard';
import { SnippetSection } from './SnippetSection';
import { PlatformGuide } from './PlatformGuide';
import { TroubleshootSection } from './TroubleshootSection';
import { AllowedDomainsSection } from './AllowedDomainsSection';
import { SessionContinuitySection } from './SessionContinuitySection';
import { AttributionSection } from './AttributionSection';

const TROUBLESHOOT_ID = 'deploy-troubleshooting';

/** The page while the chatbot is still being fetched. Shaped like what arrives. */
function DeploySkeleton() {
  return (
    <Stack>
      <Card>
        <CardBody className="space-y-3">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-3.5 w-80" />
        </CardBody>
      </Card>
      <Card>
        <CardBody className="space-y-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full rounded-md" />
        </CardBody>
      </Card>
      <Card>
        <CardBody className="space-y-3">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-8 w-64" />
        </CardBody>
      </Card>
    </Stack>
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
 * So the order is: **the answer, the snippet, how to place it, and what to do
 * when it does not show up** — then the two settings that govern where the
 * widget is allowed to run. Nothing on this page is a wizard step and nothing
 * blocks: the customer can copy the snippet, hand it to a developer, close the
 * tab, and come back in a week to a page that still tells them the truth.
 */
export function DeployPage() {
  const { agent, loading: agentLoading } = useAgent();
  const deploy = useDeployData();
  const { hasFeature, loading: entitlementsLoading } = useEntitlements();
  const [platformId, setPlatformId] = useState<string | null>(null);

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
      description="Put this chatbot on your website, and check that it is really answering."
      actions={
        bot?.bot_key ? (
          <a
            href={getBotDemoUrl(bot.bot_key)}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass('secondary', 'md')}
          >
            <ExternalLink aria-hidden className="h-4 w-4" />
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
          description="It may belong to another workspace, or it may have been deleted. Open one of your own chatbots to deploy it."
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
        <Card>
          <ErrorState
            title="We could not load this chatbot"
            description={deploy.failure.message}
            onRetry={deploy.retry}
          />
        </Card>
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
        <Card>
          <EmptyState
            title="No chatbot open"
            description="Deploy configures one chatbot at a time. Open one to get its snippet."
            action={
              <Link to="/chatbots" className={buttonClass('primary', 'sm')}>
                See your chatbots
              </Link>
            }
          />
        </Card>
      </Page>
    );
  }

  if (!bot || !bot.bot_key || deploy.agentId == null) {
    return (
      <Page>
        {header}
        <Card>
          <EmptyState
            title="This chatbot has no embed key yet"
            description="An embed key is issued when a chatbot finishes being created. If this one was interrupted, open it again from the list and finish setting it up."
            action={
              <Link to="/chatbots" className={buttonClass('secondary', 'sm')}>
                See your chatbots
              </Link>
            }
          />
        </Card>
      </Page>
    );
  }

  // Hoisted after the guards above so the rest of the page works with a plain
  // `number` rather than re-asserting the same narrowing at each call site.
  const agentId = deploy.agentId;
  const botKey = bot.bot_key;
  const website = bot.website ?? null;
  const demoUrl = getBotDemoUrl(botKey);

  return (
    <Page>
      {header}
      <Stack>
        <InstallStatusCard
          status={deploy.status}
          installedAt={bot.widget_installed_at ?? null}
          website={website}
          verifiedNow={deploy.verifiedNow}
          checking={deploy.checking}
          onStartVerifying={deploy.startVerifying}
          onStopVerifying={deploy.stopVerifying}
          troubleshootHref={`#${TROUBLESHOOT_ID}`}
        />

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

        <PlatformGuide
          botKey={botKey}
          env={deploy.env}
          platformId={platformId}
          onPlatformChange={setPlatformId}
          attribution={attribution}
          resolving={entitlementsLoading}
        />

        <TroubleshootSection
          id={TROUBLESHOOT_ID}
          botKey={botKey}
          env={deploy.env}
          apiBaseUrl={deploy.apiBaseUrl}
          website={website}
          domains={bot.allowed_domains ?? []}
          domainsConfigured={(bot.allowed_domains ?? []).length}
          domainCheckEnabled={Boolean(bot.domain_check_enabled)}
        />

        {/* A hosted page that runs this chatbot, for a customer whose site is
            not ready — or who wants a colleague to try it before it goes live.
            The share and open counts land on this chatbot's Overview, which is
            where every other figure about it already lives; duplicating them
            here would be a fourth definition of the same number. */}
        <Card>
          <CardHeader
            eyebrow="No website yet?"
            titleAs="h2"
            title="Share a link instead"
            description="A hosted page running this exact chatbot. Send it to a colleague, or use it while your site is still being built."
          />
          <CardBody className="space-y-3">
            <CopyField value={demoUrl} label="demo link" />
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={demoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClass('secondary', 'sm')}
                onClick={() => {
                  // Attribution is best-effort and deliberately unawaited: a
                  // failed count must never stand between the customer and the
                  // link they just clicked.
                  void trackDemoShareClick(agentId).catch(() => undefined);
                }}
              >
                <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                Open the demo
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              <Link
                to={agentPath(agentId, 'overview')}
                className={buttonClass('ghost', 'sm')}
              >
                See how many people opened it
              </Link>
            </div>
          </CardBody>
        </Card>

        <AllowedDomainsSection
          key={`domains-${agentId}`}
          website={website}
          initialDomains={bot.allowed_domains ?? []}
          initialEnabled={Boolean(bot.domain_check_enabled)}
          saving={deploy.saving}
          onSave={async ({ allowed_domains, domain_check_enabled }) => {
            const fresh = await deploy.save({ allowed_domains, domain_check_enabled });
            return {
              allowed_domains: fresh.allowed_domains ?? [],
              domain_check_enabled: Boolean(fresh.domain_check_enabled),
            };
          }}
        />

        <SessionContinuitySection
          key={`session-${agentId}`}
          website={website}
          initialShareDomain={bot.session_share_domain ?? null}
          saving={deploy.saving}
          onSave={async (patch) => {
            const fresh = await deploy.save(patch);
            return fresh.session_share_domain ?? null;
          }}
        />

        <AttributionSection
          key={`branding-${agentId}`}
          entitled={hasFeature('branding_removable')}
          entitlementsLoading={entitlementsLoading}
          initialText={bot.branding_text ?? null}
          initialUrl={bot.branding_url ?? null}
          saving={deploy.saving}
          onSave={async (patch) => {
            await deploy.save(patch);
          }}
        />
      </Stack>
    </Page>
  );
}
