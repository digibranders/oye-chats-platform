import { type KeyboardEvent, type ReactElement, useRef } from 'react';
import { Check, Circle, Contrast, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import {
  Card,
  SectionHeader,
  cn,
  useTheme,
  type Contrast as ContrastLevel,
  type Theme,
} from '../../design-system';

interface Option<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

const THEME_OPTIONS: readonly Option<Theme>[] = [
  { id: 'light', label: 'Light', description: 'Bright, paper-white surfaces.', icon: Sun },
  { id: 'dark', label: 'Dark', description: 'Dimmed surfaces for low-light work.', icon: Moon },
  { id: 'system', label: 'System', description: 'Match your device appearance.', icon: Monitor },
];

const CONTRAST_OPTIONS: readonly Option<ContrastLevel>[] = [
  { id: 'default', label: 'Default', description: 'Standard color and depth.', icon: Circle },
  { id: 'high', label: 'High contrast', description: 'Stronger text and borders (WCAG AAA).', icon: Contrast },
];

/**
 * A single labelled radiogroup, one row per option. Arrow keys rove focus AND
 * select (native `<input type="radio">` behaviour), Home / End jump to the
 * first / last option, and only the checked option is in the tab order so Tab
 * steps past the group in one stop. Generic over the option id so the Theme
 * and Contrast axes share one accessible implementation.
 */
function OptionGroup<T extends string>({
  legend,
  legendId,
  options,
  value,
  onSelect,
}: {
  legend: string;
  legendId: string;
  options: readonly Option<T>[];
  value: T;
  onSelect: (id: T, event?: React.MouseEvent) => void;
}): ReactElement {
  const optionRefs = useRef<Partial<Record<T, HTMLButtonElement>>>({});

  const selectAndFocus = (id: T): void => {
    onSelect(id);
    optionRefs.current[id]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % options.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + options.length) % options.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = options.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = options[nextIndex];
    if (next) selectAndFocus(next.id);
  };

  return (
    <div className="space-y-2">
      <p id={legendId} className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
        {legend}
      </p>
      <div role="radiogroup" aria-labelledby={legendId} className="grid gap-2">
        {options.map((option, index) => {
          const Icon = option.icon;
          const active = value === option.id;
          return (
            <button
              key={option.id}
              ref={(node) => {
                if (node) optionRefs.current[option.id] = node;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={(e) => onSelect(option.id, e)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cn(
                'group relative flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                active
                  ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
                  : 'border-[var(--ds-border)] hover:border-[var(--ds-border-strong)] hover:bg-[var(--ds-bg-sunken)]',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                  active
                    ? 'bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]'
                    : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]',
                )}
              >
                <Icon size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-[var(--ds-text)]">{option.label}</p>
                <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">{option.description}</p>
              </div>
              {active && (
                <span
                  aria-hidden="true"
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]"
                >
                  <Check size={11} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * AppearanceSection - the Settings > Appearance surface. Two independent axes,
 * GitHub-style: Theme (light / dark / system) on the left, Contrast (default /
 * high) on the right. Pure client state via the design-system `useTheme` hook
 * (`ThemeProvider` persists both choices and applies them before first paint) -
 * no network calls.
 */
export function AppearanceSection(): ReactElement {
  const { theme, resolvedTheme, setTheme, contrast, setContrast } = useTheme();

  return (
    <section aria-labelledby="appearance-heading" className="space-y-4">
      <SectionHeader
        title={<span id="appearance-heading">Appearance</span>}
        description={
          theme === 'system'
            ? `Match your device appearance - currently ${resolvedTheme}.`
            : 'Choose how OyeChats looks on this device.'
        }
      />
      <Card className="p-4">
        <div className="grid gap-5 lg:grid-cols-2">
          <OptionGroup<Theme>
            legend="Theme"
            legendId="appearance-theme-label"
            options={THEME_OPTIONS}
            value={theme}
            onSelect={(id, event) => setTheme(id, event)}
          />
          <OptionGroup<ContrastLevel>
            legend="Contrast"
            legendId="appearance-contrast-label"
            options={CONTRAST_OPTIONS}
            value={contrast}
            onSelect={(id) => setContrast(id)}
          />
        </div>
      </Card>
    </section>
  );
}
