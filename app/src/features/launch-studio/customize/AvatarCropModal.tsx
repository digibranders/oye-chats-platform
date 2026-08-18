import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import ReactCrop, {
  centerCrop,
  makeAspectCrop,
  type PercentCrop,
} from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Circle, Lasso, Square, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { Button, Modal, cn } from '../../../design-system';
import { UNUSABLE_IMAGE_MESSAGE, boundedSize, encodeAvatarCanvas } from './avatarFile';

type Shape = 'square' | 'circle' | 'free';

const SHAPES: { key: Shape; label: string; icon: typeof Square }[] = [
  { key: 'square', label: 'Square', icon: Square },
  { key: 'circle', label: 'Circle', icon: Circle },
  { key: 'free', label: 'Custom', icon: Lasso },
];

const ZOOM_MIN = 1;
const ZOOM_MAX = 3;

/** A point as a FRACTION (0..1) of the displayed image, so it's independent of
 *  the current zoom level. */
interface Pt {
  x: number;
  y: number;
}

export interface AvatarCropModalProps {
  /** Data URL of the picked image. */
  src: string;
  /** Original file name (used for the cropped output). */
  fileName: string;
  /**
   * MIME type of the picked file, or `null` when it isn't known, the re-crop
   * entry point reopens an already-stored avatar by URL, not by File. Drives
   * the output encoding: only a known JPEG source is safe to flatten.
   */
  sourceType: string | null;
  onCancel: () => void;
  onConfirm: (file: File) => void;
}

/** A centred starting crop for square/circle. */
function defaultCrop(w: number, h: number): PercentCrop {
  return centerCrop(makeAspectCrop({ unit: '%', width: 80 }, 1, w, h), w, h);
}

/**
 * An image that decoded to nothing (an SVG with no intrinsic size reports
 * naturalWidth === 0, as does a source that silently failed to load) used to
 * sail through the `Math.max(1, …)` clamps and upload a 1x1 avatar.
 */
function assertDecodable(img: HTMLImageElement): void {
  if (img.naturalWidth < 1 || img.naturalHeight < 1) throw new Error(UNUSABLE_IMAGE_MESSAGE);
}

function newCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not available');
  return [canvas, ctx];
}

/**
 * Rect/circle crop. The percentage crop is relative to the displayed image and
 * the displayed size scales with zoom, so the zoom factor cancels and we can
 * work straight in natural pixels.
 *
 * The destination canvas is bounded by `boundedSize`, never by the source's
 * natural size: a 6000x8000 phone photo would otherwise allocate a 48 MP
 * canvas, past iOS Safari's ~16.7 MP ceiling, where `toBlob` hands back a fully
 * transparent blob without throwing.
 */
