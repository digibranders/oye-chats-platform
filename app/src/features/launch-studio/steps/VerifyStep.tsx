import { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, RefreshCw } from 'lucide-react';
import { Card, Button } from '../../../design-system';
import { getBot, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

type VerifyState = 'idle' | 'checking' | 'detected' | 'not_found';

const POLL_MS = 3000;
const MAX_POLLS = 10; // ~30s

/**
 * Step 9 - Verification. Polls the agent for `widget_installed_at` to confirm the
 * widget is actually live before completing onboarding (a distinct step; legacy
 * merged this into deploy and let users finish unverified).
 */
export function VerifyStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  const [state, setState] = useState<VerifyState>(
    selectedBot?.widget_installed_at ? 'detected' : 'idle',
  );
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const check = () => {
    if (!selectedBot) return;
    setState('checking');
    let polls = 0;

    const poll = async () => {
      polls += 1;
      try {
        const bot = await getBot(selectedBot.id);
        if (bot.widget_installed_at) {
          setState('detected');
          void recordActivationEvent('widget_detected_live', { botId: selectedBot.id });
          return;
        }
      } catch {
        /* transient - keep polling */
      }
      if (polls >= MAX_POLLS) {
        setState('not_found');
        return;
      }
      timer.current = window.setTimeout(poll, POLL_MS);
    };

    void poll();
  };

  const detected = state === 'detected';
  const checking = state === 'checking';

  return (
    <StepShell
      title="Confirm it's live"
      description="We'll check that your agent is installed and answering on your site."
      onBack={props.onBack}
      onContinue={props.onContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
      continueLabel="Go to dashboard"
      canContinue={detected}
    >
      <Card className="flex flex-col items-center gap-4 p-8 text-center">
        {detected ? (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-success-soft)] text-[var(--ds-success)]">
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
              {checking ? <Loader2 size={22} className="animate-spin" /> : <RefreshCw size={22} />}
            </div>
            <div>
              <p className="text-[15px] font-semibold text-[var(--ds-text)]">
                {checking
                  ? 'Checking your site…'
                  : state === 'not_found'
                    ? "We couldn't detect it yet"
                    : 'Ready to verify'}
              </p>
              <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">
                {state === 'not_found'
                  ? 'Make sure the page with the snippet is published and public, then check again.'
                  : "Make sure you've published the page with the snippet, then run the check."}
              </p>
            </div>
            <Button onClick={check} disabled={checking}>
              {checking ? 'Checking…' : state === 'not_found' ? 'Check again' : 'Check installation'}
            </Button>
          </>
        )}
      </Card>
    </StepShell>
  );
}
