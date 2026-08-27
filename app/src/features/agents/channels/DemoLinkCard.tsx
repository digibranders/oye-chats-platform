import { type ReactElement, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Alert, Button, Card, CardBody, CardHeader, CopyField, buttonClass } from '../../../ui';
import { recaptureDemoScreenshot, trackDemoShareClick } from '../../../services/api';
import { type DemoPreviewState, demoPreviewState } from './deployModel';

/**
 * The shareable demo link, and an honest account of what it shows.
 *
 * The hosted demo page renders a stored screenshot of the customer's own
 * website with the real widget live on top. That capture is taken during
 * training, so it can be missing, still running, failed, or old, and the link
 * silently falls back to a generic page whenever it isn't usable. A customer
 * who is about to send this link to a prospect needs to know which of those is
 * true before they send it, not after.
 */

export interface DemoLinkCardProps {
  agentId: number;
  demoUrl: string;
  website: string | null;
  screenshotStatus: string | null | undefined;
  screenshotCapturedAt: string | null | undefined;
  /** Refetch the chatbot so a finished capture flips the state without a reload. */
  onRefresh?: () => void;
}

/** The one-line promise the card makes about the link, per state. */
function describe(state: DemoPreviewState, website: string | null): string {
  switch (state.kind) {
    case 'ready':
      return `Opens ${website} with your chat on it. Anyone with the link can try it, no install needed.`;
    case 'stale':
      return `Opens a preview of ${website}, captured a while ago. Refresh it if the site has changed since.`;
    case 'pending':
      return `We are taking a picture of ${website} now. Until it is ready the link opens a stand-in page.`;
    case 'no-website':
      return 'Add this chatbot’s website address and the link will open your own site with the chat on it.';
    case 'unavailable':
      return `We could not capture ${website ?? 'your website'}, so the link opens a stand-in page for now.`;
  }
}

export function DemoLinkCard({
  agentId,
  demoUrl,
  website,
  screenshotStatus,
  screenshotCapturedAt,
  onRefresh,
}: DemoLinkCardProps): ReactElement {
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = demoPreviewState({
    website,
    // A capture requested in this session is pending from the reader's point of
    // view straight away. Waiting for the next poll to say so would read as the
    // button having done nothing.
    status: requested ? 'pending' : screenshotStatus,
    capturedAt: screenshotCapturedAt,
  });

  // Offered during 'pending' too, deliberately. A capture that dies without
  // recording a terminal status would otherwise strand the card on "we are
  // taking a picture now" with no way out. Repeat dispatches are deduplicated
  // on a per-bot job id, so the cost of an impatient second click is nothing.
  const canRecapture = state.kind !== 'no-website';

  const recapture = async (): Promise<void> => {
    setRequesting(true);
    setError(null);
    try {
      await recaptureDemoScreenshot(agentId);
      setRequested(true);
      onRefresh?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not start the preview.');
    } finally {
      setRequesting(false);
    }
  };

  return (
    <Card>
      <CardHeader size="sm" titleAs="h2" title="Share a link instead" />
      <CardBody className="space-y-2">
        <p className="text-xs text-text-secondary">{describe(state, website)}</p>

        <CopyField value={demoUrl} label="demo link" compact />

        <div className="flex flex-wrap items-center gap-1">
          <a
            href={demoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass('ghost', 'sm')}
            onClick={() => {
              // Attribution is best-effort and deliberately unawaited: a
              // failed count must never stand between the customer and the
              // link they just clicked.
              void trackDemoShareClick(agentId).catch(() => undefined);
            }}
          >
            <ExternalLink aria-hidden />
            Open it
            <span className="sr-only"> (opens in a new tab)</span>
          </a>

          {canRecapture ? (
            <Button variant="ghost" size="sm" onClick={() => void recapture()} disabled={requesting}>
              <RefreshCw aria-hidden />
              {state.kind === 'ready' || state.kind === 'stale'
                ? 'Refresh preview'
                : state.kind === 'pending'
                  ? 'Start over'
                  : 'Try again'}
            </Button>
          ) : null}
        </div>

        {/* Live region: the outcome of a click the reader cannot otherwise see,
            since the capture itself happens on the server minutes later. */}
        <p aria-live="polite" className="sr-only">
          {requested ? 'Website preview requested.' : ''}
        </p>

        {error ? (
          <Alert tone="danger" title="We could not start the preview">
            {error}
          </Alert>
        ) : null}
      </CardBody>
    </Card>
  );
}
