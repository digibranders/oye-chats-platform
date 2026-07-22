import { useEffect, useState } from 'react';
import { Skeleton } from '../../../design-system';
import { getClientSettings, updateClientSettings, uploadLogo } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { StepShell } from '../StepShell';
import { ColorField } from '../customize/ColorField';
import { AvatarPicker, type AvatarType } from '../customize/AvatarPicker';
import { usePreview } from '../preview/preview-context';
import type { StepProps } from '../steps.config';

const DEFAULTS = {
  primary_color: '#ba68c8',
  user_bubble_color: '#DBE9FF',
  avatar_type: 'upload' as AvatarType,
  orb_color: '',
  launcher_name: 'Have Questions?',
};

const PRESETS = ['#7C3AED', '#4f46e5', '#0ea5e9', '#059669', '#e11d48', '#d97706'];

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
function asAvatarType(value: unknown): AvatarType {
  return value === 'orb' || value === 'mascot' || value === 'upload' ? value : 'upload';
}

/**
 * Step 7 — Customize Widget. The full appearance editor (fresh TS on the new DS):
 * brand + user-bubble colour (real picker + recommended colours) and avatar
 * (photo / orb / mascot). Drives the shared live preview shown in the right pane
 * and persists via updateClientSettings.
 */
export function CustomizeStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  const { preview, setPreview } = usePreview();

  const [loaded, setLoaded] = useState(false);
  const [launcherName, setLauncherName] = useState(DEFAULTS.launcher_name);
  const [recommended, setRecommended] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedBot) return;
    let cancelled = false;
    getClientSettings(selectedBot.id)
      .then((s) => {
        if (cancelled) return;
        setPreview({
          primaryColor: asString(s.primary_color, DEFAULTS.primary_color),
          userBubbleColor: asString(s.user_bubble_color, DEFAULTS.user_bubble_color),
          avatarType: asAvatarType(s.avatar_type),
          orbColor: typeof s.orb_color === 'string' ? s.orb_color : DEFAULTS.orb_color,
          botLogo: typeof s.bot_logo === 'string' ? s.bot_logo : null,
        });
        setLauncherName(asString(s.launcher_name, DEFAULTS.launcher_name));
        setRecommended(
          Array.isArray(s.recommended_colors)
            ? s.recommended_colors.filter((c): c is string => typeof c === 'string')
            : [],
        );
      })
      .catch(() => {
        /* keep defaults */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBot, setPreview]);

  const loading = Boolean(selectedBot) && !loaded;
  const swatches = [...recommended, ...PRESETS];

  const handleUpload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const { url } = await uploadLogo(file);
      setPreview({ botLogo: url });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const handleContinue = async () => {
    if (!selectedBot) {
      props.onContinue();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateClientSettings(
        {
          primary_color: preview.primaryColor,
          user_bubble_color: preview.userBubbleColor,
          background_color: '#ffffff',
          avatar_type: preview.avatarType,
          orb_color: preview.orbColor || null,
          bot_logo: preview.botLogo,
          launcher_logo: preview.botLogo,
          launcher_name: launcherName,
        },
        selectedBot.id,
      );
      props.onContinue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <StepShell
      title="Make it yours"
      description="Choose your agent's colours and avatar — watch it update on the right."
      onBack={props.onBack}
      onContinue={handleContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
      canContinue={!saving && !uploading}
      continueLabel={saving ? 'Saving…' : undefined}
    >
      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-24 w-full max-w-sm" />
        </div>
      ) : (
        <div className="max-w-md space-y-6">
          <ColorField
            label="Brand colour"
            value={preview.primaryColor}
            onChange={(c) => setPreview({ primaryColor: c })}
            swatches={swatches}
          />
          <ColorField
            label="User message colour"
            value={preview.userBubbleColor}
            onChange={(c) => setPreview({ userBubbleColor: c })}
            swatches={swatches}
          />
          <div>
            <span className="mb-2 block text-[13px] font-medium text-[var(--ds-text)]">Avatar</span>
            <AvatarPicker
              avatarType={preview.avatarType}
              orbColor={preview.orbColor}
              botLogo={preview.botLogo}
              primaryColor={preview.primaryColor}
              uploading={uploading}
              swatches={swatches}
              onChangeType={(t) => setPreview({ avatarType: t })}
              onChangeOrbColor={(c) => setPreview({ orbColor: c })}
              onUpload={handleUpload}
              onRemoveLogo={() => setPreview({ botLogo: null })}
            />
          </div>
          {error && <p className="text-[12px] text-[var(--ds-danger)]">{error}</p>}
        </div>
      )}
    </StepShell>
  );
}
