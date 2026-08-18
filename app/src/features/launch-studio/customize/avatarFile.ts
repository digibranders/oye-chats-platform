/**
 * Avatar upload rules, the single source of truth for what the picker
 * advertises, what the file input filters, what we refuse, and how big the
 * cropped result is allowed to get.
 *
 * These live apart from the components for two reasons. They are the rules the
 * UI copy has to quote verbatim (a promise the code does not keep is the bug
 * this module exists to close), and they are pure, so they can be tested
 * without a canvas. Jsdom has no canvas implementation.
 */

/** The advertised ceiling for a picked file. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Longest edge of the image we hand to the server, in pixels.
 *
 * 512 is not arbitrary: `r2_service.process_image_for_logo` square-crops and
 * resizes every uploaded logo to 512x512 PNG, so anything larger is decoded,
 * re-encoded and thrown away. Bounding the crop canvas here also keeps its area
 * (262k px) two orders of magnitude below iOS Safari's ~16.7 MP total canvas
 * ceiling, past which `toBlob` silently returns a fully transparent blob.
 */
export const MAX_AVATAR_DIMENSION = 512;

/**
 * The formats we accept.
 *
 * SVG is deliberately absent even though the old copy promised it:
 *   • the cropper rasterises to a canvas, so an SVG never stays vector, the
 *     one thing a user picks SVG for is lost either way;
 *   • the backend re-encodes with Pillow, which cannot open SVG at all, so an
 *     SVG upload has always ended in a 500;
 *   • an SVG with no intrinsic width/height reports naturalWidth === 0, which
 *     the crop maths turned into a 1x1 avatar;
 *   • SVG is an active-content format (script, external references) served back
 *     from our own file host.
 * WebP is present because canvas and Pillow both handle it and it is now a
 * routine output of screenshot and download tooling.
 */
export const ACCEPTED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type AcceptedAvatarType = (typeof ACCEPTED_AVATAR_TYPES)[number];

/** `accept` for the file input. Derived from the list we enforce, so the
 *  browser's filter and our validation can never drift apart. */
export const AVATAR_ACCEPT_ATTRIBUTE = ACCEPTED_AVATAR_TYPES.join(',');

const TYPE_LABELS: Record<AcceptedAvatarType, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
  'image/webp': 'WebP',
};

/** Extensions we trust when the OS reports no MIME type at all (some file
 *  managers and drag sources hand over an empty `type`). */
const EXTENSION_TYPES: Record<string, AcceptedAvatarType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  webp: 'image/webp',
};

