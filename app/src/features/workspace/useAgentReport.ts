import { useCallback } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { getPerAgentReport, type PerAgentReport } from '../../services/api';
import type { ReportRange } from './reportsModel';

export interface AgentReportResult {
  query: UseQueryResult<PerAgentReport>;
  retry: () => void;
}

/**
 * The per-agent rollup for one trailing window.
 *
 * Deliberately NOT scoped to the shell's agent switcher: the point of the
 * surface is every chatbot side by side, one row each, so an agency can pull
 * the numbers for all of its clients in one pass.
 *
 * The window is part of the key rather than a refetch of the same query, so the
 * previous window's rows can never sit under the new window's label - the page
 * would be quoting 30-day numbers while claiming they cover 7 days.
 */
export function useAgentReport(days: ReportRange): AgentReportResult {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['analytics', 'per-agent-report', days] as const,
    queryFn: () => getPerAgentReport(days),
    staleTime: 60_000,
  });
  const retry = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['analytics', 'per-agent-report'] });
  }, [client]);
  return { query, retry };
}