function toRectFile(
  img: HTMLImageElement,
  crop: PercentCrop,
  circular: boolean,
  fileName: string,
  sourceType: string | null,
): Promise<File> {
  const sx = (crop.x / 100) * img.naturalWidth;
  const sy = (crop.y / 100) * img.naturalHeight;
  const sw = Math.max(1, Math.round((crop.width / 100) * img.naturalWidth));
  const sh = Math.max(1, Math.round((crop.height / 100) * img.naturalHeight));
  const out = boundedSize(sw, sh);
  const [canvas, ctx] = newCanvas(out.width, out.height);
  if (circular) {
    ctx.beginPath();
    ctx.arc(out.width / 2, out.height / 2, Math.min(out.width, out.height) / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return encodeAvatarCanvas(canvas, {
    sourceType,
    preserveAlpha: circular || sourceType !== 'image/jpeg',
    fileName,
  });
}

/** Freehand-lasso crop: clip to the drawn polygon (points are fractions of the
 *  image, so zoom-independent), keep its bounding box, transparent outside.
 *  Always PNG, the mask is the whole point and JPEG has no alpha channel. */
function toLassoFile(img: HTMLImageElement, pts: Pt[], fileName: string, sourceType: string | null): Promise<File> {
  const NW = img.naturalWidth;
  const NH = img.naturalHeight;
  const nat = pts.map((p) => ({ x: p.x * NW, y: p.y * NH }));
  const xs = nat.map((p) => p.x);
  const ys = nat.map((p) => p.y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(NW, Math.ceil(Math.max(...xs)));
  const maxY = Math.min(NH, Math.ceil(Math.max(...ys)));
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const out = boundedSize(w, h);
  const kx = out.width / w;
  const ky = out.height / h;
  const [canvas, ctx] = newCanvas(out.width, out.height);
  ctx.beginPath();
  nat.forEach((p, i) => {
    const x = (p.x - minX) * kx;
    const y = (p.y - minY) * ky;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, minX, minY, w, h, 0, 0, out.width, out.height);
  return encodeAvatarCanvas(canvas, { sourceType, preserveAlpha: true, fileName });
}

/**
 * AvatarCropModal - crop an uploaded avatar before it's uploaded.
 *   • Square / Circle: a locked 1:1 selection (circle bakes a transparent round mask).
 *   • Custom: a freehand lasso - drag to trace ANY shape; outside becomes transparent.
 *   • Zoom slider: enlarges the image inside a scrollable viewport for precise framing.
 */
export function AvatarCropModal({
  src,
  fileName,
  sourceType,
  onCancel,
  onConfirm,
}: AvatarCropModalProps): ReactElement {
  const imgRef = useRef<HTMLImageElement>(null);
  const [shape, setShape] = useState<Shape>('square');
  const [crop, setCrop] = useState<PercentCrop>();
  const [pts, setPts] = useState<Pt[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [zoom, setZoom] = useState(1);
  // The image's fitted size at zoom = 1; explicit sizing is then base * zoom.
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConfirm = shape === 'free' ? pts.length >= 3 : Boolean(crop?.width);

  const localPoint = (e: ReactPointerEvent): Pt | null => {
    const img = imgRef.current;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1),
      y: Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1),
    };
  };

  const confirm = async (): Promise<void> => {
    const img = imgRef.current;
    if (!img) return;
    setBusy(true);
    setError(null);
    try {
      assertDecodable(img);
      const file =
        shape === 'free'
          ? await toLassoFile(img, pts, fileName, sourceType)
          : crop
            ? await toRectFile(img, crop, shape === 'circle', fileName, sourceType)
            : null;
      if (file) onConfirm(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not crop the image.');
    } finally {
      setBusy(false);
    }
  };

  const imgStyle = baseSize
    ? { width: baseSize.w * zoom, height: baseSize.h * zoom, maxWidth: 'none', display: 'block' }
    : { maxHeight: '48vh', maxWidth: '100%', display: 'block' };

  const displaySrc = (
    <img
      ref={imgRef}
      src={src}
      alt="Avatar to crop"
      draggable={false}
      crossOrigin="anonymous"
      onLoad={(e) => {
        if (!baseSize) setBaseSize({ w: e.currentTarget.clientWidth, h: e.currentTarget.clientHeight });
        if (shape !== 'free') setCrop(defaultCrop(e.currentTarget.width, e.currentTarget.height));
      }}
      onError={() => setError('Could not load this image for cropping. Try uploading it again.')}
      style={imgStyle}
    />
  );

  return (
    <Modal
      open
      onClose={onCancel}
      title="Crop your avatar"
      description={
        shape === 'free'
          ? 'Drag to draw any shape around your logo. Use the slider to zoom.'
          : 'Pick a shape, drag the box to frame your logo, and zoom for precision.'
      }
      size="md"
    >
      <div className="space-y-4">
        {/* Shape selector */}
        <div className="flex items-center justify-between gap-2">
          <div
            role="tablist"
            aria-label="Crop shape"
            className="inline-flex rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-0.5"
          >
            {SHAPES.map(({ key, label, icon: Icon }) => {
              const active = shape === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setShape(key);
                    setPts([]);
                  }}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                    active
                      ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)] shadow-[inset_0_0_0_1px_var(--ds-accent)]'
                      : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
                  )}
                >
                  <Icon size={14} aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>
          {shape === 'free' && pts.length > 0 && (
            <button
              type="button"
              onClick={() => setPts([])}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text)]"
            >
              <Undo2 size={13} aria-hidden="true" />
              Redraw
            </button>
          )}
        </div>

        {/* Cropper viewport (scrolls when zoomed in) */}
        <div className="flex max-h-[48vh] max-w-full justify-center overflow-auto rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-2">
          {shape === 'free' ? (
            <div
              className="relative touch-none select-none"
              style={{ cursor: 'crosshair', lineHeight: 0 }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const p = localPoint(e);
                if (p) {
                  setPts([p]);
                  setDrawing(true);
                }
              }}
              onPointerMove={(e) => {
                if (!drawing) return;
                const p = localPoint(e);
                if (!p) return;
                setPts((prev) => {
                  const last = prev[prev.length - 1];
                  if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.005) return prev;
                  return [...prev, p];
                });
              }}
              onPointerUp={() => setDrawing(false)}
              onPointerLeave={() => setDrawing(false)}
            >
              {displaySrc}
              {pts.length > 0 && (
                <svg
                  viewBox="0 0 1 1"
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  aria-hidden="true"
                >
                  <polygon
                    points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="var(--ds-accent)"
                    fillOpacity={0.18}
                    stroke="var(--ds-accent)"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray="5 4"
                  />
                </svg>
              )}
            </div>
          ) : (
            <ReactCrop
              crop={crop}
              onChange={(_, percentCrop) => setCrop(percentCrop)}
              aspect={1}
              circularCrop={shape === 'circle'}
              keepSelection
              minWidth={24}
            >
              {displaySrc}
            </ReactCrop>
          )}
        </div>

        {/* Zoom slider */}
        <div className="flex items-center gap-3">
          <ZoomOut size={15} className="shrink-0 text-[var(--ds-text-muted)]" aria-hidden="true" />
          <input
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={0.02}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label="Zoom"
            className="h-1 flex-1 cursor-pointer accent-[var(--ds-accent)]"
          />
          <ZoomIn size={15} className="shrink-0 text-[var(--ds-text-muted)]" aria-hidden="true" />
        </div>

        {shape === 'free' && pts.length < 3 && (
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            Draw a closed outline around your logo, then click Use image.
          </p>
        )}
        {error && (
          <p role="alert" className="text-[12px] text-[var(--ds-danger)]">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void confirm()} disabled={busy || !canConfirm}>
            {busy ? 'Cropping…' : 'Use image'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
