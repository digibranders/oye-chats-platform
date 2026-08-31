import { useCallback, useState } from 'react';
import Cropper from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import { Button } from '../primitives/Button';
import { Alert } from '../feedback/Alert';
import { Dialog } from './Dialog';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Crop-before-upload dialog.
 *
 * The old avatar flow uploaded the raw file and let the server centre-crop it,
 * so a customer whose subject was off-centre had no say in what the widget
 * showed — the one control they wanted (which square) was the one the product
 * made for them. This puts that choice back: pan, zoom, confirm, and only the
 * cropped square is handed up.
 *
 * It owns the crop UI, not the upload. `onCropped` receives a `Blob`; the caller
 * turns it into a `File` and sends it, keeping this primitive free of any API,
 * auth, or field knowledge. Built on {@link Dialog} so the focus trap, scroll
 * lock, and Escape/outside-press handling are the shared ones, and locked shut
 * (`dismissible={!busy}`) while the caller's upload is in flight.
 */

/** react-easy-crop's `Point`/`Area` live on a subpath the package does not
 *  re-export from its entry; these mirror them structurally so no deep import
 *  is needed and the handlers still type-check. */
interface Point {
  x: number;
  y: number;
}
interface PixelArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageCropDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Object URL or data URL of the picked image. Null renders an empty stage. */
  src: string | null;
  /** Receives the cropped region as a Blob. Awaited, so the caller can upload
   *  and keep the dialog open (and `busy`) until it resolves or throws. */
  onCropped: (blob: Blob) => void | Promise<void>;
  /** Crop aspect ratio (width / height). Defaults to 1 — a square. */
  aspect?: number;
  /** Round crop overlay, for avatars the widget renders in a circle. Default true. */
  round?: boolean;
  /** MIME type of the produced Blob. Defaults to `image/png`. */
  outputType?: string;
  /**
   * Cap the longest side of the produced image, in pixels. Downscales only,
   * never upscales, so a small source stays sharp. Left unset the crop keeps
   * its native resolution — pass it (e.g. 512 for avatars) to keep the upload
   * small when the server is going to resize anyway.
   */
  outputSize?: number;
  /** True while the caller uploads: disables the controls and blocks dismissal. */
  busy?: boolean;
  title?: string;
  confirmLabel?: string;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.01;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', () => reject(new Error('The image could not be read.')));
    image.src = src;
  });
}

/** Draw the chosen region onto a canvas at its native resolution and read it
 *  back as a Blob. Canvas-only, so it never runs under jsdom — the crop maths
 *  is exercised in the browser, not the unit suite. */
async function cropToBlob(
  src: string,
  area: PixelArea,
  outputType: string,
  outputSize?: number,
): Promise<Blob> {
  const image = await loadImage(src);
  const longest = Math.max(area.width, area.height);
  const scale = outputSize ? Math.min(1, outputSize / longest) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(area.width * scale));
  canvas.height = Math.max(1, Math.round(area.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot render the cropped image.');
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The cropped image could not be produced.'))),
      outputType,
    );
  });
}

export function ImageCropDialog({
  open,
  onOpenChange,
  src,
  onCropped,
  aspect = 1,
  round = true,
  outputType = 'image/png',
  outputSize,
  busy = false,
  title,
  confirmLabel,
}: ImageCropDialogProps) {
  const { t } = useTranslation();
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [area, setArea] = useState<PixelArea | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A fresh image is a fresh crop: reset the pan, zoom and last-known area when
  // the source changes, so the previous picture's frame never carries over.
  // Adjusting state during render (not in an effect) is the React-recommended
  // way to derive from a changed prop — object URLs are unique per pick, so this
  // fires exactly once per new image and re-renders before painting.
  const [lastSrc, setLastSrc] = useState<string | null>(src);
  if (src !== lastSrc) {
    setLastSrc(src);
    setCrop({ x: 0, y: 0 });
    setZoom(MIN_ZOOM);
    setArea(null);
    setError(null);
  }

  const handleConfirm = useCallback(async () => {
    if (!src || !area) return;
    setError(null);
    try {
      const blob = await cropToBlob(src, area, outputType, outputSize);
      await onCropped(blob);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The image could not be cropped.');
    }
  }, [src, area, outputType, outputSize, onCropped]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? t('ds.cropImage') ?? 'Crop image'}
      description={t('ds.dragToRepositionZoomToFrame') ?? 'Drag to reposition, and use the slider to zoom.'}
      size="md"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('ds.cancel') ?? 'Cancel'}
          </Button>
          <Button variant="primary" onClick={() => void handleConfirm()} loading={busy} disabled={!area}>
            {confirmLabel ?? t('ds.cropAndUse') ?? 'Crop & use'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="relative h-72 w-full overflow-hidden rounded-lg bg-surface-sunken">
          {src ? (
            <Cropper
              image={src}
              crop={crop}
              zoom={zoom}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              aspect={aspect}
              cropShape={round ? 'round' : 'rect'}
              showGrid={!round}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_area, pixels) => setArea(pixels)}
            />
          ) : null}
        </div>

        <label className="flex items-center gap-3">
          <span className="shrink-0 text-xs font-medium text-text-secondary">{t('ds.zoom') ?? 'Zoom'}</span>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={ZOOM_STEP}
            value={zoom}
            disabled={busy || !src}
            aria-label={t('ds.zoom') ?? 'Zoom'}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="h-1.5 flex-1 cursor-pointer"
            style={{ accentColor: 'var(--color-accent-600)' }}
          />
        </label>

        {error ? (
          <Alert tone="danger" title={t('ds.thatImageCouldNotBeCropped') ?? 'That image could not be cropped'} live>
            {error}
          </Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
