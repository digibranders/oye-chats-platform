import { type ReactElement } from 'react';
import { SectionHeader } from '../../../design-system';
import { ColorField } from '../../launch-studio/customize/ColorField';
import { AvatarPicker } from '../../launch-studio/customize/AvatarPicker';
import { type ExperienceDraft } from './types';

export interface BrandingSectionProps {
  draft: ExperienceDraft;
  onChange: (patch: Partial<ExperienceDraft>) => void;
  /** Quick-pick colours (website-extracted recommendations + presets). */
  swatches: string[];
  /** True while an avatar upload is in flight. */
  uploading: boolean;
  /** Non-null when the last upload failed. */
  uploadError: string | null;
  onUpload: (file: File) => void;
}

/**
 * BrandingSection — the widget's visual identity: brand + user-message colours
 * and the avatar (photo / orb / mascot). Presentational; all state lives in the
 * parent draft so the live preview stays in lockstep.
 */
export function BrandingSection({
  draft,
  onChange,
  swatches,
  uploading,
  uploadError,
  onUpload,
}: BrandingSectionProps): ReactElement {
  return (
    <div className="space-y-8">
      <section className="space-y-5">
        <SectionHeader
          title="Colours"
          description="Match the widget to your brand. These drive the launcher, avatar and message bubbles."
        />
        <div className="grid gap-6 sm:grid-cols-2">
          <ColorField
            label="Brand colour"
            value={draft.primaryColor}
            onChange={(c) => onChange({ primaryColor: c })}
            swatches={swatches}
          />
          <ColorField
            label="Visitor message colour"
            value={draft.userBubbleColor}
            onChange={(c) => onChange({ userBubbleColor: c })}
            swatches={swatches}
          />
        </div>
      </section>

      <section className="space-y-4 border-t border-[var(--ds-border)] pt-6">
        <SectionHeader
          title="Avatar"
          description="The face of your agent — a photo, a glowing orb, or a friendly mascot."
        />
        <AvatarPicker
          avatarType={draft.avatarType}
          orbColor={draft.orbColor}
          botLogo={draft.botLogo}
          primaryColor={draft.primaryColor}
          uploading={uploading}
          swatches={swatches}
          onChangeType={(t) => onChange({ avatarType: t })}
          onChangeOrbColor={(c) => onChange({ orbColor: c })}
          onUpload={onUpload}
          onRemoveLogo={() => onChange({ botLogo: null })}
        />
        {uploadError && (
          <p role="alert" className="text-[12px] text-[var(--ds-danger)]">
            {uploadError}
          </p>
        )}
      </section>
    </div>
  );
}
