import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Globe, Trash2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  FileDrop,
  ImageCropDialog,
  LoadingRows,
  SegmentedControl,
  Spinner,
  Switch,
  buttonClass,
} from '../../../ui';
import PremiumOrb from './PremiumOrb';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { ColorField } from './ColorField';
import { NON_TEXT_CONTRAST_MIN, TEXT_CONTRAST_MIN } from './contrast';
import { AVATAR_ACCEPT, AVATAR_HINT, MAX_AVATAR_BYTES, validateAvatarFile } from './avatarRules';
import { errorMessage, fetchSiteIcon, uploadAvatar } from './experience-api';
import {
  DEFAULT_PRIMARY_COLOR,
  WIDGET_ON_PRIMARY,
  WIDGET_SURFACE,
  WIDGET_TEXT,
} from './widgetTheme';
import type { AvatarType, DraftErrors, ExperienceDraft, ExperienceMeta } from './experience-model';
import { useTranslation } from '../../../i18n/useTranslation';

/**
 * What the widget looks like: its two colours, its face, and its credit line.
 *
 * The colour fields do not just take a hex — they state the contrast each
 * choice produces against the surfaces the widget actually paints, because
 * these values end up in front of the customer's own visitors and "it looked
 * fine on my monitor" is how an unreadable brand ships. See `ColorField`.
 *
 * **The credit line is show-or-hide, nothing more.** The card carries one
 * control: a switch, gated on `branding_removable`. There is deliberately no
 * wording or URL field — the credit is OyeChats' own mark, so a customer either
 * shows it or, with the add-on, hides it. It never becomes someone else's line.
 */

// Labels resolved per render: this is a module constant evaluated before any
// locale exists. `value` is what gets stored and is never translated.
const AVATAR_TYPES: readonly { value: AvatarType; labelKey: string; label: string }[] = [
  { value: 'upload', labelKey: 'agents.avatarTypeImage', label: 'Image' },
  { value: 'orb', labelKey: 'agents.avatarTypeOrb', label: 'Orb' },
  { value: 'mascot', labelKey: 'agents.avatarTypeIcon', label: 'Icon' },
];

export interface BrandingSectionProps {
  draft: ExperienceDraft;
  meta: ExperienceMeta;
  errors: DraftErrors;
  readOnly: boolean;
  /** The chatbot whose subscription the branding add-on would ride on. */
  agentId: number | null;
  onChange: (patch: Partial<ExperienceDraft>) => void;
}

