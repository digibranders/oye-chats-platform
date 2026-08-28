import { useMemo } from 'react';
import { Avatar as BaseAvatar } from '@base-ui/react/avatar';
import { cn } from '../lib/cn';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * Initials are set on a rung that keeps roughly the same proportion of the box,
 * and never smaller than the scale's floor. The earlier map claimed "one rung
 * below the box" but the ratio halved across the set — 55% at `xs` down to 32%
 * at `lg` — so a 40px avatar was a tiny pair of letters floating in a large
 * tint. These are 55 / 46 / 41 / 35, and every one is a real rung.
 */
const SIZES: Record<AvatarSize, string> = {
  xs: 'h-5 w-5 text-2xs',
  sm: 'h-6 w-6 text-2xs',
  md: 'h-8 w-8 text-sm',
  lg: 'h-10 w-10 text-base',
};

/**
 * The `rounded` shape, scaled with the box.
 *
 * One radius for a 20px square and a 40px square is two different shapes: 8px on
 * 20 is 40% of the side — a squircle — and 8px on 40 is barely rounded. The same
 * prop has to produce the same *shape*, which means the radius moves with the
 * size.
 */
const SHAPE: Record<AvatarSize, string> = {
  xs: 'rounded-xs',
  sm: 'rounded-xs',
  md: 'rounded-sm',
  lg: 'rounded-md',
};

/**
 * Initials from a display name.
 *
 * Filters empty segments before taking first letters, because `'Ana  Ruiz'`
 * split on a space yields an empty string whose `[0]` is `undefined` — the bug
 * the previous avatar shipped, which rendered `A` instead of `AR`.
 */
function initialsFrom(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

/**
 * A deterministic tint per name.
 *
 * Same person, same colour, every session and every device — so a roster becomes
 * scannable by shape as well as by reading. Drawn from the chart ramp because
 * those hues are already contrast-checked against the console's grounds.
 */
const TINTS = [
  'bg-accent-100 text-accent-700',
  'bg-success-tint text-success',
  'bg-warning-tint text-warning',
  'bg-danger-tint text-danger',
  'bg-plan-tint text-plan',
  'bg-neutral-tint text-neutral',
] as const;

function tintFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return TINTS[Math.abs(hash) % TINTS.length];
}

export interface AvatarProps {
  name: string;
  src?: string | null;
  size?: AvatarSize;
  /** `full` for people, `md` for agents and workspaces — objects, not faces. */
  shape?: 'circle' | 'rounded';
  className?: string;
}

export function Avatar({ name, src, size = 'md', shape = 'circle', className }: AvatarProps) {
  const initials = useMemo(() => initialsFrom(name), [name]);
  const tint = useMemo(() => tintFor(name), [name]);

  return (
    <BaseAvatar.Root
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center overflow-hidden',
        shape === 'circle' ? 'rounded-full' : SHAPE[size],
        SIZES[size],
        className,
      )}
    >
      {src ? (
        // Base UI only swaps in the fallback once the image has actually failed
        // or finished loading, so there is no flash of initials behind a good photo.
        <BaseAvatar.Image
          src={src}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : null}
      {/* `aria-hidden`: the name is always rendered or labelled beside the avatar,
          and a screen reader announcing "AR" adds nothing. */}
      <BaseAvatar.Fallback aria-hidden className={cn('flex h-full w-full items-center justify-center font-medium', tint)}>
        {initials}
      </BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}
