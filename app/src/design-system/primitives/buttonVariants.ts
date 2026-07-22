import { cva, type VariantProps } from 'class-variance-authority';

/**
 * The button's class recipe, isolated in its own module so it can be shared
 * without tripping React Fast Refresh's "components-only export" rule. Import
 * it to give a non-`<button>` element (a router `<Link>`, an `<a>`) the exact
 * same visual treatment: `<Link className={buttonVariants({ variant: 'outline' })} />`.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--ds-radius-lg)] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // Accent — the ONLY place violet leads.
        primary:
          'bg-[var(--ds-accent)] text-[var(--ds-accent-fg)] hover:bg-[var(--ds-accent-hover)] shadow-[var(--ds-shadow-sm)] hover:-translate-y-px active:translate-y-0 transition-transform',
        secondary:
          'bg-[var(--ds-bg-sunken)] text-[var(--ds-text)] hover:bg-[var(--ds-border)]',
        outline:
          'border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] text-[var(--ds-text)] hover:bg-[var(--ds-bg-hover)]',
        ghost: 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]',
        danger: 'bg-rose-600 text-white hover:bg-rose-700',
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
