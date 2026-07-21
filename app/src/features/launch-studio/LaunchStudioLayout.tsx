import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, X, MessageSquare } from 'lucide-react';
import { ProgressStepper, type StepperItem } from '../../design-system';

export interface LaunchStudioLayoutProps {
  steps: StepperItem[];
  currentIndex: number;
  maxReachedIndex: number;
  onStepClick: (index: number) => void;
  children: ReactNode;
}

/**
 * LaunchStudioLayout — the full-screen onboarding shell. Deliberately renders
 * OUTSIDE the app chrome (no sidebar / top bar): Launch Studio is a temporary
 * workflow, not a destination. Three regions: the step rail (left), the active
 * step (center), and a persistent live-preview panel (right) — the preview is
 * where the user watches their agent come to life.
 */
export function LaunchStudioLayout({
  steps,
  currentIndex,
  maxReachedIndex,
  onStepClick,
  children,
}: LaunchStudioLayoutProps) {
  return (
    <div className="flex h-screen flex-col bg-[var(--ds-bg-canvas)] text-[var(--ds-text)]">
      {/* Top bar — brand + exit */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--ds-border)] px-4 md:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]">
            <Sparkles size={17} />
          </div>
          <span className="text-[15px] font-bold tracking-tight">Launch Studio</span>
        </div>
        <Link
          to="/"
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]"
        >
          <X size={15} />
          Exit setup
        </Link>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_360px]">
        {/* Step rail */}
        <aside className="hidden shrink-0 overflow-y-auto border-r border-[var(--ds-border)] bg-[var(--ds-sidebar-bg)] p-5 lg:block">
          <p className="mb-4 px-2 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
            Get your agent live
          </p>
          <ProgressStepper
            steps={steps}
            currentIndex={currentIndex}
            maxReachedIndex={maxReachedIndex}
            onStepClick={onStepClick}
          />
        </aside>

        {/* Active step */}
        <main className="overflow-y-auto px-5 py-8 md:px-10 md:py-10">
          <div className="mx-auto h-full max-w-xl">{children}</div>
        </main>

        {/* Live preview */}
        <aside className="hidden shrink-0 flex-col border-l border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-5 lg:flex">
          <p className="mb-4 px-1 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
            Live preview
          </p>
          <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--ds-border)] p-6 text-center">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--ds-bg-surface)] text-[var(--ds-text-subtle)]">
              <MessageSquare size={20} />
            </div>
            <p className="text-[13px] font-medium text-[var(--ds-text)]">Your agent, live</p>
            <p className="mt-1 text-[12px] text-[var(--ds-text-subtle)]">
              The preview appears here once training begins.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
