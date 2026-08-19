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
  CardSection,
  FileDrop,
  SegmentedControl,
  Spinner,
  Switch,
  Tooltip,
  buttonClass,
} from '../../../ui';
import PremiumOrb from '../../../components/PremiumOrb';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { agentPath } from '../../../shell/nav';
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
  agentId: number | null;
  readOnly: boolean;
  onChange: (patch: Partial<ExperienceDraft>) => void;
}

export function BrandingSection({
  draft,
  meta,
  errors,
  agentId,
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
        <CardHeader
          eyebrow="Colour"
          titleAs="h2"
          title="Your two widget colours"
          description="One carries the brand — the launcher, the send button, the credit line. The other is the background of everything a visitor types."
        />
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
        <CardHeader
          eyebrow="Avatar"
          titleAs="h2"
          title="The face of your chatbot"
          description="Shown on the closed launcher, in the header, and beside every reply."
        />
        <CardBody className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start gap-6">
            <span
              aria-hidden
              className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border"
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
                <p className="mt-2.5 text-xs leading-relaxed text-text-secondary">
                  This image was taken from your website&apos;s favicon while training. Upload one to
                  replace it.
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
              {uploading ? (
                <p className="flex items-center gap-2 text-xs text-text-secondary" role="status">
                  <Spinner />
                  Uploading…
                </p>
              ) : null}
              {uploadError ? (
                <Alert tone="danger" title="That image could not be used" live>
                  {uploadError}
                </Alert>
              ) : null}
              {draft.botLogo ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={readOnly}
                    onClick={() => onChange({ botLogo: null })}
                  >
                    <Trash2 aria-hidden className="h-3.5 w-3.5" />
                    Remove image
                  </Button>
                  <span className="text-xs text-text-secondary">
                    The chatbot falls back to its icon avatar.
                  </span>
                </div>
              ) : (
                <p className="text-xs text-text-secondary">
                  No image yet — the chatbot shows its icon avatar until you add one.
                </p>
              )}
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
        />
        <CardBody className="flex flex-col gap-4">
          {entitlementsLoading ? (
            <p className="text-xs text-text-secondary">Checking what your plan includes…</p>
          ) : canRemoveBranding ? (
            <Switch
              label="Show the credit line"
              description="Turn it off to remove it from the chat window entirely."
              checked={draft.showBranding}
              disabled={readOnly}
              onCheckedChange={(showBranding) => onChange({ showBranding })}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 text-prose text-text-secondary">
                Every chatbot on your plan shows the credit line. Plans with white-label branding let
                you reword it, point it at your own site, or remove it.
              </p>
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                Compare plans
              </Link>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-prose">
            <span className="text-text-secondary">Currently reads</span>
            <Badge tone={draft.showBranding ? 'neutral' : 'success'}>
              {draft.showBranding ? meta.brandingText || 'Powered by OyeChats' : 'Hidden'}
            </Badge>
            {canRemoveBranding && agentId !== null ? (
              <Tooltip content="The wording lives with the snippet, on Deploy">
                <Link
                  to={agentPath(agentId, 'deploy')}
                  className="text-xs font-medium text-accent-600 underline-offset-2 hover:underline"
                >
                  Change the wording
                </Link>
              </Tooltip>
            ) : null}
          </div>
        </CardBody>

        <CardSection>
          <Alert tone="neutral" title="This is not the link in your embed snippet">
            The chat window is drawn from JavaScript after a visitor clicks, so no crawler ever sees
            this line. The separate, crawlable credit link in your snippet is governed by the same
            plan and is set up on Deploy.
          </Alert>
        </CardSection>
      </Card>
    </div>
  );
}
