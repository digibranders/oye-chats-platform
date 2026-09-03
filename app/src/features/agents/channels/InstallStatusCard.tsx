import { CheckCircle2, ExternalLink, RadarIcon, RefreshCw } from 'lucide-react';
import {
  ABSENT,
  Alert,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardSection,
  Progress,
  PropertyGrid,
  SkeletonText,
  StatusDot,
  buttonClass,
  formatDateTime,
  formatRelative,
} from '../../../ui';
import { installStampCaption, type InstallStatus, type WidgetHeartbeat } from './deployModel';
import { describeDomain, summariseDomains, type DomainInstall } from './installDomainsModel';
import { useTranslation } from '../../../i18n/useTranslation';

export interface InstallStatusCardProps {
  status: InstallStatus;
  /** `Bot.widget_installed_at`, or null. */
  installedAt: string | null;
  /** The liveness reading, already resolved by `widgetHeartbeat`. */
  heartbeat: WidgetHeartbeat;
  /** The public address the chatbot is configured for, if any. */
  website: string | null;
  /** The origins allowed to embed this chatbot. Empty means any. */
  domains: readonly string[];
  /**
   * The inventory: where the chatbot has been SEEN, which is a different
   * question from where it is permitted. A domain can be live and not allowed
   * (works today, blocked the moment enforcement is switched on), or allowed
   * and empty (configured, never installed) — and the two lists are kept apart
   * here precisely so the card can say which.
   */
  /**
   * Where the allow-list is edited. It is a fragment on this same page rather
   * than a route, so this is a plain anchor: a router `Link` to `#access` would
   * be resolved as a path and match nothing.
   */
  accessHref: string;
  /** True only when the transition was observed on this page, just now. */
  verifiedNow: boolean;
  checking: boolean;
  onStartVerifying: () => void;
  onStopVerifying: () => void;
  /** Open the troubleshooting tab on the help card below. */
  onTroubleshoot: () => void;

  /** Every domain this chatbot is on, has been on, or is allowed on. */
  installs: readonly DomainInstall[];
  domainsLoading: boolean;
  domainsChecking: boolean;
  domainsCheckedAt: string | null;
  onCheckDomains: () => void;
  domainsCheckError: string | null;
}

/**
 * The answer to the page's question, pinned beside the snippet.
 *
 * Two rules shape it. The state carries a **word**, never only a colour — a
 * green dot and an amber dot are the same dot to roughly one reader in twelve.
 * And "waiting to be installed" is **neutral**: a chatbot created five minutes
 * ago is not broken because nobody has edited the website yet. It only turns
 * amber once the customer has told us the snippet is live and we still cannot
 * see it, which is the moment it genuinely is a problem.
 *
 * The four facts underneath are a `PropertyGrid`, not four stacked paragraphs.
 * They were the smallest, faintest type on the page carrying its longest
 * strings — a 34-word sentence in `text-text-tertiary` that ended by telling the
 * reader to scroll. Label → value is what they are, so that is what they render
 * as, and the one caveat worth keeping is a `Tooltip` on the label it qualifies.
 *
 * Verification is never a blocking gate. The flow this replaces ended on a
 * full-screen step that hard-blocked on this exact ping with no way past it, so
 * anyone whose site we could not reach — a staging domain, a login wall, a
 * launch next week — could never finish onboarding and carried a permanent
 * "Resume setup" button forever. Here it is a claim the customer can make, walk
 * away from, and come back to.
 */