function joinWithOr(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** e.g. "PNG, JPG or WebP", for prose, built from the enforced list. */
export const AVATAR_FORMATS_LABEL = joinWithOr(ACCEPTED_AVATAR_TYPES.map((t) => TYPE_LABELS[t]));

/** Render a byte count the way a person would say it. */
export function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 0.1) return `${mb.toFixed(1).replace(/\.0$/, '')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The helper line under the upload button. Quotes the enforced rules. */
export const AVATAR_UPLOAD_HINT = `${AVATAR_FORMATS_LABEL} up to ${formatFileSize(MAX_AVATAR_BYTES)}`;

/** The subset of `File` these rules need. Keeps them testable without a DOM. */
export interface AvatarFileLike {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

function extensionOf(name: string): string {
  const match = /\.([^.]+)$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

function isSvg(file: AvatarFileLike): boolean {
  return file.type.toLowerCase() === 'image/svg+xml' || extensionOf(file.name) === 'svg';
}

/**
 * The accepted type this file really is, or `null` if we will not take it.
 * Falls back to the extension only when the browser reported no type.
 */
export function resolveAvatarType(file: AvatarFileLike): AcceptedAvatarType | null {
  const declared = file.type.split(';', 1)[0].trim().toLowerCase();
  if ((ACCEPTED_AVATAR_TYPES as readonly string[]).includes(declared)) {
    return declared as AcceptedAvatarType;
  }
  if (declared !== '') return null;
  return EXTENSION_TYPES[extensionOf(file.name)] ?? null;
}

/**
 * Validate a picked file BEFORE any of it is read into memory.
 * Returns a message to show the user, or `null` when the file is fine.
 */
export function validateAvatarFile(file: AvatarFileLike): string | null {
  if (resolveAvatarType(file) === null) {
    return isSvg(file)
      ? `SVG isn’t supported for avatars. Export it as a PNG (transparency is preserved) and upload that.`
      : `“${file.name}” isn’t an image we can use. Choose a ${AVATAR_FORMATS_LABEL} file.`;
  }
  if (file.size <= 0) {
    return `“${file.name}” is empty. Choose a different file.`;
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return `That image is ${formatFileSize(file.size)}. The limit is ${formatFileSize(
      MAX_AVATAR_BYTES,
    )}. Try a smaller file.`;
  }
  return null;
}

export const UNUSABLE_IMAGE_MESSAGE =
  'This image doesn’t report a usable size, so it can’t be cropped. Export it as a PNG or JPG and try again.';

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * Fit `width` x `height` inside `bound` on its longest edge, never upscaling.
 * Throws on dimensions an image cannot really have, a zero or NaN natural size
 * used to be clamped to 1px and uploaded as a 1x1 avatar.
 */
export function boundedSize(width: number, height: number, bound = MAX_AVATAR_DIMENSION): PixelSize {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error(UNUSABLE_IMAGE_MESSAGE);
  }
  const scale = Math.min(1, bound / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Quality for a photographic re-encode. Visually lossless at avatar sizes. */
const JPEG_QUALITY = 0.92;
/** Quality for the rescue re-encode when a PNG crop overshoots the limit. */
const JPEG_FALLBACK_QUALITY = 0.82;

export interface AvatarEncoding {
  type: 'image/png' | 'image/jpeg';
  quality?: number;
}

/**
 * Choose the output format.
 *
 * Re-encoding everything as lossless PNG is what turned a 2 MB JPEG into a
 * 10-25 MB upload. JPEG is only safe when nothing in the result can be
 * transparent: not when a circular or lasso mask was applied, and not when the
 * source format could itself carry an alpha channel (PNG, WebP, or an unknown
 * source, the re-crop path passes a stored URL rather than a File).
 */
export function pickAvatarEncoding(sourceType: string | null, preserveAlpha: boolean): AvatarEncoding {
  if (preserveAlpha) return { type: 'image/png' };
  return sourceType === 'image/jpeg' ? { type: 'image/jpeg', quality: JPEG_QUALITY } : { type: 'image/png' };
}

/** The part of `HTMLCanvasElement` this module uses. */
export interface CanvasEncoder {
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Name the cropped output after the encoding it actually got. */
export function avatarFileName(sourceName: string, mimeType: string): string {
  const base = sourceName.replace(/\.[^.]+$/, '') || 'avatar';
  return `${base}-cropped.${EXTENSIONS[mimeType] ?? 'png'}`;
}

function toBlobAsync(canvas: CanvasEncoder, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not crop the image. Please try another file.'));
      },
      type,
      quality,
    );
  });
}

export interface EncodeAvatarOptions {
  /** MIME type of the picked file, or `null` when it isn't known. */
  sourceType: string | null;
  /** True when the result may contain transparency and must stay PNG. */
  preserveAlpha: boolean;
  /** Name of the picked file; the extension is replaced to match the output. */
  fileName: string;
}

/**
 * Encode a cropped canvas into an upload-ready `File`, keeping it inside the
 * advertised limit and reporting (never swallowing) the case where it can't.
 */
export async function encodeAvatarCanvas(
  canvas: CanvasEncoder,
  { sourceType, preserveAlpha, fileName }: EncodeAvatarOptions,
): Promise<File> {
  const primary = pickAvatarEncoding(sourceType, preserveAlpha);
  let blob = await toBlobAsync(canvas, primary.type, primary.quality);

  if (blob.size > MAX_AVATAR_BYTES && primary.type === 'image/png' && !preserveAlpha) {
    blob = await toBlobAsync(canvas, 'image/jpeg', JPEG_FALLBACK_QUALITY);
  }

  if (blob.size > MAX_AVATAR_BYTES) {
    throw new Error(
      `The cropped image is ${formatFileSize(blob.size)}, over the ${formatFileSize(
        MAX_AVATAR_BYTES,
      )} limit. Crop a tighter area or start from a simpler image.`,
    );
  }

  return new File([blob], avatarFileName(fileName, blob.type), { type: blob.type });
}
