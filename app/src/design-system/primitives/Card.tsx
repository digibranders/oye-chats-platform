import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

type DivProps = HTMLAttributes<HTMLDivElement>;

export const Card = forwardRef<HTMLDivElement, DivProps>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-sm)]',
      className,
    )}
    {...props}
  />
));
Card.displayName = 'Card';

export const CardHeader = forwardRef<HTMLDivElement, DivProps>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex flex-col gap-1 p-5', className)} {...props} />
));
CardHeader.displayName = 'CardHeader';

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn('text-[15px] font-semibold text-[var(--ds-text)]', className)}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

export const CardContent = forwardRef<HTMLDivElement, DivProps>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('p-5 pt-0', className)} {...props} />
));
CardContent.displayName = 'CardContent';

export const CardFooter = forwardRef<HTMLDivElement, DivProps>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex items-center gap-2 border-t border-[var(--ds-border)] p-5', className)}
    {...props}
  />
));
CardFooter.displayName = 'CardFooter';
