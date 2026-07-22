import { cva, type VariantProps } from 'class-variance-authority';

/**
 * The button's class recipe, isolated in its own module so it can be shared
 * without tripping React Fast Refresh's "components-only export" rule. Import
 * it to give a non-`<button>` element (a router `<Link>`, an `<a>`) the exact
 * same visual treatment: `<Link className={buttonVariants({ variant: 'outline' })} />`.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--ds-radius-lg)] font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // Accent — the ONLY place violet leads. The 1px hairline ring is
        // imperceptible here (ring color == fill), so the filled primary
        // bumps to a 2px ring that extends visibly onto the page.
        primary:
          'bg-[var(--ds-accent)] text-[var(--ds-accent-fg)] hover:bg-[var(--ds-accent-hover)] shadow-[var(--ds-shadow-sm)] hover:-translate-y-px active:translate-y-0 transition-transform duration-[var(--ds-dur-fast)] ease-[var(--ds-ease-standard)] focus-visible:shadow-[0_0_0_2px_var(--ds-ring)]',
        secondary:
          'bg-[var(--ds-bg-sunken)] text-[var(--ds-text)] hover:bg-[var(--ds-border)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
        outline:
          'border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] text-[var(--ds-text)] hover:bg-[var(--ds-bg-hover)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
        ghost:
          'text-[var(--ds-text-muted)] hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
        danger: 'bg-rose-600 text-white hover:bg-rose-700 focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-9 px-4 text-sm',
        lg: 'h-11 px-5 text-[15px]',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;
