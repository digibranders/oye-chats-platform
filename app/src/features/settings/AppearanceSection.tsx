import { type KeyboardEvent, type ReactElement, useRef } from 'react';
import { Check, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { Card, SectionHeader, cn, useTheme, type Theme } from '../../design-system';

interface ThemeOption {
  readonly id: Theme;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: 'light', label: 'Light', description: 'Bright, high-contrast interface.', icon: Sun },
  { id: 'dark', label: 'Dark', description: 'Dimmed surfaces for low-light work.', icon: Moon },
  { id: 'system', label: 'System', description: 'Match your device appearance.', icon: Monitor },
];

/**
 * AppearanceSection - the Settings ▸ Appearance surface. One job: let the
 * user choose Light, Dark, or System. Pure client state via the
 * design-system `useTheme` hook (`ThemeProvider` persists the choice and
 * applies it before first paint) - no network calls.
 *
 * The three options render as an accessible radiogroup: arrow keys rove
 * focus AND select (matching native `<input type="radio">` behaviour), Home
 * / End jump to the first / last option, and only the checked option sits in
 * the tab order (`tabIndex={0}`) so Tab moves past the group in one stop.
 */
export function AppearanceSection(): ReactElement {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const optionRefs = useRef<Partial<Record<Theme, HTMLButtonElement>>>({});

  const selectAndFocus = (id: Theme): void => {
    setTheme(id);
    optionRefs.current[id]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % THEME_OPTIONS.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = THEME_OPTIONS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = THEME_OPTIONS[nextIndex];
    if (next) selectAndFocus(next.id);
  };

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
      <Card className="p-6">
        <div role="radiogroup" aria-labelledby="appearance-heading" className="grid gap-3 sm:grid-cols-3">
          {THEME_OPTIONS.map((option, index) => {
            const Icon = option.icon;
            const active = theme === option.id;
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
                onClick={(e) => setTheme(option.id, e)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className={cn(
                  'group relative flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                  active
                    ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
                    : 'border-[var(--ds-border)] hover:border-[var(--ds-border-strong)] hover:bg-[var(--ds-bg-sunken)]',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                    active
                      ? 'bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]'
                      : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]',
                  )}
                >
                  <Icon size={18} />
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-[var(--ds-text)]">{option.label}</p>
                  <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">{option.description}</p>
                </div>
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute right-3 top-3 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]"
                  >
                    <Check size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Card>
    </section>
  );
}
