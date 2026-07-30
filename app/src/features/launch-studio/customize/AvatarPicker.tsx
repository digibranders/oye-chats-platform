import { Bot, ImagePlus, Loader2, Sparkles, Trash2, Upload } from 'lucide-react';
import { cn } from '../../../design-system';
import PremiumOrb from '../../../components/PremiumOrb';
import { ColorField } from './ColorField';

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
}: AvatarPickerProps) {
  return (
    <div className="space-y-4">
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
                active
                  ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                  : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
              )}
            >
              <Icon size={14} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Per-type controls */}
      {avatarType === 'upload' && (
        <div className="flex items-center gap-4">
          <AvatarPreview
            avatarType="upload"
            botLogo={botLogo}
            orbColor={orbColor}
            primaryColor={primaryColor}
            size={56}
          />
          <div>
            <div className="flex items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-1.5 text-[13px] font-medium text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)]">
                {uploading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Upload size={14} />
                )}
                {botLogo ? 'Replace' : 'Upload image'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) onUpload(file);
                    event.target.value = '';
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
        </div>
      )}

      {avatarType === 'orb' && (
        <div className="flex items-start gap-4">
          <AvatarPreview
            avatarType="orb"
            botLogo={null}
            orbColor={orbColor}
            primaryColor={primaryColor}
            size={56}
          />
          <div className="min-w-0 flex-1 space-y-3">
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
        </div>
      )}

      {avatarType === 'mascot' && (
        <div className="flex items-center gap-4">
          <AvatarPreview
            avatarType="mascot"
            botLogo={null}
            orbColor={orbColor}
            primaryColor={primaryColor}
            size={56}
          />
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            A friendly robot mascot on your brand colour.
          </p>
        </div>
      )}
    </div>
  );
}
