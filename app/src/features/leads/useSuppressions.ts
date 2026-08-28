import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { createEmailSuppression, getEmailSuppressions } from '../../services/api';
import { keys } from '../../query/keys';
import type { EmailSuppression, EmailSuppressionsResult } from '../../services/api';

/** Rows per page. The API's own ceiling is 200. */
export const SUPPRESSIONS_PAGE_SIZE = 25;

export interface SuppressionsRequest {
  /** `null` for every chatbot in the workspace. */
  botId: number | null;
  page: number;
  search: string;
  /** Skip the request entirely while the drawer is shut. */
  enabled: boolean;
}

export interface SuppressionsData {
  rows: EmailSuppression[];
  total: number;
  loading: boolean;
  /** A page or search change is in flight while the previous rows stay up. */
  fetching: boolean;
  error: Error | null;
  /**
   * The caller may not read this list — a 403 from `_resolve_client_bot_ids`,
   * which is an answer rather than a fault and needs different words from "we
   * could not load it".
   */
  forbidden: boolean;
  retry: () => void;
  add: (input: { botId: number; email: string }) => Promise<EmailSuppression>;
  adding: boolean;
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

/**
 * The email suppression list — every address that opted out of follow-ups.
 *
 * Read-and-append, never delete, because that is the whole shape of the API:
 * `GET /leads/suppressions` and `POST /leads/suppressions` exist and there is
 * deliberately no `DELETE`. The model's own rule is that a row is never removed
 * by application code — under India's DPDP Act the lawful basis for emailing a
 * visitor is consent, and consent that has been withdrawn is not something an
 * admin console gets to restore. So this hook exposes no removal, and the UI
 * over it has to say why rather than leave the reader hunting for a button.
 */
export function useSuppressions(request: SuppressionsRequest): SuppressionsData {
  const queryClient = useQueryClient();
  const { botId, page, search, enabled } = request;

  const query = useQuery<EmailSuppressionsResult>({
    queryKey: keys.leads.suppressions({ botId, page, search, limit: SUPPRESSIONS_PAGE_SIZE }),
    queryFn: () =>
      getEmailSuppressions({
        botId,
        page,
        limit: SUPPRESSIONS_PAGE_SIZE,
        search: search.trim() || null,
      }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    // A 403 is a settled answer. Retrying it only delays the explanation.
    retry: (failureCount, error) => statusOf(error) !== 403 && failureCount < 2,
  });

  const create = useMutation({
    mutationFn: (input: { botId: number; email: string }) =>
      createEmailSuppression({ botId: input.botId, email: input.email }),
    // Every page and every search of this list moved, and the server is the only
    // thing that knows whether the address was already there.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leads', 'suppressions'] }),
  });

  const error = (query.error as Error | null) ?? null;
  const forbidden = statusOf(error) === 403;

  return {
    rows: query.data?.suppressions ?? [],
    total: query.data?.total ?? 0,
    loading: enabled && query.isPending,
    fetching: query.isFetching && !query.isPending,
    error: forbidden ? null : error,
    forbidden,
    retry: () => void query.refetch(),
    add: (input) => create.mutateAsync(input),
    adding: create.isPending,
  };
}
