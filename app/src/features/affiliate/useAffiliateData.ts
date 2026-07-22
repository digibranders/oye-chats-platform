/**
 * useAffiliateData — loads the affiliate self-service dashboard state.
 *
 * Fetches the profile, codes, and stats in parallel (one round-trip of latency,
 * not three) and coerces them into strict view-models. A 403 from the profile
 * endpoint means the signed-in client is not an enrolled affiliate — surfaced as
 * `notEnrolled` so the page can render an explanatory empty state instead of an
 * error. Exposes `reload` so mutations (create/edit/deactivate a code) can
 * refresh without a full remount.
 */
import { useCallback, useEffect, useState } from 'react';
import { getAffiliateCodes, getAffiliateMe, getAffiliateStats } from '../../services/api';
import {
  type AffiliateCodeView,
  type AffiliateProfile,
  type AffiliateStatsView,
  toAffiliateCodes,
  toAffiliateProfile,
  toAffiliateStats,
} from './affiliateModel';

export interface AffiliateData {
  loading: boolean;
  /** True when the client isn't an enrolled affiliate (profile 403). */
  notEnrolled: boolean;
  /** A non-403 load failure, if any. */
  error: string | null;
  profile: AffiliateProfile | null;
  codes: AffiliateCodeView[];
  stats: AffiliateStatsView | null;
  reload: () => void;
}

function errStatus(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useAffiliateData(): AffiliateData {
  const [loading, setLoading] = useState(true);
  const [notEnrolled, setNotEnrolled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<AffiliateProfile | null>(null);
  const [codes, setCodes] = useState<AffiliateCodeView[]>([]);
  const [stats, setStats] = useState<AffiliateStatsView | null>(null);
  const [nonce, setNonce] = useState(0);

  // Reset the request state here (an event callback), not in the effect body —
  // synchronous setState inside an effect triggers cascading renders (and the
  // react-hooks lint rule). The effect below only sets state after an await.
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setNotEnrolled(false);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    Promise.all([getAffiliateMe(), getAffiliateCodes(), getAffiliateStats()])
      .then(([meRaw, codesRaw, statsRaw]) => {
        if (cancelled) return;
        setProfile(toAffiliateProfile(meRaw));
        setCodes(toAffiliateCodes(codesRaw));
        setStats(toAffiliateStats(statsRaw));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 403 on the profile endpoint = this client isn't an affiliate. Treat as
        // a first-class "not enrolled" state, not an error banner.
        if (errStatus(err) === 403) {
          setNotEnrolled(true);
          setProfile(null);
          setCodes([]);
          setStats(null);
        } else {
          setError(errMessage(err, 'Could not load your affiliate dashboard.'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { loading, notEnrolled, error, profile, codes, stats, reload };
}
