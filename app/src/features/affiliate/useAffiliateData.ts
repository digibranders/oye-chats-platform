import { useQueries, useQueryClient } from '@tanstack/react-query';
import { getAffiliateCodes, getAffiliateMe, getAffiliateStats } from '../../services/api';
import { keys } from '../../query/keys';
import {
  toAffiliateCodes,
  toAffiliateProfile,
  toAffiliateStats,
  type AffiliateCodeView,
  type AffiliateProfile,
  type AffiliateStatsView,
} from './affiliateModel';

/**
 * The affiliate dashboard's three reads, issued together.
 *
 * A 403 from the profile call is not an error: the affiliate programme is
 * invite-only, so it is the answer "you are not in it". Rendering that as a red
 * failure banner told enrolled-looking users their dashboard was broken when
 * nothing was wrong.
 */

export interface AffiliateData {
  loading: boolean;
  /** The signed-in client is not an enrolled affiliate. */
  notEnrolled: boolean;
  error: string | null;
  profile: AffiliateProfile | null;
  codes: AffiliateCodeView[];
  stats: AffiliateStatsView | null;
  reload: () => void;
}

function statusOf(error: unknown): number | undefined {
  const withResponse = error as { response?: { status?: number }; status?: number } | null;
  return withResponse?.response?.status ?? withResponse?.status;
}

export function useAffiliateData(): AffiliateData {
  const queryClient = useQueryClient();

  const [profile, codes, stats] = useQueries({
    queries: [
      { queryKey: keys.affiliate.me(), queryFn: getAffiliateMe, retry: false, staleTime: 60_000 },
      { queryKey: keys.affiliate.codes(), queryFn: getAffiliateCodes, retry: false, staleTime: 30_000 },
      { queryKey: keys.affiliate.stats(), queryFn: getAffiliateStats, retry: false, staleTime: 60_000 },
    ],
  });

  const firstError = profile.error ?? codes.error ?? stats.error ?? null;
  const notEnrolled = statusOf(profile.error) === 403;

  return {
    loading: profile.isPending || codes.isPending || stats.isPending,
    notEnrolled,
    error:
      firstError && !notEnrolled
        ? firstError instanceof Error
          ? firstError.message
          : 'We could not load your affiliate dashboard.'
        : null,
    profile: notEnrolled ? null : toAffiliateProfile(profile.data),
    codes: notEnrolled ? [] : toAffiliateCodes(codes.data),
    stats: notEnrolled ? null : toAffiliateStats(stats.data),
    reload: () => {
      void queryClient.invalidateQueries({ queryKey: ['affiliate'] });
    },
  };
}
