import { cn } from '../lib/cn';

export interface SkeletonProps {
  className?: string;
}

/**
 * A loading placeholder shaped like the thing it is standing in for.
 *
 * `.console-skeleton` rather than Tailwind's `animate-pulse`, because the global
 * reduced-motion rule only shortens an animation's duration: a pulse compressed
 * to 0.01ms freezes at whatever opacity that frame landed on, which is often a
 * block of half-visible grey that reads as a rendering fault. The token layer
 * removes the animation outright for those users and leaves the block solid.
 *
 * Always `aria-hidden`: the container announces its own busy state, and a screen
 * reader walking a dozen nameless boxes learns nothing.
 */
export function Skeleton({ className }: SkeletonProps) {
  return <span aria-hidden className={cn('console-skeleton block rounded-xs', className)} />;
}

/** A block of text lines, with the last one short so it reads as a paragraph. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn('h-3', index === lines - 1 && lines > 1 ? 'w-2/5' : 'w-full')}
        />
      ))}
    </span>
  );
}
