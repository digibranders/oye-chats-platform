import { CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardFooter,
  Progress,
  StatusDot,
  buttonClass,
  formatDateTime,
  formatRelative,
} from '../../../ui';
import { INSTALL_STAMP_CAPTION, type InstallStatus } from './deployModel';

export interface InstallStatusCardProps {
  status: InstallStatus;
  /** `Bot.widget_installed_at`, or null. */
  installedAt: string | null;
  /** The public address the chatbot is configured for, if any. */
  website: string | null;
  /** True only when the transition was observed on this page, just now. */
  verifiedNow: boolean;
  checking: boolean;
  onStartVerifying: () => void;
  onStopVerifying: () => void;
  /** Jump to the troubleshooting list further down the page. */
  troubleshootHref: string;
}

/**
 * The answer to the page's question, at the top of the page.
 *
 * Two rules shape it. The state carries a **word**, never only a colour — a
 * green dot and an amber dot are the same dot to roughly one reader in twelve.
 * And "waiting to be installed" is **neutral**: a chatbot created five minutes
 * ago is not broken because nobody has edited the website yet. It only turns
 * amber once the customer has told us the snippet is live and we still cannot
 * see it, which is the moment it genuinely is a problem.
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
  website,
  verifiedNow,
  checking,
  onStartVerifying,
  onStopVerifying,
  troubleshootHref,
}: InstallStatusCardProps) {
  const websiteHref = website
    ? /^https?:\/\//i.test(website)
      ? website
      : `https://${website}`
    : null;

  return (
    <Card>
      <CardBody className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* The pulse is only for the search that is actually running.
                "Installed" is a durable configuration state, not a live
                presence, and a halo that never stops stops meaning anything. */}
            <StatusDot tone={status.tone} pulse={status.state === 'checking'} label={status.label} />
            {/* The heading is the status word. A badge beside it would be the
                same fact twice, taking the space that the detail line uses to
                say something new. */}
            <h2 className="text-lg font-semibold text-text-primary">{status.label}</h2>
          </div>
          <p className="mt-1.5 max-w-prose text-prose text-text-secondary">{status.detail}</p>

          {installedAt ? (
            // Captioned "First seen", not "last seen". The backend stamps
            // `widget_installed_at` exactly once, with a guarded
            // `UPDATE ... WHERE widget_installed_at IS NULL`, and nothing ever
            // refreshes it — so presenting it as a heartbeat would invite the
            // customer to read a perfectly healthy widget as an outage.
            <p className="mt-3 text-xs text-text-secondary">
              {INSTALL_STAMP_CAPTION}{' '}
              <span className="figure text-text-primary">{formatDateTime(installedAt)}</span>
              <span className="text-text-tertiary"> · {formatRelative(installedAt)}</span>
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {websiteHref ? (
            <a
              href={websiteHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass('secondary', 'sm')}
            >
              <ExternalLink aria-hidden className="h-3.5 w-3.5" />
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
            <Button size="sm" variant="secondary" onClick={onStartVerifying} iconLeft={<RefreshCw aria-hidden className="h-3.5 w-3.5" />}>
              Check again
            </Button>
          ) : null}
        </div>
      </CardBody>

      {checking ? (
        <CardFooter className="justify-between">
          <div className="min-w-0 flex-1">
            <Progress value={null} label="Looking for your widget" />
            <p className="mt-2 text-xs text-text-secondary">
              Load any page of your site in another tab. We check every few seconds and this
              updates on its own.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onStopVerifying}>
            Not yet — remind me later
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
            icon={<CheckCircle2 aria-hidden className="h-4 w-4" />}
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
              <a href={troubleshootHref} className={buttonClass('secondary', 'sm')}>
                What to check
              </a>
            }
          >
            Nothing has reached us from your site yet. The checklist below rules out every cause
            we know about, and each one takes under a minute.
          </Alert>
        </CardFooter>
      ) : null}
    </Card>
  );
}
