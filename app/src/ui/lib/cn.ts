import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Compose class names, with later Tailwind utilities beating earlier ones.
 *
 * `clsx` handles the conditional/array/object forms; `twMerge` resolves the
 * conflicts `clsx` cannot see — without it a caller's `px-4` loses to a
 * component's own `px-3` purely because of source order, which makes every
 * `className` prop in the system unreliable.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
