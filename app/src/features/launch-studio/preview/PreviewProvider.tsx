import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useBotContext } from '../../../context/BotContext';
import { PreviewContext, type PreviewState } from './preview-context';

const DEFAULTS: PreviewState = {
  primaryColor: '#ba68c8',
  userBubbleColor: '#DBE9FF',
  avatarType: 'upload',
  orbColor: '',
  botLogo: null,
};

/**
 * PreviewProvider — holds the live widget-preview config for Launch Studio.
 * Seeds from the selected agent so the preview is roughly accurate on every
 * step; the Customize step hydrates it with the agent's real appearance and
 * updates it as the user edits.
 */
export function PreviewProvider({ children }: { children: ReactNode }) {
  const { selectedBot } = useBotContext();
  const [preview, setState] = useState<PreviewState>(() => ({
    ...DEFAULTS,
    primaryColor: selectedBot?.primary_color || DEFAULTS.primaryColor,
    botLogo: selectedBot?.bot_logo ?? null,
  }));

  const setPreview = useCallback(
    (patch: Partial<PreviewState>) => setState((prev) => ({ ...prev, ...patch })),
    [],
  );

  const value = useMemo(() => ({ preview, setPreview }), [preview, setPreview]);

  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}
