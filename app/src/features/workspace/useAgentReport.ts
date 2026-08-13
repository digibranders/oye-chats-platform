import { useEffect, useState } from 'react';
import { getPerAgentReport, type PerAgentReport } from '../../services/api';
import type { ReportRange } from './reportsModel';

/**
 * Loading state machine for Workspace ▸ Reports. `loading` is a genuine
 * derived phase - the first `setState` inside the effect always follows an
 * `await`, so the effect never sets state synchronously on mount.
 */
export type ReportPhase =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly report: PerAgentReport };

export interface AgentReportData {
  readonly phase: ReportPhase;
  /** Re-fetch the current window. Safe to wire to a "Try again" button. */
  readonly retry: () => void;
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * useAgentReport - fetches the per-agent rollup for a trailing window.
 *
 * Deliberately NOT scoped to the shell's agent switcher. The whole point of
 * this surface is every agent side by side, one row each, so an agency can
 * pull the numbers for all of its clients in one pass; narrowing it to the
 * selected agent would leave the page with nothing to compare.
 */
export function useAgentReport(days: ReportRange): AgentReportData {
  const [phase, setPhase] = useState<ReportPhase>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);

  // A range change is a different question, not a refresh of the same one.
  // Left alone, the previous window's rows would stay on screen under the new
  // window's label until the fetch landed - the page would be quoting 30-day
  // numbers while claiming they cover 7 days. Reset to `loading` during render
  // (React's sanctioned "adjust state when a prop changes" pattern, as used by
  // `DataTable`'s pager) so the stale figures are never attributable to the
  // new range for even one frame.
  const [activeRange, setActiveRange] = useState<ReportRange>(days);
  if (activeRange !== days) {
    setActiveRange(days);
    setPhase({ status: 'loading' });
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const report = await getPerAgentReport(days);
        if (!active) return;
        setPhase({ status: 'ready', report });
      } catch (cause) {
        if (!active) return;
        setPhase({
          status: 'error',
          message: toMessage(cause, 'We couldn’t load your report. Please try again.'),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [days, refreshToken]);

  const retry = (): void => {
    setPhase({ status: 'loading' });
    setRefreshToken((token) => token + 1);
  };

  return { phase, retry };
}
