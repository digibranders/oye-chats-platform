import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, X } from 'lucide-react';
import { ProgressStepper, Progress, cn, type StepperItem } from '../../design-system';
import { WidgetPreview } from './preview/WidgetPreview';

export interface LaunchStudioLayoutProps {
  steps: StepperItem[];
  currentIndex: number;
  maxReachedIndex: number;
  onStepClick: (index: number) => void;
  children: ReactNode;
  /**
   * When true, the right-side live-preview panel is hidden and the content
   * area expands to fill the full width. Set for plan-selection step which is
   * information-heavy and has nothing to preview yet.
   */
  hidePreview?: boolean;
}

/**
 * LaunchStudioLayout - the full-screen onboarding shell. Deliberately renders
 * OUTSIDE the app chrome (no sidebar / top bar): Launch Studio is a temporary
 * workflow, not a destination. Three regions: the step rail (left), the active
 * step (center), and a persistent live-preview panel (right) - the preview is
 * where the user watches their agent come to life.
 */
export function LaunchStudioLayout({
  steps,
  currentIndex,
  maxReachedIndex,
  onStepClick,
  children,
  hidePreview = false,
}: LaunchStudioLayoutProps) {
  return (
    <div className="flex h-screen flex-col bg-[var(--ds-bg-canvas)] text-[var(--ds-text)]">
      {/* Top bar - brand + exit */}
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

      {/* Mobile progress - the step rail is hidden below lg, so keep the user
          oriented with a compact "Step N of M" bar. */}
      <div className="border-b border-[var(--ds-border)] px-4 py-3 lg:hidden">
        <div className="mb-1.5 flex items-center justify-between text-[12px]">
          <span className="font-medium text-[var(--ds-text)]">{steps[currentIndex]?.label}</span>
          <span className="text-[var(--ds-text-subtle)]">
            Step {currentIndex + 1} of {steps.length}
          </span>
        </div>
        <Progress
          value={((currentIndex + 1) / steps.length) * 100}
          label={`Step ${currentIndex + 1} of ${steps.length}`}
        />
      </div>

      <div className={hidePreview
        ? 'grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]'
        : 'grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_440px]'
      }>
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
          <div className={cn("mx-auto h-full", hidePreview ? "max-w-6xl" : "max-w-xl")}>{children}</div>
        </main>

        {/* Live widget preview — hidden on plan step */}
        {!hidePreview && (
          <aside className="hidden shrink-0 flex-col border-l border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-5 lg:flex">
            <p className="mb-4 px-1 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
              Live preview
            </p>
            <div className="flex-1">
              <WidgetPreview />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
