import { Send } from 'lucide-react';
import { useBotContext } from '../../../context/BotContext';
import { AvatarPreview } from '../customize/AvatarPicker';
import { usePreview } from './preview-context';

/**
 * WidgetPreview — a faithful, live preview of the chat widget rendered in the
 * Launch Studio right pane. Reflects the shared preview config (brand colour,
 * user-bubble colour, avatar), so customization shows up here in real time.
 */
export function WidgetPreview() {
  const { preview } = usePreview();
  const { selectedBot } = useBotContext();
  const name = selectedBot?.name || 'Your agent';

  return (
    <div className="mx-auto flex h-full w-full max-w-[300px] flex-col justify-center">
      <div className="overflow-hidden rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)]">
        {/* Header */}
        <div className="flex items-center gap-2.5 p-3.5" style={{ backgroundColor: preview.primaryColor }}>
          <AvatarPreview
            avatarType={preview.avatarType}
            botLogo={preview.botLogo}
            orbColor={preview.orbColor}
            primaryColor={preview.primaryColor}
            size={38}
          />
          <div className="min-w-0 text-white">
            <p className="truncate text-[14px] font-semibold leading-tight">{name}</p>
            <p className="text-[11px] opacity-85">Online</p>
          </div>
        </div>

        {/* Conversation */}
        <div className="space-y-2.5 p-3.5" style={{ minHeight: 176 }}>
          <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-[var(--ds-bg-sunken)] px-3 py-2 text-[12.5px] text-[var(--ds-text)]">
            Hi! I&apos;m {name}. How can I help?
          </div>
          <div
            className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm px-3 py-2 text-[12.5px] text-[#18181b]"
            style={{ backgroundColor: preview.userBubbleColor }}
          >
            What are your hours?
          </div>
        </div>

        {/* Composer */}
        <div className="flex items-center gap-2 border-t border-[var(--ds-border)] p-2.5">
          <div className="flex-1 rounded-full bg-[var(--ds-bg-sunken)] px-3 py-2 text-[12px] text-[var(--ds-text-subtle)]">
            Type a message…
          </div>
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white"
            style={{ backgroundColor: preview.primaryColor }}
          >
            <Send size={14} />
          </div>
        </div>
      </div>
    </div>
  );
}
