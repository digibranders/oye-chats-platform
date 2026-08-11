import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AvatarPicker, type AvatarPickerProps } from './AvatarPicker';
import {
  AVATAR_ACCEPT_ATTRIBUTE,
  AVATAR_UPLOAD_HINT,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_DIMENSION,
  UNUSABLE_IMAGE_MESSAGE,
  boundedSize,
  encodeAvatarCanvas,
  pickAvatarEncoding,
  resolveAvatarType,
  validateAvatarFile,
  type CanvasEncoder,
} from './avatarFile';

/**
 * The avatar picker used to advertise a format list and a size limit and
 * enforce neither: `accept="image/*"` is a filter hint, drag-and-drop ignores
 * it, and nothing looked at `file.size` at all. The three failures that caused
 * are pinned here, because each one fails SILENTLY in production:
 *
 *  1. A 48 MP phone photo allocated a 48 MP canvas. iOS Safari caps total
 *     canvas area at ~16.7 MP and, past that, `toBlob` hands back a fully
 *     TRANSPARENT blob without throwing — an invisible avatar, reported as a
 *     successful upload.
 *  2. Every crop was re-encoded as lossless PNG, so a 2 MB JPEG came back out
 *     at 10-25 MB — "file too large" for a file the UI had just called fine.
 *  3. `image/*` admits SVG; an SVG with no intrinsic size reports
 *     naturalWidth === 0, which the `Math.max(1, …)` guards turned into a
 *     silently uploaded 1x1 PNG.
 *
 * jsdom has no canvas implementation, so the sizing and encoding rules are
 * tested through the pure functions they were extracted into, with a stub
 * encoder standing in for HTMLCanvasElement.
 */

/** iOS Safari's total canvas area ceiling. Past it, `toBlob` returns transparent. */
const IOS_CANVAS_AREA_CAP = 16_777_216;

