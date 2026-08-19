import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getCurrentUser,
  getDepartments,
  getOperators,
  listOperatorInvites,
} from '../../services/api';
import { keys } from '../../query/keys';
import type { Department, Operator, OperatorInvite } from '../../types/domain';
import { unwrapList } from './teamModel';

/**
 * Everything the team page reads, in one place.
 *
 * The roster, the departments and the invitations are three independent
 * requests that all have to land before the page can say anything useful, so
 * they go out together rather than in a waterfall. Invitations are allowed to
 * fail on their own: `GET /invites` is owner/admin-only, and an admin operator
 * who can see the roster but not the invitations should get the roster rather
 * than an error page.
 */

export interface TeamData {
  operators: Operator[];
  departments: Department[];
  invites: OperatorInvite[];
  /** True when the roster loaded but the invitations list was refused. */
  invitesForbidden: boolean;
  clientId: number | null;
  loading: boolean;
  error: Error | null;
  /** True when the failure was a 403 — a permissions answer, not a broken one. */
  forbidden: boolean;
  refetch: () => void;
}

function statusOf(error: unknown): number | undefined {
  const withResponse = error as { response?: { status?: number }; status?: number } | null;
  return withResponse?.response?.status ?? withResponse?.status;
}

export function useTeamData(enabled: boolean): TeamData {
  const queryClient = useQueryClient();

  const [operators, departments, invites] = useQueries({
    queries: [
      {
        queryKey: keys.team.operators(),
        queryFn: getOperators,
        enabled,
        staleTime: 30_000,
      },
      {
        queryKey: keys.team.departments(),
        queryFn: getDepartments,
        enabled,
        staleTime: 60_000,
      },
      {
        queryKey: keys.team.invites(),
        queryFn: () => listOperatorInvites('pending'),
        enabled,
        staleTime: 30_000,
        retry: false,
      },
    ],
  });

  const me = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    staleTime: 5 * 60_000,
  });

  // The roster is the page. An invitations failure is reported beside the
  // invitations, not instead of the team.
  const fatal = operators.error ?? departments.error ?? null;

  return {
    operators: unwrapList<Operator>(operators.data, 'operators'),
    departments: unwrapList<Department>(departments.data, 'departments'),
    invites: unwrapList<OperatorInvite>(invites.data, 'invites'),
    invitesForbidden: invites.isError,
    clientId: me.data?.id ?? null,
    loading: enabled && (operators.isPending || departments.isPending),
    error: fatal instanceof Error ? fatal : fatal ? new Error(String(fatal)) : null,
    forbidden: statusOf(fatal) === 403,
    refetch: () => {
      void queryClient.invalidateQueries({ queryKey: ['team'] });
    },
  };
}

/** Invalidate everything the team page renders. Called after every mutation. */
export function useInvalidateTeam(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['team'] });
  };
}
