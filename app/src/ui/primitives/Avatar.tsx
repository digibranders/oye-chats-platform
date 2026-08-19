import { useMemo } from 'react';
import * as RadixAvatar from '@radix-ui/react-avatar';
import { cn } from '../lib/cn';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZES: Record<AvatarSize, string> = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-2xs',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
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
    <RadixAvatar.Root
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center overflow-hidden',
        shape === 'circle' ? 'rounded-full' : 'rounded-md',
        SIZES[size],
        className,
      )}
    >
      {src ? (
        // Radix only swaps in the fallback once the image has actually failed or
        // finished loading, so there is no flash of initials behind a good photo.
        <RadixAvatar.Image
          src={src}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : null}
      {/* `aria-hidden`: the name is always rendered or labelled beside the avatar,
          and a screen reader announcing "AR" adds nothing. */}
      <RadixAvatar.Fallback aria-hidden className={cn('flex h-full w-full items-center justify-center font-medium', tint)}>
        {initials}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  );
}
