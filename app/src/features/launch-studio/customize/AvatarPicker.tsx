import { useState } from 'react';
import { Bot, Check, ImagePlus, Loader2, Sparkles, Trash2, Upload } from 'lucide-react';
import { StatusBadge, cn } from '../../../design-system';
import PremiumOrb from '../../../components/PremiumOrb';
import { ColorField } from './ColorField';
import { AvatarCropModal } from './AvatarCropModal';

export type AvatarType = 'upload' | 'orb' | 'mascot';

export interface AvatarPreviewProps {
  avatarType: AvatarType;
  botLogo: string | null;
  orbColor: string;
  primaryColor: string;
  size?: number;
}

/** AvatarPreview - renders the chosen avatar as a circle (reused in the step preview). */
export function AvatarPreview({
  avatarType,
  botLogo,
  orbColor,
  primaryColor,
  size = 44,
}: AvatarPreviewProps) {
  const dimension = { width: size, height: size };

  if (avatarType === 'upload' && botLogo) {
    return (
      <img
        src={botLogo}
        alt="Agent avatar"
        className="rounded-full border border-[var(--ds-border)] object-cover"
        style={dimension}
      />
    );
  }
  if (avatarType === 'orb') {
    // The real product orb - the same WebGL renderer the embeddable widget uses
    // (falls back to a CSS gradient where WebGL is unavailable).
    return <PremiumOrb color={orbColor || primaryColor} size={size} />;
  }
  // mascot, or upload with no logo yet
  return (
    <div
      className="flex items-center justify-center rounded-full text-white"
      style={{ ...dimension, backgroundColor: primaryColor }}
    >
      <Bot size={Math.round(size * 0.5)} />
    </div>
  );
}

export interface AvatarPickerProps {
  avatarType: AvatarType;
  orbColor: string;
  botLogo: string | null;
  primaryColor: string;
  uploading: boolean;
  swatches: string[];
  onChangeType: (type: AvatarType) => void;
  onChangeOrbColor: (hex: string) => void;
  onUpload: (file: File) => void;
  onRemoveLogo: () => void;
  /** True when the previewed avatar is the one currently live on the widget. */
  avatarIsLive?: boolean;
}

const TYPES: { key: AvatarType; label: string; icon: typeof Bot }[] = [
  { key: 'upload', label: 'Photo', icon: ImagePlus },
  { key: 'orb', label: 'Orb', icon: Sparkles },
  { key: 'mascot', label: 'Mascot', icon: Bot },
];

/** AvatarPicker - choose the widget avatar (photo / orb / mascot) and its data. */
export function AvatarPicker({
  avatarType,
  orbColor,
  botLogo,
  primaryColor,
  uploading,
  swatches,
  onChangeType,
  onChangeOrbColor,
  onUpload,
  onRemoveLogo,
  avatarIsLive = false,
}: AvatarPickerProps) {
  // Holds the picked image (as a data URL) while the crop modal is open. On
  // confirm we upload the CROPPED file instead of the raw upload.
  const [cropState, setCropState] = useState<{ src: string; name: string } | null>(null);
  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-stretch">
      {/* Left column — options */}
      <div className="min-w-0 flex-1 space-y-4">
        {/* Type segmented control */}
        <div
          role="tablist"
          aria-label="Avatar style"
          className="inline-flex rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-0.5"
        >
          {TYPES.map(({ key, label, icon: Icon }) => {
            const active = avatarType === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onChangeType(key)}
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
                {active && (
                  <Check
                    size={14}
                    strokeWidth={3}
                    className="ml-0.5 text-[var(--ds-accent)]"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Per-type controls (preview lives in the right column) */}
        {avatarType === 'upload' && (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-1.5 text-[13px] font-medium text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)]">
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {botLogo ? 'Replace' : 'Upload image'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    // Open the cropper first; the raw file is only uploaded once
                    // the visitor confirms a crop.
                    const reader = new FileReader();
                    reader.onload = () => setCropState({ src: String(reader.result), name: file.name });
                    reader.readAsDataURL(file);
                  }}
                />
              </label>
              {botLogo && (
                <button
                  type="button"
                  onClick={onRemoveLogo}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-danger)]"
                >
                  <Trash2 size={14} />
                  Remove
                </button>
              )}
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--ds-text-subtle)]">PNG, JPG or SVG up to 2MB</p>
          </div>
        )}

        {avatarType === 'orb' && (
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-[13px] text-[var(--ds-text)]">
              <input
                type="checkbox"
                checked={orbColor === ''}
                onChange={(event) => onChangeOrbColor(event.target.checked ? '' : primaryColor)}
              />
              Use brand colour
            </label>
            {orbColor !== '' && (
              <ColorField
                label="Orb colour"
                value={orbColor}
                onChange={onChangeOrbColor}
                swatches={swatches}
              />
            )}
          </div>
        )}

        {avatarType === 'mascot' && (
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            A friendly robot mascot on your brand colour.
          </p>
        )}
      </div>

      {/* Right column — live preview. When a photo is set, clicking it reopens
          the cropper so the framing can be adjusted without re-uploading. The
          green tick marks that this preview is the avatar currently live on the
          widget (hidden once there are unsaved avatar changes). */}
      <div className="relative flex shrink-0 items-center justify-center rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-6 sm:w-44">
        {avatarIsLive && (
          <StatusBadge
            tone="success"
            dot
            size="sm"
            className="absolute right-2 top-2"
            title="This avatar is live on your chatbot"
          >
            Live
          </StatusBadge>
        )}
        {avatarType === 'upload' && botLogo ? (
          <button
            type="button"
            onClick={() => setCropState({ src: botLogo, name: 'avatar' })}
            title="Click to re-crop"
            aria-label="Re-crop avatar"
            className="group relative rounded-full focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ds-ring)]"
          >
            <AvatarPreview
              avatarType="upload"
              botLogo={botLogo}
              orbColor={orbColor}
              primaryColor={primaryColor}
              size={96}
            />
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-[11px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
              Re-crop
            </span>
          </button>
        ) : (
          <AvatarPreview
            avatarType={avatarType}
            botLogo={botLogo}
            orbColor={orbColor}
            primaryColor={primaryColor}
            size={96}
          />
        )}
      </div>

      {cropState && (
        <AvatarCropModal
          src={cropState.src}
          fileName={cropState.name}
          onCancel={() => setCropState(null)}
          onConfirm={(file) => {
            setCropState(null);
            onUpload(file);
          }}
        />
      )}
    </div>
  );
}
