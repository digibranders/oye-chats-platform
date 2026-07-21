import { useState } from 'react';
import { Bot } from 'lucide-react';
import { Input, Card } from '../../../design-system';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

/**
 * Step 2 — Create Agent. Name the assistant (an explicit step per the master
 * plan). TODO(phase-2b): call createBot({ name }) here and hold the returned
 * bot for the remaining steps.
 */
export function CreateAgentStep(props: StepProps) {
  const [name, setName] = useState('');

  return (
    <StepShell
      title="Create your agent"
      description="Give your AI agent a name. You can change it anytime."
      canContinue={name.trim().length > 0}
      {...props}
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]">
            Agent name
          </span>
          <div className="relative">
            <Bot
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
            />
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Support Assistant"
              className="pl-9"
              autoFocus
            />
          </div>
        </label>

        <Card className="p-4">
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            This is the name visitors see at the top of the chat. Keep it short and friendly —
            “Support”, “Ava”, or your brand name all work well.
          </p>
        </Card>
      </div>
    </StepShell>
  );
}
