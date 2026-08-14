import { type ReactElement, useId } from 'react';
import { Lock } from 'lucide-react';
import { Button, Card, Input, SectionHeader } from '../../../design-system';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { useUpgradeModal } from '../../../context/UpgradeModalContext';
import { ColorField } from '../../launch-studio/customize/ColorField';
import { AvatarPicker } from '../../launch-studio/customize/AvatarPicker';
import { Toggle } from '../advanced/controls';
import { experienceDraftErrors, type ExperienceDraft } from './types';

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
  /** True when the previewed avatar matches what's currently live in production. */
  avatarIsLive: boolean;
}

/**
 * BrandingSection - the widget's visual identity: brand + user-message colours
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
  avatarIsLive,
}: BrandingSectionProps): ReactElement {
  const { hasFeature } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();
  const canRemoveBranding = hasFeature('branding_removable');

  const brandingTextId = useId();
  const brandingTextHintId = useId();
  const brandingUrlId = useId();
  const brandingUrlHintId = useId();
  const brandingUrlErrorId = useId();

  const showWhiteLabelFields = canRemoveBranding && draft.showBranding;
  const brandingUrlError = experienceDraftErrors(draft, showWhiteLabelFields).brandingUrl;

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
          description="The face of your chatbot - a photo, a glowing orb, or a friendly mascot."
        />
        <AvatarPicker
          avatarType={draft.avatarType}
          orbColor={draft.orbColor}
          botLogo={draft.botLogo}
          botLogoSource={draft.botLogoSource}
          primaryColor={draft.primaryColor}
          uploading={uploading}
          swatches={swatches}
          onChangeType={(t) => onChange({ avatarType: t })}
          onChangeOrbColor={(c) => onChange({ orbColor: c })}
          onUpload={onUpload}
          onRemoveLogo={() => onChange({ botLogo: null })}
          avatarIsLive={avatarIsLive}
        />
        {uploadError && (
          <p role="alert" className="text-[12px] text-[var(--ds-danger)]">
            {uploadError}
          </p>
        )}
      </section>

      <section className="space-y-4 border-t border-[var(--ds-border)] pt-6">
        <Card className="flex items-center justify-between gap-4 p-4">
          <div className="flex min-w-0 items-start gap-3">
            {!canRemoveBranding && (
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]"
                aria-hidden="true"
              >
                <Lock size={15} />
              </span>
            )}
            <div className="min-w-0">
              <p className="text-[14px] font-medium text-[var(--ds-text)]">Remove branding</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
                {canRemoveBranding
                  ? 'Hide the “Powered by OyeChats” footer from the widget.'
                  : 'Upgrade your plan to hide the “Powered by OyeChats” footer.'}
              </p>
            </div>
          </div>
          {canRemoveBranding ? (
            <Toggle
              checked={!draft.showBranding}
              onChange={(hide) => onChange({ showBranding: !hide })}
              label="Remove OyeChats branding from the widget"
            />
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openUpgradeModal('branding_removable')}
            >
              <Lock size={13} aria-hidden="true" />
              Upgrade to remove branding
            </Button>
          )}
        </Card>

        {showWhiteLabelFields && (
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label
                htmlFor={brandingTextId}
                className="block text-[13px] font-medium text-[var(--ds-text)]"
              >
                Badge text
              </label>
              <Input
                id={brandingTextId}
                value={draft.brandingText}
                placeholder="Powered by OyeChats"
                aria-describedby={brandingTextHintId}
                onChange={(e) => onChange({ brandingText: e.target.value })}
              />
              <p id={brandingTextHintId} className="text-[11px] text-[var(--ds-text-subtle)]">
                Replace “Powered by OyeChats” with your own wording.
              </p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={brandingUrlId}
                className="block text-[13px] font-medium text-[var(--ds-text)]"
              >
                Badge link
              </label>
              <Input
                id={brandingUrlId}
                type="url"
                value={draft.brandingUrl}
                placeholder="https://www.oyechats.com"
                aria-describedby={`${brandingUrlHintId} ${brandingUrlError ? brandingUrlErrorId : ''}`.trim()}
                aria-invalid={brandingUrlError !== null}
                onChange={(e) => onChange({ brandingUrl: e.target.value })}
              />
              <p id={brandingUrlHintId} className="text-[11px] text-[var(--ds-text-subtle)]">
                Where the badge sends visitors.
              </p>
              {brandingUrlError && (
                <p id={brandingUrlErrorId} role="alert" className="text-[12px] text-[var(--ds-danger)]">
                  {brandingUrlError}
                </p>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