function fileLike(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/** A stand-in for HTMLCanvasElement that reports a chosen size per MIME type. */
function stubCanvas(sizeByType: Record<string, number>): CanvasEncoder & {
  calls: { type?: string; quality?: number }[];
} {
  const calls: { type?: string; quality?: number }[] = [];
  return {
    calls,
    toBlob(callback, type, quality) {
      calls.push({ type, quality });
      const blob = new Blob(['x'], { type: type ?? 'image/png' });
      Object.defineProperty(blob, 'size', { value: sizeByType[type ?? 'image/png'] ?? 1024 });
      callback(blob);
    },
  };
}

describe('validateAvatarFile', () => {
  it('accepts the formats the UI promises', () => {
    expect(validateAvatarFile(fileLike('logo.png', 'image/png', 50_000))).toBeNull();
    expect(validateAvatarFile(fileLike('photo.jpg', 'image/jpeg', 50_000))).toBeNull();
    expect(validateAvatarFile(fileLike('shot.webp', 'image/webp', 50_000))).toBeNull();
  });

  it('rejects a file that is not an image at all', () => {
    // `accept="image/*"` never stopped this — drag-and-drop bypasses accept.
    const message = validateAvatarFile(fileLike('contract.pdf', 'application/pdf', 50_000));
    expect(message).toBeTruthy();
    expect(message).toMatch(/PNG, JPG or WebP/);
  });

  it('rejects SVG with an instruction, not a generic error', () => {
    /* SVG is rasterised by the cropper and re-encoded by the backend (Pillow,
       which cannot open SVG at all), so it never worked end to end. The message
       has to tell the user what to do instead. */
    const message = validateAvatarFile(fileLike('logo.svg', 'image/svg+xml', 4_000));
    expect(message).toMatch(/SVG/i);
    expect(message).toMatch(/PNG/);
  });

  it('rejects a file over the advertised limit, naming both sizes', () => {
    const message = validateAvatarFile(fileLike('huge.jpg', 'image/jpeg', 8 * 1024 * 1024));
    expect(message).toMatch(/8 MB/);
    expect(message).toMatch(/2 MB/);
  });

  it('accepts a file exactly on the limit', () => {
    expect(validateAvatarFile(fileLike('edge.png', 'image/png', MAX_AVATAR_BYTES))).toBeNull();
  });

  it('rejects an empty file rather than uploading zero bytes', () => {
    expect(validateAvatarFile(fileLike('empty.png', 'image/png', 0))).toMatch(/empty/i);
  });

  it('falls back to the extension when the OS reports no MIME type', () => {
    expect(validateAvatarFile(fileLike('logo.PNG', '', 50_000))).toBeNull();
    expect(resolveAvatarType(fileLike('logo.PNG', '', 50_000))).toBe('image/png');
    expect(resolveAvatarType(fileLike('notes.txt', '', 50_000))).toBeNull();
  });
});

describe('boundedSize', () => {
  it('keeps a 48 MP phone photo inside the iOS canvas ceiling', () => {
    const { width, height } = boundedSize(6000, 8000);

    expect(Math.max(width, height)).toBe(MAX_AVATAR_DIMENSION);
    expect(width * height).toBeLessThan(IOS_CANVAS_AREA_CAP);
    // Aspect ratio survives the downscale.
    expect(width / height).toBeCloseTo(6000 / 8000, 3);
  });

  it('never upscales an image that is already small', () => {
    expect(boundedSize(120, 90)).toEqual({ width: 120, height: 90 });
  });

  it('refuses a dimensionless image instead of producing a 1x1 avatar', () => {
    // naturalWidth === 0 is what an SVG with no intrinsic size reports, and it
    // also covers a re-crop of a source that failed to decode.
    expect(() => boundedSize(0, 0)).toThrow(UNUSABLE_IMAGE_MESSAGE);
    expect(() => boundedSize(1024, 0)).toThrow(UNUSABLE_IMAGE_MESSAGE);
    expect(() => boundedSize(Number.NaN, 512)).toThrow(UNUSABLE_IMAGE_MESSAGE);
  });
});

describe('pickAvatarEncoding', () => {
  it('re-encodes a rectangular JPEG crop as JPEG, not as an inflated PNG', () => {
    const encoding = pickAvatarEncoding('image/jpeg', false);

    expect(encoding.type).toBe('image/jpeg');
    expect(encoding.quality).toBeGreaterThan(0.8);
  });

  it('keeps PNG whenever the result can carry transparency', () => {
    // A circular or lasso crop bakes a transparent mask; JPEG would black it out.
    expect(pickAvatarEncoding('image/jpeg', true).type).toBe('image/png');
    // A PNG or WebP source may already have an alpha channel.
    expect(pickAvatarEncoding('image/png', false).type).toBe('image/png');
    expect(pickAvatarEncoding('image/webp', false).type).toBe('image/png');
    // Unknown source (the re-crop path passes a stored URL, not a File).
    expect(pickAvatarEncoding(null, false).type).toBe('image/png');
  });
});

describe('encodeAvatarCanvas', () => {
  it('names the output after the encoding actually used', async () => {
    const canvas = stubCanvas({ 'image/jpeg': 90_000 });

    const file = await encodeAvatarCanvas(canvas, {
      sourceType: 'image/jpeg',
      preserveAlpha: false,
      fileName: 'holiday.jpeg',
    });

    expect(file.type).toBe('image/jpeg');
    expect(file.name).toBe('holiday-cropped.jpg');
  });

  it('falls back to JPEG when a PNG crop would blow the limit', async () => {
    const canvas = stubCanvas({
      'image/png': 12 * 1024 * 1024,
      'image/jpeg': 400_000,
    });

    const file = await encodeAvatarCanvas(canvas, {
      sourceType: 'image/png',
      preserveAlpha: false,
      fileName: 'screenshot.png',
    });

    expect(canvas.calls.map((c) => c.type)).toEqual(['image/png', 'image/jpeg']);
    expect(file.type).toBe('image/jpeg');
  });

  it('reports a too-large result instead of letting the server reject it', async () => {
    // Transparency is required here, so flattening to JPEG is not an option.
    const canvas = stubCanvas({ 'image/png': 12 * 1024 * 1024 });

    await expect(
      encodeAvatarCanvas(canvas, {
        sourceType: 'image/png',
        preserveAlpha: true,
        fileName: 'logo.png',
      }),
    ).rejects.toThrow(/12 MB[\s\S]*2 MB/);
    expect(canvas.calls).toHaveLength(1);
  });

  it('reports a null blob rather than resolving with nothing', async () => {
    const canvas: CanvasEncoder = { toBlob: (callback) => callback(null) };

    await expect(
      encodeAvatarCanvas(canvas, {
        sourceType: 'image/png',
        preserveAlpha: false,
        fileName: 'logo.png',
      }),
    ).rejects.toThrow(/could not/i);
  });
});

function renderPicker(overrides: Partial<AvatarPickerProps> = {}) {
  const onUpload = vi.fn();
  const utils = render(
    <AvatarPicker
      avatarType="upload"
      orbColor=""
      botLogo={null}
      primaryColor="#4f46e5"
      uploading={false}
      swatches={[]}
      onChangeType={vi.fn()}
      onChangeOrbColor={vi.fn()}
      onUpload={onUpload}
      onRemoveLogo={vi.fn()}
      {...overrides}
    />,
  );
  const input = utils.container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not rendered');
  return { ...utils, input, onUpload };
}

describe('AvatarPicker file selection', () => {
  it('offers the browser only the formats it will actually accept', () => {
    const { input } = renderPicker();

    expect(input.getAttribute('accept')).toBe(AVATAR_ACCEPT_ATTRIBUTE);
    // `image/*` is what let SVGs and 48 MP HEIC-converted photos through.
    expect(input.getAttribute('accept')).not.toBe('image/*');
  });

  it('states the same limit it enforces', () => {
    const { getByText } = renderPicker();

    expect(getByText(AVATAR_UPLOAD_HINT)).toBeInTheDocument();
    expect(AVATAR_UPLOAD_HINT).toMatch(/2 MB/);
    expect(AVATAR_UPLOAD_HINT).not.toMatch(/SVG/i);
  });

  it('shows an error and opens no cropper when the file is rejected', () => {
    const { input, getByRole, queryByText } = renderPicker();

    fireEvent.change(input, { target: { files: [fileLike('huge.jpg', 'image/jpeg', 9_000_000)] } });

    expect(getByRole('alert')).toHaveTextContent(/2 MB/);
    expect(queryByText('Crop your avatar')).not.toBeInTheDocument();
  });

  it('clears a previous error once an acceptable file is chosen', () => {
    const { input, queryByRole } = renderPicker();

    fireEvent.change(input, { target: { files: [fileLike('doc.pdf', 'application/pdf', 1_000)] } });
    expect(queryByRole('alert')).not.toBeNull();

    fireEvent.change(input, { target: { files: [fileLike('logo.png', 'image/png', 1_000)] } });
    expect(queryByRole('alert')).toBeNull();
  });
});
