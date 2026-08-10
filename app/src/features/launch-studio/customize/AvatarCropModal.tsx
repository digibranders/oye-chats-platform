import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import ReactCrop, {
  centerCrop,
  makeAspectCrop,
  type PercentCrop,
} from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Circle, Lasso, Square, Undo2 } from 'lucide-react';
import { Button, Modal, cn } from '../../../design-system';

type Shape = 'square' | 'circle' | 'free';

const SHAPES: { key: Shape; label: string; icon: typeof Square }[] = [
  { key: 'square', label: 'Square', icon: Square },
  { key: 'circle', label: 'Circle', icon: Circle },
  { key: 'free', label: 'Custom', icon: Lasso },
];

interface Pt {
  x: number;
  y: number;
}

export interface AvatarCropModalProps {
  /** Data URL of the picked image. */
  src: string;
  /** Original file name (used for the cropped output). */
  fileName: string;
  onCancel: () => void;
  onConfirm: (file: File) => void;
}

function outName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '') || 'avatar';
  return `${base}-cropped.png`;
}

/** A centred starting crop for square/circle. */
function defaultCrop(w: number, h: number): PercentCrop {
  return centerCrop(makeAspectCrop({ unit: '%', width: 80 }, 1, w, h), w, h);
}

/** Rect/circle crop of the displayed image to a PNG File. */
function toRectFile(img: HTMLImageElement, crop: PercentCrop, circular: boolean, fileName: string): Promise<File> {
  const scaleX = img.naturalWidth / img.width;
  const scaleY = img.naturalHeight / img.height;
  const sx = (crop.x / 100) * img.width * scaleX;
  const sy = (crop.y / 100) * img.height * scaleY;
  const sw = Math.max(1, Math.round((crop.width / 100) * img.width * scaleX));
  const sh = Math.max(1, Math.round((crop.height / 100) * img.height * scaleY));
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas not available'));
  if (circular) {
    ctx.beginPath();
    ctx.arc(sw / 2, sh / 2, Math.min(sw, sh) / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvasToFile(canvas, fileName);
}

/** Freehand-lasso crop: clip to the drawn polygon, keep its bounding box, make
 *  everything outside the outline transparent. */
function toLassoFile(img: HTMLImageElement, pts: Pt[], fileName: string): Promise<File> {
  const scaleX = img.naturalWidth / img.clientWidth;
  const scaleY = img.naturalHeight / img.clientHeight;
  const nat = pts.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));
  const xs = nat.map((p) => p.x);
  const ys = nat.map((p) => p.y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(img.naturalWidth, Math.ceil(Math.max(...xs)));
  const maxY = Math.min(img.naturalHeight, Math.ceil(Math.max(...ys)));
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas not available'));
  ctx.beginPath();
  nat.forEach((p, i) => {
    const x = p.x - minX;
    const y = p.y - minY;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, minX, minY, w, h, 0, 0, w, h);
  return canvasToFile(canvas, fileName);
}

function canvasToFile(canvas: HTMLCanvasElement, fileName: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Could not crop the image. Please try another file.'));
          return;
        }
        resolve(new File([blob], outName(fileName), { type: 'image/png' }));
      },
      'image/png',
    );
  });
}

/**
 * AvatarCropModal - crop an uploaded avatar before it's uploaded.
 *   • Square / Circle: a locked 1:1 selection (circle bakes a transparent round mask).
 *   • Custom: a freehand lasso - drag to trace ANY shape around the logo; everything
 *     outside the outline becomes transparent.
 */
export function AvatarCropModal({ src, fileName, onCancel, onConfirm }: AvatarCropModalProps): ReactElement {
  const imgRef = useRef<HTMLImageElement>(null);
  const [shape, setShape] = useState<Shape>('square');
  const [crop, setCrop] = useState<PercentCrop>();
  const [pts, setPts] = useState<Pt[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConfirm = shape === 'free' ? pts.length >= 3 : Boolean(crop?.width);

  const localPoint = (e: ReactPointerEvent): Pt | null => {
    const img = imgRef.current;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
      y: Math.min(Math.max(e.clientY - r.top, 0), r.height),
    };
  };

  const confirm = async (): Promise<void> => {
    const img = imgRef.current;
    if (!img) return;
    setBusy(true);
    setError(null);
    try {
      const file =
        shape === 'free'
          ? await toLassoFile(img, pts, fileName)
          : crop
            ? await toRectFile(img, crop, shape === 'circle', fileName)
            : null;
      if (file) onConfirm(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not crop the image.');
    } finally {
      setBusy(false);
    }
  };

  const displaySrc = (
    <img
      ref={imgRef}
      src={src}
      alt="Avatar to crop"
      draggable={false}
      // Anonymous CORS so re-cropping an already-hosted avatar (not just a fresh
      // data URL) keeps the canvas untainted for export. Ignored for data: URLs.
      crossOrigin="anonymous"
      onLoad={(e) => {
        if (shape !== 'free') setCrop(defaultCrop(e.currentTarget.width, e.currentTarget.height));
      }}
      onError={() => setError('Could not load this image for cropping. Try uploading it again.')}
      style={{ maxHeight: '55vh', maxWidth: '100%', display: 'block' }}
    />
  );

  return (
    <Modal
      open
      onClose={onCancel}
      title="Crop your avatar"
      description={
        shape === 'free'
          ? 'Drag to draw any shape around your logo.'
          : 'Pick a shape, then drag the box to frame your logo.'
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
                    if (key !== 'free' && imgRef.current) {
                      setCrop(defaultCrop(imgRef.current.width, imgRef.current.height));
                    }
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

        {/* Cropper */}
        <div className="flex justify-center rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-2">
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
                  if (last && Math.hypot(p.x - last.x, p.y - last.y) < 3) return prev;
                  return [...prev, p];
                });
              }}
              onPointerUp={() => setDrawing(false)}
              onPointerLeave={() => setDrawing(false)}
            >
              {displaySrc}
              {pts.length > 0 && (
                <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
                  <polygon
                    points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="var(--ds-accent)"
                    fillOpacity={0.18}
                    stroke="var(--ds-accent)"
                    strokeWidth={2}
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
