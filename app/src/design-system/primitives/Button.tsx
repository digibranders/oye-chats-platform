import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

const button = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-bg-canvas)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // Accent — the ONLY place violet leads.
        primary: 'bg-[var(--ds-accent)] text-[var(--ds-accent-fg)] hover:bg-[var(--ds-accent-hover)] shadow-[var(--ds-shadow-sm)]',
        secondary:
          'bg-[var(--ds-bg-sunken)] text-[var(--ds-text)] hover:bg-[var(--ds-border)]',
        outline:
          'border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] text-[var(--ds-text)] hover:bg-[var(--ds-bg-hover)]',
        ghost: 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]',
        danger: 'bg-rose-500 text-white hover:bg-rose-600',
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

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(button({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