export function BrandingSection({
  draft,
  meta,
  errors,
  readOnly,
  agentId,
  onChange,
}: BrandingSectionProps): ReactElement {
  const { t } = useTranslation();
  const { hasFeature, loading: entitlementsLoading } = useEntitlements();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [fetchingIcon, setFetchingIcon] = useState(false);
  // The picked image is held as an object URL only while the crop dialog is
  // open. The ref lets us revoke exactly the URL we made — even across the
  // re-renders the upload triggers — so a fast picker can't leak them.
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const cropUrlRef = useRef<string | null>(null);

  const releaseCropUrl = useCallback(() => {
    if (cropUrlRef.current) {
      URL.revokeObjectURL(cropUrlRef.current);
      cropUrlRef.current = null;
    }
  }, []);

  // Never leak the object URL if the tab unmounts mid-crop.
  useEffect(() => releaseCropUrl, [releaseCropUrl]);

  const canRemoveBranding = hasFeature('branding_removable');

  // Colours the crawl pulled off the customer's own site come first: they are
  // the only swatches here that are actually *their* brand.
  const swatches = meta.recommendedColors.slice(0, 6);

  // Picking a file no longer uploads it — it opens the cropper. Only the square
  // the customer frames is sent, so the server's centre-crop becomes a no-op.
  const handleFiles = useCallback(
    (files: File[]): void => {
      const file = files[0];
      if (!file) return;
      const reason = validateAvatarFile(file);
      if (reason) {
        setUploadError(reason);
        return;
      }
      setUploadError(null);
      releaseCropUrl();
      const url = URL.createObjectURL(file);
      cropUrlRef.current = url;
      setCropSrc(url);
    },
    [releaseCropUrl],
  );

  const closeCrop = useCallback(() => {
    setCropSrc(null);
    releaseCropUrl();
  }, [releaseCropUrl]);

  // Re-derive the site's favicon on demand and drop it into the same cropper as
  // an upload. The crawl only sets the favicon once into an empty slot and keeps
  // no copy, so this is how a customer who has since changed their avatar gets
  // the site icon back — fetched live from the bot's own website.
  const handleUseSiteIcon = useCallback(async () => {
    if (agentId === null) return;
    setUploadError(null);
    setFetchingIcon(true);
    try {
      const blob = await fetchSiteIcon(agentId);
      releaseCropUrl();
      const url = URL.createObjectURL(blob);
      cropUrlRef.current = url;
      setCropSrc(url);
    } catch (cause) {
      setUploadError(
        errorMessage(cause, t('agents.couldntGetYourWebsitesIcon') || "Couldn't get your website's icon. Upload one instead."),
      );
    } finally {
      setFetchingIcon(false);
    }
  }, [agentId, releaseCropUrl, t]);

  const handleCropped = useCallback(
    async (blob: Blob): Promise<void> => {
      setUploading(true);
      setUploadError(null);
      try {
        const file = new File([blob], 'avatar.png', { type: blob.type || 'image/png' });
        const url = await uploadAvatar(file);
        onChange({ botLogo: url, avatarType: 'upload' });
        closeCrop();
      } catch (cause) {
        setUploadError(
          errorMessage(cause, t('agents.thatImageCouldNotBe2') || 'That image could not be uploaded. Please try again.'),
        );
      } finally {
        setUploading(false);
      }
    },
    [onChange, t, closeCrop],
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader eyebrow="Colour" titleAs="h2" title={t('agents.yourTwoWidgetColours') || 'Your two widget colours'} />
        <CardBody className="flex flex-col gap-6">
          <ColorField
            label={t('agents.brandColour') || 'Brand colour'}
            hint={t('agents.theLauncherTheSendButton') || 'The launcher, the send button and the icon avatar are painted with it.'}
            value={draft.primaryColor}
            onChange={(primaryColor) => onChange({ primaryColor })}
            swatches={swatches}
            error={errors.primaryColor ?? null}
            disabled={readOnly}
            pairs={[
              {
                foreground: WIDGET_ON_PRIMARY,
                background: draft.primaryColor,
                label: t('agents.whiteIconsOnItLauncher') || 'White icons on it: launcher, send button',
                min: NON_TEXT_CONTRAST_MIN,
              },
              {
                foreground: draft.primaryColor,
                background: WIDGET_SURFACE,
                label: t('agents.itAsTextOnThe') || 'It as text on the chat window',
                min: TEXT_CONTRAST_MIN,
              },
            ]}
          />

          <ColorField
            label={t('agents.visitorMessageColour') || 'Visitor message colour'}
            hint={t('agents.theBackgroundOfEveryMessage') || 'The background of every message the visitor sends.'}
            value={draft.userBubbleColor}
            onChange={(userBubbleColor) => onChange({ userBubbleColor })}
            swatches={swatches}
            error={errors.userBubbleColor ?? null}
            disabled={readOnly}
            pairs={[
              {
                foreground: WIDGET_TEXT,
                background: draft.userBubbleColor,
                label: t('agents.theirOwnWordsOnIt') || 'Their own words on it',
                min: TEXT_CONTRAST_MIN,
              },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader eyebrow="Avatar" titleAs="h2" title={t('agents.theFaceOfYourChatbot') || 'The face of your chatbot'} />
        <CardBody className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start gap-6">
            {/* No console hairline round it: the widget's own launcher draws the
                avatar in a 48px circle with no border, so a ring here would show
                the customer something their visitors never see. */}
            <span
              aria-hidden
              className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full"
            >
              {draft.avatarType === 'orb' ? (
                <PremiumOrb color={draft.orbColor || draft.primaryColor || DEFAULT_PRIMARY_COLOR} size={64} />
              ) : draft.avatarType === 'upload' && draft.botLogo ? (
                <img src={draft.botLogo} alt="" className="h-full w-full object-cover" />
              ) : (
                <span
                  className="flex h-full w-full items-center justify-center"
                  style={{ backgroundColor: draft.primaryColor || DEFAULT_PRIMARY_COLOR }}
                >
                  <Bot aria-hidden className="h-7 w-7" color={WIDGET_ON_PRIMARY} />
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <SegmentedControl
                items={AVATAR_TYPES.map((o) => ({ ...o, label: t(o.labelKey) || o.label }))}
                value={draft.avatarType}
                onChange={(avatarType) => onChange({ avatarType })}
                label={t('agents.avatarStyle') || 'Avatar style'}
              />
              {meta.botLogoSource === 'derived' && draft.botLogo ? (
                <p className="mt-2.5 text-xs text-text-secondary">
                  {t('agents.takenFromYourSitesFavicon') || 'Taken from your site’s favicon.'}
                </p>
              ) : null}
            </div>
          </div>

          {draft.avatarType === 'upload' ? (
            <div className="flex flex-col gap-3">
              <FileDrop
                label={t('agents.uploadAnImage') || 'Upload an image'}
                hint={AVATAR_HINT}
                accept={AVATAR_ACCEPT}
                maxSizeBytes={MAX_AVATAR_BYTES}
                maxFiles={1}
                multiple={false}
                disabled={readOnly || uploading}
                onFiles={handleFiles}
              />
              {meta.website ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={readOnly || uploading || fetchingIcon}
                    loading={fetchingIcon}
                    onClick={() => void handleUseSiteIcon()}
                    iconLeft={<Globe aria-hidden />}
                  >
                    {t('agents.useMyWebsitesIcon') || "Use my website's icon"}
                  </Button>
                  <span className="min-w-0 truncate text-xs text-text-tertiary">
                    {t('agents.pulledFromYourSiteThenCrop') || 'Pulled from your site, then crop it to fit.'}
                  </span>
                </div>
              ) : null}
              {uploadError ? (
                <Alert tone="danger" title={t('agents.thatImageCouldNotBe') || 'That image could not be used'} live>
                  {uploadError}
                </Alert>
              ) : null}
              {/* One line under the drop zone, and only when there is something
                  to say. It used to be four separate status surfaces for one
                  upload; the last of them read "No image yet." under an empty
                  drop zone beside a preview already showing the fallback face —
                  three ways of saying nothing, on the state where the panel is
                  emptiest. */}
              {uploading || draft.botLogo ? (
                <div className="flex items-center gap-2 text-xs text-text-secondary">
                  {uploading ? (
                    <span className="flex items-center gap-2" role="status">
                      <Spinner />
                      {t('agents.uploading') || 'Uploading…'}
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={readOnly}
                      onClick={() => onChange({ botLogo: null })}
                      iconLeft={<Trash2 aria-hidden />}
                    >
                      {t('agents.remove') || 'Remove'}
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {draft.avatarType === 'orb' ? (
            <ColorField
              label={t('agents.orbColour') || 'Orb colour'}
              hint={t('agents.leaveItEmptyToFollow') || 'Leave it empty to follow your brand colour.'}
              value={draft.orbColor || draft.primaryColor}
              onChange={(orbColor) => onChange({ orbColor })}
              swatches={swatches}
              error={errors.orbColor ?? null}
              disabled={readOnly}
              pairs={[
                {
                  foreground: draft.orbColor || draft.primaryColor,
                  background: WIDGET_SURFACE,
                  label: t('agents.theOrbAgainstTheChat') || 'The orb against the chat window',
                  min: NON_TEXT_CONTRAST_MIN,
                },
              ]}
            />
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Attribution"
          titleAs="h2"
          title={t('agents.theCreditLineInThe') || 'The credit line in the chat window'}
          description={t('agents.oneSmallLineAtThe') || 'One small line at the bottom of the open chat.'}
          actions={
            draft.showBranding ? (
              <Badge tone="neutral">{t('agents.shown') || 'Shown'}</Badge>
            ) : (
              // Not `success`: hiding a credit line is a preference, not a
              // healthy state, and success is reserved for installed / live /
              // trained.
              <Badge tone="neutral">{t('agents.hidden') || 'Hidden'}</Badge>
            )
          }
        />
        <CardBody className="flex flex-col gap-4">
          {entitlementsLoading ? (
            <LoadingRows rows={2} />
          ) : !canRemoveBranding ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 text-prose text-text-secondary">
                {/* An ADD-ON, not a plan inclusion. No tier grants it, so
                    "Standard and above" sent customers to compare plans for
                    something no plan on that page would give them. */}
                {t('agents.removingItIsAPaidAddOn') ||
                  'Removing it is a paid add-on on any plan. It currently reads'}{' '}
                <span className="font-medium text-text-primary">
                  {meta.brandingText || t('agents.poweredByOyechats') || 'Powered by OyeChats'}
                </span>
                .
              </p>
              {/* A link, not an inline checkout. Buying it needs the charge
                  currency and the Razorpay mandate, and wiring those in here
                  would make a chatbot-settings tab refuse to render without
                  the billing context. The add-on card on Billing owns the
                  money path; this surface explains why it is worth it. */}
              <Link
                to={agentId === null ? '/billing' : `/billing?scope=${agentId}`}
                className={buttonClass('primary', 'sm')}
              >
                {t('agents.addItInBilling') || 'Add it in Billing'}
              </Link>
            </div>
          ) : (
            // Show or hide, and nothing else. The credit is OyeChats' mark, so
            // there is no wording or link to edit — only whether it appears.
            <Switch
              label={t('agents.showTheCreditLine') || 'Show the credit line'}
              checked={draft.showBranding}
              disabled={readOnly}
              onCheckedChange={(showBranding) => onChange({ showBranding })}
            />
          )}
        </CardBody>
      </Card>

      <ImageCropDialog
        open={cropSrc !== null}
        onOpenChange={(next) => {
          if (!next) closeCrop();
        }}
        src={cropSrc}
        onCropped={handleCropped}
        aspect={1}
        round
        outputSize={512}
        busy={uploading}
        title={t('agents.cropYourAvatar') || 'Crop your avatar'}
        confirmLabel={t('agents.useThisImage') || 'Use this image'}
      />
    </div>
  );
}
