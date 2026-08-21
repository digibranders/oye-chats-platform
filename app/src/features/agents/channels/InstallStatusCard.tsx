import { CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
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
  StatusDot,
  buttonClass,
  formatDateTime,
  formatRelative,
} from '../../../ui';
import { INSTALL_STAMP_CAPTION, type InstallStatus, type WidgetHeartbeat } from './deployModel';

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
  /** Where the allow-list is edited — Behaviour ▸ Access. */
  accessHref: string;
  /** True only when the transition was observed on this page, just now. */
  verifiedNow: boolean;
  checking: boolean;
  onStartVerifying: () => void;
  onStopVerifying: () => void;
  /** Open the troubleshooting tab on the help card below. */
  onTroubleshoot: () => void;
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
}: InstallStatusCardProps) {
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
              Open my website
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
          {status.state === 'waiting' ? (
            <Button size="sm" variant="accent" onClick={onStartVerifying}>
              I have added it — check now
            </Button>
          ) : null}
          {status.state === 'not-detected' ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={onStartVerifying}
              iconLeft={<RefreshCw aria-hidden />}
            >
              Check again
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
                label: INSTALL_STAMP_CAPTION,
                value: <span className="figure">{formatDateTime(installedAt)}</span>,
              },
              {
                label: 'Last seen',
                value: heartbeat.seenAt ? (
                  <span className="figure">{formatRelative(heartbeat.seenAt)}</span>
                ) : (
                  ABSENT
                ),
              },
              {
                label: 'Loaded from',
                value: heartbeat.origin ? (
                  <span className="figure break-all">{heartbeat.origin}</span>
                ) : (
                  ABSENT
                ),
                note: 'Reported by the browser, so useful for support and never proof of anything.',
              },
              {
                label: 'Allowed domains',
                value: (
                  <Link
                    to={accessHref}
                    className="text-accent-600 underline-offset-2 hover:underline"
                  >
                    {domains.length > 0 ? (
                      <span className="figure">{domains.length}</span>
                    ) : (
                      'Any'
                    )}
                  </Link>
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

      {checking ? (
        <CardFooter className="justify-between">
          <div className="min-w-0 flex-1">
            {/* `hideLabel`: the card's own heading is `status.label`, which in
                this state is this exact string. The bar is chrome under a
                heading that has already named it; the `aria-label` still
                carries the sentence. */}
            <Progress value={null} label="Looking for your widget" hideLabel />
            <p className="mt-2 text-xs text-text-secondary">
              Open your site in another tab — this updates on its own.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onStopVerifying}>
            Not yet
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
            title="Your chatbot is live"
            icon={<CheckCircle2 aria-hidden className="h-icon-md w-icon-md" />}
            className="w-full"
          >
            We just saw it load on your website. Visitors can talk to it now.
          </Alert>
        </CardFooter>
      ) : null}

      {status.state === 'not-detected' ? (
        <CardFooter className="justify-start">
          <Alert
            tone="warning"
            live
            title="We still cannot see it"
            className="w-full"
            action={
              <Button size="sm" variant="secondary" onClick={onTroubleshoot}>
                What to check
              </Button>
            }
          >
            Nothing has reached us yet. The checklist rules out every known cause.
          </Alert>
        </CardFooter>
      ) : null}
    </Card>
  );
}
