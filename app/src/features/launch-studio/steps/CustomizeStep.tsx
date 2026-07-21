import { useEffect, useState } from 'react';
import { Skeleton } from '../../../design-system';
import { getClientSettings, updateClientSettings, uploadLogo } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { StepShell } from '../StepShell';
import { ColorField } from '../customize/ColorField';
import { AvatarPicker, AvatarPreview, type AvatarType } from '../customize/AvatarPicker';
import type { StepProps } from '../steps.config';

const DEFAULTS = {
  primary_color: '#ba68c8',
  user_bubble_color: '#DBE9FF',
  avatar_type: 'upload' as AvatarType,
  orb_color: '',
  bot_logo: null as string | null,
  launcher_name: 'Have Questions?',
};

const PRESETS = ['#a21caf', '#4f46e5', '#0ea5e9', '#059669', '#e11d48', '#d97706'];

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
function asAvatarType(value: unknown): AvatarType {
  return value === 'orb' || value === 'mascot' || value === 'upload' ? value : 'upload';
}

/**
 * Step 7 — Customize Widget. The full appearance editor (fresh TS on the new DS):
 * brand + user-bubble colour with a real picker + recommended colours, and
 * avatar selection (photo / orb / mascot). Persists via updateClientSettings.
 */
export function CustomizeStep(props: StepProps) {
  const { selectedBot } = useBotContext();

  const [loaded, setLoaded] = useState(false);
  const [primaryColor, setPrimaryColor] = useState(DEFAULTS.primary_color);
  const [userBubbleColor, setUserBubbleColor] = useState(DEFAULTS.user_bubble_color);
  const [avatarType, setAvatarType] = useState<AvatarType>(DEFAULTS.avatar_type);
  const [orbColor, setOrbColor] = useState(DEFAULTS.orb_color);
  const [botLogo, setBotLogo] = useState<string | null>(DEFAULTS.bot_logo);
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
        setPrimaryColor(asString(s.primary_color, DEFAULTS.primary_color));
        setUserBubbleColor(asString(s.user_bubble_color, DEFAULTS.user_bubble_color));
        setAvatarType(asAvatarType(s.avatar_type));
        setOrbColor(typeof s.orb_color === 'string' ? s.orb_color : DEFAULTS.orb_color);
        setBotLogo(typeof s.bot_logo === 'string' ? s.bot_logo : null);
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
  }, [selectedBot]);

  const loading = Boolean(selectedBot) && !loaded;
  const swatches = [...recommended, ...PRESETS];

  const handleUpload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const { url } = await uploadLogo(file);
      setBotLogo(url);
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
          primary_color: primaryColor,
          user_bubble_color: userBubbleColor,
          background_color: '#ffffff',
          avatar_type: avatarType,
          orb_color: orbColor || null,
          bot_logo: botLogo,
          launcher_logo: botLogo,
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
      description="Choose your agent's colours and avatar. You can fine-tune the rest later."
      onBack={props.onBack}
      onContinue={handleContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
      canContinue={!saving && !uploading}
      continueLabel={saving ? 'Saving…' : undefined}
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="grid gap-8 md:grid-cols-[1fr_auto]">
          <div className="space-y-6">
            <ColorField
              label="Brand colour"
              value={primaryColor}
              onChange={setPrimaryColor}
              swatches={swatches}
            />
            <ColorField
              label="User message colour"
              value={userBubbleColor}
              onChange={setUserBubbleColor}
              swatches={swatches}
            />
            <div>
              <span className="mb-2 block text-[13px] font-medium text-[var(--ds-text)]">Avatar</span>
              <AvatarPicker
                avatarType={avatarType}
                orbColor={orbColor}
                botLogo={botLogo}
                primaryColor={primaryColor}
                uploading={uploading}
                swatches={swatches}
                onChangeType={setAvatarType}
                onChangeOrbColor={setOrbColor}
                onUpload={handleUpload}
                onRemoveLogo={() => setBotLogo(null)}
              />
            </div>
            {error && <p className="text-[12px] text-[var(--ds-danger)]">{error}</p>}
          </div>

          {/* Live preview */}
          <div className="w-full max-w-[240px] justify-self-center md:justify-self-end">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
              Preview
            </p>
            <div className="overflow-hidden rounded-2xl border border-[var(--ds-border)] shadow-[var(--ds-shadow-md)]">
              <div className="flex items-center gap-2.5 p-3" style={{ backgroundColor: primaryColor }}>
                <AvatarPreview
                  avatarType={avatarType}
                  botLogo={botLogo}
                  orbColor={orbColor}
                  primaryColor={primaryColor}
                  size={36}
                />
                <div className="min-w-0 text-white">
                  <p className="truncate text-[13px] font-semibold leading-tight">
                    {selectedBot?.name || 'Your agent'}
                  </p>
                  <p className="text-[11px] opacity-80">Online</p>
                </div>
              </div>
              <div className="space-y-2 bg-[var(--ds-bg-surface)] p-3">
                <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-[var(--ds-bg-sunken)] px-3 py-2 text-[12px] text-[var(--ds-text)]">
                  Hi! How can I help?
                </div>
                <div
                  className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm px-3 py-2 text-[12px] text-[#18181b]"
                  style={{ backgroundColor: userBubbleColor }}
                >
                  What are your hours?
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </StepShell>
  );
}
