import { type ReactElement, useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Trash2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  FileDrop,
  Grid,
  Input,
  LoadingRows,
  SegmentedControl,
  Spinner,
  Switch,
  buttonClass,
  validateUrl,
} from '../../../ui';
import PremiumOrb from '../../../components/PremiumOrb';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { ColorField } from './ColorField';
import { NON_TEXT_CONTRAST_MIN, TEXT_CONTRAST_MIN } from './contrast';
import { AVATAR_ACCEPT, AVATAR_HINT, MAX_AVATAR_BYTES, validateAvatarFile } from './avatarRules';
import { errorMessage, uploadAvatar } from './experience-api';
import {
  DEFAULT_PRIMARY_COLOR,
  WIDGET_ON_PRIMARY,
  WIDGET_SURFACE,
  WIDGET_TEXT,
} from './widgetTheme';
import type { AvatarType, DraftErrors, ExperienceDraft, ExperienceMeta } from './experience-model';

/**
 * What the widget looks like: its two colours, its face, and its credit line.
 *
 * The colour fields do not just take a hex — they state the contrast each
 * choice produces against the surfaces the widget actually paints, because
 * these values end up in front of the customer's own visitors and "it looked
 * fine on my monitor" is how an unreadable brand ships. See `ColorField`.
 *
 * **The credit line is configured here, once.** Its on/off switch was on this
 * page and its wording and URL were on Deploy, under a card with the same title
 * and a near-identical 40-word alert — so a customer who switched the badge off
 * here still saw "Change the wording", linking to Deploy, for a badge that was
 * now hidden. Both halves are gated on the same `branding_removable`
 * entitlement, so both halves live in one card.
 */

const AVATAR_TYPES: readonly { value: AvatarType; label: string }[] = [
  { value: 'upload', label: 'Image' },
  { value: 'orb', label: 'Orb' },
  { value: 'mascot', label: 'Icon' },
];

export interface BrandingSectionProps {
  draft: ExperienceDraft;
  meta: ExperienceMeta;
  errors: DraftErrors;
  readOnly: boolean;
  onChange: (patch: Partial<ExperienceDraft>) => void;
}

