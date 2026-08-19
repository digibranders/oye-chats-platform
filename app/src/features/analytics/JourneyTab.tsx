import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import {
  Alert,
  Card,
  CardBody,
  ErrorState,
  LoadingRows,
  LockedState,
  Stack,
  StatTile,
  buttonClass,
  formatNumber,
} from '../../ui';
import { monthLabel } from './month';
import { isFilterableOutcome, type FilterableOutcome } from './journeyModel';
import { errorMessage, isPlanGate } from './useAnalyticsData';
import { useJourneyData, useJourneyPaths } from './useJourneyData';
import { JourneyFlow } from './JourneyFlow';
import { JourneyPagesPanel } from './JourneyPagesPanel';

/**
 * Journey — one month of one chatbot, fetched once.
 *
 * The plan gate lives in exactly one place: the 402 the API returns. The page
 * this replaces also kept a hard-coded set of plan slugs on the client, so any
 * drift between the two rendered a locked card inside a locked card, and adding
 * a plan on the server meant remembering to add it here too.
 */
export function JourneyTab({ botId, month }: { botId: number | null; month: string }) {
  const [params, setParams] = useSearchParams();
  const rawOutcome = params.get('outcome');
  const outcome: FilterableOutcome | null =
    rawOutcome && isFilterableOutcome(rawOutcome) ? rawOutcome : null;

  const journey = useJourneyData(botId, month);
  const paths = useJourneyPaths(botId, month, outcome);
  const label = monthLabel(month);

  function selectOutcome(next: FilterableOutcome | null) {
    const updated = new URLSearchParams(params);
    if (next) updated.set('outcome', next);
    else updated.delete('outcome');
    setParams(updated, { replace: true });
  }

  if (journey.loading) {
    return (
      <Card>
        <CardBody>
          <LoadingRows rows={6} />
        </CardBody>
      </Card>
    );
  }

  if (journey.error) {
    return isPlanGate(journey.error) ? (
      <LockedState
        title="Visitor journeys are on Standard and above"
        description="Journeys show the pages someone read before they opened the chat and what they did afterwards. Collection is already running on your workspace, so the history appears the moment you upgrade."
        action={
          <Link to="/billing" className={buttonClass('primary', 'sm')}>
            See plans
          </Link>
        }
      />
    ) : (
      <Card>
        <ErrorState
          title="Journeys could not be loaded"
          description={errorMessage(journey.error, 'The request for visitor journeys failed.')}
          onRetry={() => void journey.refetch()}
        />
      </Card>
    );
  }

  if (!journey.data) return null;

  const { summary, outcomes, preChatSequences, postChat, prePages } = journey.data;
  const conversions =
    summary.meeting_booked + summary.handoff_requested + summary.offline_message_sent;

  return (
    <Stack>
      {/* The one place on this surface that does not speak in trailing windows,
          and it says why rather than letting the reader wonder. */}
      <Alert tone="neutral">
        Journeys are collected and reported by calendar month, so this tab has its own month
        picker rather than the period the other tabs use.
      </Alert>

      <Card>
        <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          <StatTile
            label="Tracked journeys"
            value={formatNumber(summary.sessions_with_journey)}
            period={label}
          />
          <StatTile
            label="Reached an outcome"
            value={formatNumber(conversions)}
            period={label}
            hint="Booked a meeting, asked for a person, or left a message"
          />
          <StatTile
            label="Left their details"
            value={formatNumber(summary.leads_captured)}
            period={label}
          />
          <StatTile
            label="Started on a page"
            value={formatNumber(preChatSequences.sessions_with_pre_chat)}
            period={label}
            hint="Browsed at least one page before opening the chat"
          />
        </CardBody>
      </Card>

      <JourneyFlow
        summary={summary}
        outcomes={outcomes}
        sequences={preChatSequences}
        postChat={postChat}
        monthLabel={label}
        selectedOutcome={outcome}
        onSelectOutcome={selectOutcome}
        paths={paths.paths}
        pathsLoading={paths.loading}
        pathsError={
          paths.error ? errorMessage(paths.error, 'The request for these routes failed.') : null
        }
      />

      <JourneyPagesPanel
        rows={prePages.rows}
        journeys={summary.sessions_with_journey}
        monthLabel={label}
      />
    </Stack>
  );
}
