import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { previewChatStream } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { PreviewContext, type PreviewMessage, type PreviewState } from './preview-context';

const DEFAULTS: PreviewState = {
  primaryColor: '#ba68c8',
  userBubbleColor: '#DBE9FF',
  avatarType: 'upload',
  orbColor: '',
  botLogo: null,
  messages: [],
  pending: false,
};

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `preview-${Math.random().toString(36).slice(2)}`;
}

/**
 * Stream a chunk into the conversation: append to the trailing bot message, or
 * start a new bot message if the last one is the user's. Critically, we do NOT
 * pre-create an empty bot message on send - otherwise the widget renders both an
 * empty bot avatar AND the typing indicator (double avatar). The bot message is
 * born on the first chunk.
 */
function appendChunk(messages: PreviewMessage[], text: string): PreviewMessage[] {
  const next = messages.slice();
  const last = next[next.length - 1];
  if (last && last.role === 'bot') next[next.length - 1] = { ...last, text: last.text + text };
  else next.push({ role: 'bot', text });
  return next;
}

/**
 * PreviewProvider - holds the live widget-preview config for Launch Studio and
 * owns the preview chat (Test step): `ask()` streams a real answer from the
 * agent (previewChatStream) into the widget's message list.
 */
export function PreviewProvider({ children }: { children: ReactNode }) {
  const { selectedBot } = useBotContext();
  const [preview, setState] = useState<PreviewState>(() => ({
    ...DEFAULTS,
    primaryColor: selectedBot?.primary_color || DEFAULTS.primaryColor,
    botLogo: selectedBot?.bot_logo ?? null,
  }));
  const sessionRef = useRef<string | null>(null);

  const setPreview = useCallback(
    (patch: Partial<PreviewState>) => setState((prev) => ({ ...prev, ...patch })),
    [],
  );

  const ask = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q || !selectedBot) return;
      if (!sessionRef.current) sessionRef.current = newSessionId();

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, { role: 'user', text: q }, { role: 'bot', text: '' }],
        pending: true,
      }));

      void previewChatStream(selectedBot.id, q, sessionRef.current, {
        onChunk: (text) => setState((prev) => ({ ...prev, messages: appendChunk(prev.messages, text) })),
        onFinal: () => setState((prev) => ({ ...prev, pending: false })),
        onError: () =>
          setState((prev) => {
            const next = prev.messages.slice();
            const last = next[next.length - 1];
            if (last && last.role === 'bot' && !last.text) {
              next[next.length - 1] = { ...last, text: 'Sorry, I couldn’t answer that just now.' };
            }
            return { ...prev, messages: next, pending: false };
          }),
      });
    },
    [selectedBot],
  );

  const value = useMemo(() => ({ preview, setPreview, ask }), [preview, setPreview, ask]);

  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}