export function InstallStatusCard({
  status,
  installedAt,
  heartbeat,
  website,
  domains,
  accessHref,
  verifiedNow,
  checking,
  onStartVerifying,
  onStopVerifying,
  onTroubleshoot,
  installs,
  domainsLoading,
  domainsChecking,
  domainsCheckedAt,
  onCheckDomains,
  domainsCheckError,
}: InstallStatusCardProps) {
  const { t } = useTranslation();
  const websiteHref = website
    ? /^https?:\/\//i.test(website)
      ? website
      : `https://${website}`
    : null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center gap-2">
          {/* The pulse is only for the search that is actually running.
              "Installed" is a durable configuration state, not a live presence,
              and a halo that never stops stops meaning anything. */}
          <StatusDot tone={status.tone} pulse={status.state === 'checking'} label={status.label} />
          {/* The heading is the status word. A badge beside it would be the same
              fact twice, taking the space that the detail line uses to say
              something new. */}
          <h2 className="text-base font-semibold text-text-primary">{status.label}</h2>
        </div>
        <p className="text-xs text-text-secondary">{status.detail}</p>

        <div className="flex flex-wrap items-center gap-2">
          {websiteHref ? (
            <a
              href={websiteHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass('secondary', 'sm')}
            >
              <ExternalLink aria-hidden />
              {t('agents.openMyWebsite') || 'Open my website'}
              <span className="sr-only"> {t('agents.opensInANewTab') || '(opens in a new tab)'}</span>
            </a>
          ) : null}
          {/* `own-domain` shares this button and not the `not-detected` one.
              The customer's next move is the same as `waiting`: paste it on
              their own site. What it is not is a failed check to re-run. */}
          {status.state === 'waiting' || status.state === 'own-domain' ? (
            <Button size="sm" variant="accent" onClick={onStartVerifying}>
              {t('agents.iHaveAddedItCheck') || 'I have added it, check now'}
            </Button>
          ) : null}
          {status.state === 'not-detected' ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={onStartVerifying}
              iconLeft={<RefreshCw aria-hidden />}
            >
              {t('agents.checkAgain') || 'Check again'}
            </Button>
          ) : null}
        </div>
      </CardBody>

      {/* Only once the chatbot has been seen at all — before that the status
          line above is already the whole story. `First seen` and `Last seen` are
          two different facts: the backend stamps `widget_installed_at` exactly
          once and nothing ever refreshes it, so presenting it as a heartbeat
          would invite the customer to read a healthy widget as an outage. */}
      {installedAt ? (
        <CardSection>
          <PropertyGrid
            density="compact"
            items={[
              {
                label: installStampCaption(),
                value: <span className="figure">{formatDateTime(installedAt)}</span>,
              },
              {
                label: t('agents.lastSeen') || 'Last seen',
                value: heartbeat.seenAt ? (
                  <span className="figure">{formatRelative(heartbeat.seenAt)}</span>
                ) : (
                  ABSENT
                ),
              },
              {
                label: t('agents.allowedDomains') || 'Allowed domains',
                value: (
                  <a
                    href={accessHref}
                    className="text-accent-600 underline-offset-2 hover:underline"
                  >
                    {domains.length > 0 ? (
                      <span className="figure">{domains.length}</span>
                    ) : (
                      t('agents.any') || 'Any'
                    )}
                  </a>
                ),
              },
            ]}
          />
          {/* The heartbeat's own reading, in words. A chatbot installed before
              the heartbeat existed has no reading at all, and reporting that as
              a fault would send the customer to debug a working site — so the
              sentence stays visible rather than going behind the tooltip the
              origin's caveat uses. */}
          <p className="mt-2 text-xs text-text-tertiary">{heartbeat.detail}</p>
        </CardSection>
      ) : null}

      {/* The inventory.
          This is what turns the card from "has anything ever loaded this
          chatbot" into "where is it, and where is it not". Two signals feed it
          and they are not equivalent: an observation is a real browser loading
          the widget, a probe is our own fetch of served HTML. The row wording
          in `describeDomain` keeps them distinguishable, because a probe that
          finds nothing on a site whose snippet is injected by a tag manager is
          our blind spot, not the customer's bug. */}
      <CardSection>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('agents.yourDomains') || 'Your domains'}
            </h3>
            <p className="text-xs text-text-secondary">
              {domainsLoading ? '\u00a0' : summariseDomains(installs)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {domainsCheckedAt && !domainsChecking ? (
              <span className="text-xs text-text-tertiary">
                {t('agents.checked') || 'Checked'} {formatRelative(domainsCheckedAt)}
              </span>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              onClick={onCheckDomains}
              disabled={domainsChecking}
              loading={domainsChecking}
              iconLeft={<RadarIcon aria-hidden />}
            >
              {domainsChecking
                ? t('agents.checkingDomains') || 'Checking'
                : t('agents.checkMyDomains') || 'Check my domains'}
            </Button>
          </div>
        </div>

        {domainsCheckError ? (
          <Alert tone="danger" live className="mt-3">
            {domainsCheckError}
          </Alert>
        ) : null}

        {domainsLoading ? (
          <div className="mt-3">
            <SkeletonText lines={2} />
          </div>
        ) : installs.length === 0 ? (
          /* No allow-list, nothing observed. Not a fault: a chatbot restricted
             to no domains runs everywhere, which is the default. */
          <p className="mt-3 text-xs text-text-tertiary">
            {t('agents.noDomainsRecordedYet') ||
              'No domains recorded yet. Add the snippet to your site, or list your domains under Access below, and check again.'}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border-subtle">
            {installs.map((domain) => {
              const presentation = describeDomain(domain);
              return (
                <li key={domain.hostname} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span className="mt-1 shrink-0">
                    <StatusDot tone={presentation.tone} label={presentation.label} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="figure break-all text-sm text-text-primary">{domain.hostname}</span>
                      {/* The word, never only the dot. */}
                      <span className="text-xs font-medium text-text-secondary">{presentation.label}</span>
                    </div>
                    <p className="text-xs text-text-tertiary">{presentation.detail}</p>
                    {domain.other_chatbot ? (
                      <p className="mt-0.5 text-xs text-text-tertiary">
                        {t('agents.foundInstead') || 'Found instead'}:{' '}
                        <span className="figure break-all">{domain.other_chatbot}</span>
                      </p>
                    ) : null}
                    {domain.observed_last_at ? (
                      <p className="mt-0.5 text-xs text-text-tertiary">
                        {t('agents.lastVisitorHere') || 'Last visitor here'}{' '}
                        {formatRelative(domain.observed_last_at)}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardSection>

      {checking ? (
        <CardFooter className="justify-between">
          <div className="min-w-0 flex-1">
            {/* `hideLabel`: the card's own heading is `status.label`, which in
                this state is this exact string. The bar is chrome under a
                heading that has already named it; the `aria-label` still
                carries the sentence. */}
            <Progress value={null} label={t('agents.lookingForYourWidget') || 'Looking for your widget'} hideLabel />
            <p className="mt-2 text-xs text-text-secondary">
              {t('agents.openYourSiteInAnother') || 'Open your site in another tab. This updates on its own.'}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onStopVerifying}>
            {t('agents.notYet') || 'Not yet'}
          </Button>
        </CardFooter>
      ) : null}

      {/* The outcome, announced. A colour change on a dot is not feedback for
          anyone who cannot see it. */}
      {verifiedNow ? (
        <CardFooter className="justify-start">
          <Alert
            tone="success"
            live
            title={t('agents.yourChatbotIsLive') || 'Your chatbot is live'}
            icon={<CheckCircle2 aria-hidden className="h-icon-md w-icon-md" />}
            className="w-full"
          >
            {t('agents.weJustSawItLoad') || 'We just saw it load on your website. Visitors can talk to it now.'}
          </Alert>
        </CardFooter>
      ) : null}

      {status.state === 'not-detected' ? (
        <CardFooter className="justify-start">
          <Alert
            tone="warning"
            live
            title={t('agents.weStillCannotSeeIt') || 'We still cannot see it'}
            className="w-full"
            action={
              <Button size="sm" variant="secondary" onClick={onTroubleshoot}>
                {t('agents.whatToCheck') || 'What to check'}
              </Button>
            }
          >
            {t('agents.nothingHasReachedUsYet') || 'Nothing has reached us yet. The checklist rules out every known cause.'}
          </Alert>
        </CardFooter>
      ) : null}

      {/* The stale reading gets the same footer, and deliberately not a "check
          again" button: the verification poll waits for `widget_installed_at`,
          which this chatbot already has, so it would spin for ninety seconds
          and then report the stamp it started with. The checklist is the real
          remedy, and the date is already on the `Last seen` row above. */}
      {status.state === 'stale' ? (
        <CardFooter className="justify-start">
          <Alert
            tone="warning"
            live
            title={t('agents.weHaveNotSeenIt') || 'We have not seen it recently'}
            className="w-full"
            action={
              <Button size="sm" variant="secondary" onClick={onTroubleshoot}>
                {t('agents.whatToCheck') || 'What to check'}
              </Button>
            }
          >
            {t('agents.theWidgetLastLoadedMoreThanAWeek') ||
              'The widget last loaded more than a week ago. If the snippet is still on your site and getting traffic, the checklist rules out every known cause.'}
          </Alert>
        </CardFooter>
      ) : null}
    </Card>
  );
}
