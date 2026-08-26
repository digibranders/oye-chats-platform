import { type ReactElement } from 'react';
import { AlertCircle, Loader2, Lock } from 'lucide-react';
import { Button, Card, SectionHeader } from '../../../design-system';
import { useBrandingAddon } from '../../workspace/billing/useBrandingAddon';
import { ColorField } from '../../launch-studio/customize/ColorField';
import { AvatarPicker } from '../../launch-studio/customize/AvatarPicker';
import { Toggle } from '../advanced/controls';
import { type ExperienceDraft } from './types';
import { useTranslation } from '../../../i18n/useTranslation';

export interface BrandingSectionProps {
  draft: ExperienceDraft;
  onChange: (patch: Partial<ExperienceDraft>) => void;
  /** The agent being edited - scopes the branding add-on to its subscription. */
  botId: number | null;
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
  botId,
  swatches,
  uploading,
  uploadError,
  onUpload,
  avatarIsLive,
}: BrandingSectionProps): ReactElement {
  const { t } = useTranslation();
  // Branding removal is a paid add-on, not a plan tier, so the locked state
  // sells the add-on here rather than routing to the plan-upgrade modal.
  const {
    active: canRemoveBranding,
    busy,
    loading: addonLoading,
    priceLabel,
    error: addonError,
    notice: addonNotice,
    awaitingActivation,
    purchase,
  } = useBrandingAddon({ botId });
  const purchasing = busy || awaitingActivation;

  return (
    <div className="space-y-8">
      <section className="space-y-5">
        <SectionHeader
          title={t('agents.colours') || 'Colours'}
          description="Match the widget to your brand. These drive the launcher, avatar and message bubbles."
        />
        <div className="grid gap-6 sm:grid-cols-2">
          <ColorField
            label={t('agents.brandColour') || 'Brand colour'}
            value={draft.primaryColor}
            onChange={(c) => onChange({ primaryColor: c })}
            swatches={swatches}
          />
          <ColorField
            label={t('agents.visitorMessageColour') || 'Visitor message colour'}
            value={draft.userBubbleColor}
            onChange={(c) => onChange({ userBubbleColor: c })}
            swatches={swatches}
          />
        </div>
      </section>

      <section className="space-y-4 border-t border-[var(--ds-border)] pt-6">
        <SectionHeader
          title={t('agents.avatar') || 'Avatar'}
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
        <Card className="p-4">
          <div className="flex items-center justify-between gap-4">
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
                <p className="text-[14px] font-medium text-[var(--ds-text)]">{t('agents.removeBranding') || 'Remove branding'}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
                  {canRemoveBranding
                    ? t('agents.hideThePoweredByOyechats') || 'Hide the “Powered by OyeChats” footer from the widget.'
                    : priceLabel === null
                      ? t('agents.brandingAddOnHidesTheFooterNoPrice') ||
                        'The branding removal add-on hides the “Powered by OyeChats” footer.'
                      : t('agents.brandingAddOnHidesTheFooter', { price: priceLabel }) ||
                        `The ${priceLabel}/mo branding add-on hides the “Powered by OyeChats” footer.`}
                </p>
              </div>
            </div>
            {canRemoveBranding ? (
              <Toggle
                checked={!draft.showBranding}
                onChange={(hide) => onChange({ showBranding: !hide })}
                label={t('agents.removeOyechatsBrandingFromThe') || 'Remove OyeChats branding from the widget'}
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void purchase()}
                disabled={purchasing || addonLoading || priceLabel === null}
              >
                {purchasing
                  ? t('agents.working') || 'Working…'
                  : priceLabel === null
                    ? t('agents.addBrandingRemoval') || 'Add branding removal'
                    : t('agents.addBrandingAddOnForPrice', { price: priceLabel }) ||
                      `Add for ${priceLabel}/mo`}
              </Button>
            )}
          </div>

          {!canRemoveBranding && (
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--ds-text-subtle)]">
              {t('agents.brandingAddOnRecurringNote') ||
                'A recurring charge on top of your plan. A secure checkout opens to authorise it, and you can cancel it any time on the Billing page.'}
            </p>
          )}

          {/* The entitlement is granted by the payment webhook, not by the
              purchase call, so the wait is announced rather than left silent. */}
          <div aria-live="polite">
            {awaitingActivation && (
              <p className="mt-3 flex items-center gap-2 text-[12px] text-[var(--ds-text-muted)]">
                <Loader2 size={13} aria-hidden="true" className="animate-spin text-[var(--ds-text-subtle)]" />
                {t('agents.switchingBrandingRemovalOn') || 'Switching branding removal on…'}
              </p>
            )}
            {addonNotice && !awaitingActivation && (
              <p className="mt-3 text-[12px] text-[var(--ds-text-muted)]">{addonNotice}</p>
            )}
          </div>

          {addonError && (
            <p role="alert" className="mt-3 flex items-start gap-1.5 text-[12px] text-[var(--ds-danger)]">
              <AlertCircle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
              {addonError}
            </p>
          )}
        </Card>
      </section>
    </div>
  );
}
