import { type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Button } from '../../design-system';

export interface StepShellProps {
  title: string;
  description?: string;
  children: ReactNode;
  onBack: () => void;
  onContinue: () => void;
  isFirst: boolean;
  isLast: boolean;
  /** Override the primary button label (defaults to "Continue" / "Finish"). */
  continueLabel?: string;
  /** Gate the primary action (e.g. until a URL is entered). Defaults to true. */
  canContinue?: boolean;
}

/**
 * StepShell — shared chrome for every Launch Studio step: a step header, the
 * step body, and the Back / Continue footer. Keeps all eight steps visually
 * identical and their navigation wiring in one place.
 */
export function StepShell({
  title,
  description,
  children,
  onBack,
  onContinue,
  isFirst,
  isLast,
  continueLabel,
  canContinue = true,
}: StepShellProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">{title}</h1>
        {description && <p className="mt-2 text-[15px] text-[var(--ds-text-muted)]">{description}</p>}
      </header>

      <div className="flex-1">{children}</div>

      <footer className="mt-8 flex items-center justify-between border-t border-[var(--ds-border)] pt-5">
        <Button variant="ghost" onClick={onBack} disabled={isFirst}>
          <ArrowLeft size={16} />
          Back
        </Button>
        <Button onClick={onContinue} disabled={!canContinue}>
          {continueLabel ?? (isLast ? 'Finish setup' : 'Continue')}
          {isLast ? <Check size={16} /> : <ArrowRight size={16} />}
        </Button>
      </footer>
    </div>
  );
}
