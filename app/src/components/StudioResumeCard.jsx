import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Sparkles, ArrowRight, X } from 'lucide-react';
import { getCurrentUser } from '../services/api';
import { Button } from './ui/Button';

const HIDDEN_KEY = 'oc_studio_resume_hidden';

/**
 * The Build Studio setup nudge on the Dashboard.
 *
 * A customer who clicks "Skip to dashboard" mid-onboarding lands here. This
 * slim, dismissible banner
 * nudges them back into /build and self-hides the moment onboarding is complete
 * (server-derived from /auth/me — it can never drift from the truth) or when the
 * user dismisses it. Affiliate-only accounts never see it.
 */
export default function StudioResumeCard() {
  const navigate = useNavigate();
  // null = unknown (loading / fetch error) — never render on an unknown state.
  const [onboardingComplete, setOnboardingComplete] = useState(null);
  const [affiliateOnly, setAffiliateOnly] = useState(false);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((me) => {
        if (cancelled) return;
        setOnboardingComplete(Boolean(me?.onboarding_complete));
        setAffiliateOnly(Boolean(me?.is_affiliate_only));
      })
      .catch(() => {
        // Leave `onboardingComplete` null so the card stays hidden on error —
        // we never nudge a user whose real state we couldn't confirm.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(HIDDEN_KEY, 'true');
    } catch {
      /* localStorage unavailable — the card just reappears next load */
    }
  };

  if (hidden || affiliateOnly || onboardingComplete !== false) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } }}
      className="relative flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss setup reminder"
        className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--text-secondary)] sm:static sm:order-last"
      >
        <X size={15} />
      </button>

      <div className="flex items-center gap-3 pr-8 sm:pr-0">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white"
          style={{ background: 'linear-gradient(135deg, #6366f1, #d946ef)' }}
          aria-hidden="true"
        >
          <Sparkles size={18} />
        </span>
        <div>
          <p className="text-sm font-semibold text-[var(--text)]">Finish setting up your agent</p>
          <p className="text-sm text-[var(--text-muted)]">
            Pick up the guided setup where you left off — train it, test it, and put it live.
          </p>
        </div>
      </div>

      <Button size="sm" className="self-start sm:self-auto" onClick={() => navigate('/build')}>
        Resume setup
        <ArrowRight size={15} />
      </Button>
    </motion.div>
  );
}
