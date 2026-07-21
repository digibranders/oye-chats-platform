import { useState } from 'react';
import { Loader2, CheckCircle2, RefreshCw } from 'lucide-react';
import { Card, Button } from '../../../design-system';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

type VerifyState = 'idle' | 'checking' | 'detected';

/**
 * Step 9 — Verification. A distinct, explicit step (legacy merged this
 * into deploy and let users finish unverified). Confirms the widget is live
 * before completing onboarding.
 * TODO(phase-2b): poll getBot for widget_installed_at instead of the mock timer.
 */
export function VerifyStep(props: StepProps) {
  const [state, setState] = useState<VerifyState>('idle');

  const check = () => {
    setState('checking');
    // Mock detection. Real impl polls the backend for widget_installed_at.
    window.setTimeout(() => setState('detected'), 1600);
  };

  return (
    <StepShell
      title="Confirm it's live"
      description="We'll check that your agent is installed and answering on your site."
      continueLabel="Go to dashboard"
      canContinue={state === 'detected'}
      {...props}
    >
      <Card className="flex flex-col items-center gap-4 p-8 text-center">
        {state === 'detected' ? (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
              <CheckCircle2 size={24} />
            </div>
            <div>
              <p className="text-[15px] font-semibold text-[var(--ds-text)]">Your agent is live!</p>
              <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">
                It's installed and ready to answer visitors.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
              {state === 'checking' ? <Loader2 size={22} className="animate-spin" /> : <RefreshCw size={22} />}
            </div>
            <div>
              <p className="text-[15px] font-semibold text-[var(--ds-text)]">
                {state === 'checking' ? 'Checking your site…' : 'Ready to verify'}
              </p>
              <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">
                Make sure you've published the page with the snippet, then run the check.
              </p>
            </div>
            <Button onClick={check} disabled={state === 'checking'}>
              {state === 'checking' ? 'Checking…' : 'Check installation'}
            </Button>
          </>
        )}
      </Card>
    </StepShell>
  );
}
