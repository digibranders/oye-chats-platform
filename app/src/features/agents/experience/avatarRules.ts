
import { t as translateNow } from '../../../i18n/i18n';/**
 * What the avatar picker accepts, and why.
 *
 * Kept apart from the component because these are the rules the copy quotes
 * verbatim — a promise the code does not keep is the failure this module exists
 * to prevent — and because they are pure, so they can be tested without a
 * canvas that jsdom does not have.
 */

/** The advertised ceiling for a picked file. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * The formats the server can actually re-encode.
 *
 * SVG is deliberately absent even though older copy promised it: the backend
 * re-encodes every uploaded logo with Pillow (`r2_service.process_image_for_logo`),
 * which cannot open SVG at all, so an SVG upload has only ever ended in a 500 —
 * and SVG is an active-content format served back from our own file host.
 */
export const ACCEPTED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type AcceptedAvatarType = (typeof ACCEPTED_AVATAR_TYPES)[number];

/** `accept` for the file input, derived from the list actually enforced so the
 *  browser's own filter and this module can never drift apart. */
export const AVATAR_ACCEPT: readonly string[] = ['.png', '.jpg', '.jpeg', '.webp'];

const EXTENSION_TYPES: Record<string, AcceptedAvatarType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * The type of a picked file.
 *
 * Some file managers and drag sources hand over an empty `type`, so the
 * extension is the fallback rather than an immediate rejection.
 */
export function avatarTypeOf(file: File): AcceptedAvatarType | null {
  if ((ACCEPTED_AVATAR_TYPES as readonly string[]).includes(file.type)) {
    return file.type as AcceptedAvatarType;
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[extension] ?? null;
}

/** The reason a file cannot be used, or `null` when it can. */
export function validateAvatarFile(file: File): string | null {
  if (avatarTypeOf(file) === null) {
    return translateNow('agents.useAPngJpgOr') || 'Use a PNG, JPG or WebP image.';
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 2 MB.`;
  }
  return null;
}

/**
 * What happens to the image after upload, stated so the result is not a
 * surprise. `r2_service.process_image_for_logo` centre-crops to a square and
 * resizes to 512×512 PNG, and the widget then renders it inside a circle.
 */
/**
 * What the drop zone cannot work out for itself.
 *
 * `FileDrop` already prints the accepted extensions and the size ceiling from
 * `accept` and `maxSizeBytes`, so the formats and "up to 2 MB" were being stated
 * twice, one line apart, in two different registers. What is left is the only
 * part that is ours to say: what happens to the image after it is uploaded.
 */
export const AVATAR_HINT =
  'Square images work best — we crop to the centre square and resize to 512×512.';
