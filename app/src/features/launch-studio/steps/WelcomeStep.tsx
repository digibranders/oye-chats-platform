import { GraduationCap, Zap, Palette, type LucideIcon } from 'lucide-react';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

const HIGHLIGHTS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: GraduationCap, title: 'Trained on your content', body: 'It learns from your website in minutes.' },
  { icon: Zap, title: 'Live in a few steps', body: 'A guided path from zero to deployed.' },
  { icon: Palette, title: 'Yours to shape', body: 'Name it, style it, and put it live.' },
];

/**
 * Step 1 - Welcome. A calm intro that sets expectations before any input.
 * (New vs. legacy, which dropped users straight into a URL field.)
 */
export function WelcomeStep(props: StepProps) {
  return (
    <StepShell
      title="Let's launch your AI chatbot"
      description="In a few guided steps you'll create an AI Chatbot trained on your content and put it live on your site."
      continueLabel="Get started"
      {...props}
    >
      <ul className="space-y-3">
        {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
          <li
            key={title}
            className="flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-4"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
              <Icon size={17} />
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-[var(--ds-text)]">{title}</p>
              <p className="text-[12px] text-[var(--ds-text-subtle)]">{body}</p>
            </div>
          </li>
        ))}
      </ul>
    </StepShell>
  );
}