export function BrandingSection({
  draft,
  meta,
  errors,
  readOnly,
  onChange,
}: BrandingSectionProps): ReactElement {
  const { hasFeature, loading: entitlementsLoading } = useEntitlements();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const canRemoveBranding = hasFeature('branding_removable');

  // Colours the crawl pulled off the customer's own site come first: they are
  // the only swatches here that are actually *their* brand.
  const swatches = meta.recommendedColors.slice(0, 6);

  const brandingUrlError = draft.brandingUrl.trim()
    ? validateUrl(draft.brandingUrl.trim())
    : null;

  const handleFiles = useCallback(
    async (files: File[]): Promise<void> => {
      const file = files[0];
      if (!file) return;
      const reason = validateAvatarFile(file);
      if (reason) {
        setUploadError(reason);
        return;
      }
      setUploading(true);
      setUploadError(null);
      try {
        const url = await uploadAvatar(file);
        onChange({ botLogo: url, avatarType: 'upload' });
      } catch (cause) {
        setUploadError(errorMessage(cause, 'That image could not be uploaded. Please try again.'));
      } finally {
        setUploading(false);
      }
    },
    [onChange],
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader eyebrow="Colour" titleAs="h2" title="Your two widget colours" />
        <CardBody className="flex flex-col gap-6">
          <ColorField
            label="Brand colour"
            hint="The launcher, the send button and the icon avatar are painted with it."
            value={draft.primaryColor}
            onChange={(primaryColor) => onChange({ primaryColor })}
            swatches={swatches}
            error={errors.primaryColor ?? null}
            disabled={readOnly}
            pairs={[
              {
                foreground: WIDGET_ON_PRIMARY,
                background: draft.primaryColor,
                label: 'White icons on it — launcher, send button',
                min: NON_TEXT_CONTRAST_MIN,
              },
              {
                foreground: draft.primaryColor,
                background: WIDGET_SURFACE,
                label: 'It as text on the chat window',
                min: TEXT_CONTRAST_MIN,
              },
            ]}
          />

          <ColorField
            label="Visitor message colour"
            hint="The background of every message the visitor sends."
            value={draft.userBubbleColor}
            onChange={(userBubbleColor) => onChange({ userBubbleColor })}
            swatches={swatches}
            error={errors.userBubbleColor ?? null}
            disabled={readOnly}
            pairs={[
              {
                foreground: WIDGET_TEXT,
                background: draft.userBubbleColor,
                label: 'Their own words on it',
                min: TEXT_CONTRAST_MIN,
              },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader eyebrow="Avatar" titleAs="h2" title="The face of your chatbot" />
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
                items={AVATAR_TYPES}
                value={draft.avatarType}
                onChange={(avatarType) => onChange({ avatarType })}
                label="Avatar style"
              />
              {meta.botLogoSource === 'derived' && draft.botLogo ? (
                <p className="mt-2.5 text-xs text-text-secondary">
                  Taken from your site’s favicon.
                </p>
              ) : null}
            </div>
          </div>

          {draft.avatarType === 'upload' ? (
            <div className="flex flex-col gap-3">
              <FileDrop
                label="Upload an image"
                hint={AVATAR_HINT}
                accept={AVATAR_ACCEPT}
                maxSizeBytes={MAX_AVATAR_BYTES}
                maxFiles={1}
                multiple={false}
                disabled={readOnly || uploading}
                onFiles={(files) => void handleFiles(files)}
              />
              {uploadError ? (
                <Alert tone="danger" title="That image could not be used" live>
                  {uploadError}
                </Alert>
              ) : null}
              {/* One line under the drop zone, one ternary. It used to be four
                  separate status surfaces for one upload, two of which said the
                  same thing about the fallback the 64px preview already shows. */}
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                {uploading ? (
                  <span className="flex items-center gap-2" role="status">
                    <Spinner />
                    Uploading…
                  </span>
                ) : draft.botLogo ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={readOnly}
                    onClick={() => onChange({ botLogo: null })}
                    iconLeft={<Trash2 aria-hidden />}
                  >
                    Remove
                  </Button>
                ) : (
                  <span>No image yet.</span>
                )}
              </div>
            </div>
          ) : null}

          {draft.avatarType === 'orb' ? (
            <ColorField
              label="Orb colour"
              hint="Leave it empty to follow your brand colour."
              value={draft.orbColor || draft.primaryColor}
              onChange={(orbColor) => onChange({ orbColor })}
              swatches={swatches}
              error={errors.orbColor ?? null}
              disabled={readOnly}
              pairs={[
                {
                  foreground: draft.orbColor || draft.primaryColor,
                  background: WIDGET_SURFACE,
                  label: 'The orb against the chat window',
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
          title="The credit line in the chat window"
          description="One small line at the bottom of the open chat."
          actions={
            draft.showBranding ? (
              <Badge tone="neutral">Shown</Badge>
            ) : (
              // Not `success`: hiding a credit line is a preference, not a
              // healthy state, and success is reserved for installed / live /
              // trained.
              <Badge tone="neutral">Hidden</Badge>
            )
          }
        />
        <CardBody className="flex flex-col gap-4">
          {entitlementsLoading ? (
            <LoadingRows rows={2} />
          ) : !canRemoveBranding ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 text-prose text-text-secondary">
                Standard and above lets you reword or remove it. It currently reads{' '}
                <span className="font-medium text-text-primary">
                  {meta.brandingText || 'Powered by OyeChats'}
                </span>
                .
              </p>
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                Compare plans
              </Link>
            </div>
          ) : (
            <>
              <Switch
                label="Show the credit line"
                checked={draft.showBranding}
                disabled={readOnly}
                onCheckedChange={(showBranding) => onChange({ showBranding })}
              />
              {draft.showBranding ? (
                <Grid cols={2}>
                  <Field label="Wording" error={errors.brandingText ?? null}>
                    <Input
                      value={draft.brandingText}
                      disabled={readOnly}
                      placeholder="Powered by OyeChats"
                      onChange={(event) => onChange({ brandingText: event.target.value })}
                    />
                  </Field>
                  <Field label="Where it links to" error={brandingUrlError}>
                    <Input
                      value={draft.brandingUrl}
                      inputMode="url"
                      spellCheck={false}
                      autoComplete="off"
                      disabled={readOnly}
                      placeholder="https://www.oyechats.com"
                      onChange={(event) => onChange({ brandingUrl: event.target.value })}
                      className="figure"
                    />
                  </Field>
                </Grid>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
