import { useId, useState, type ReactElement } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { BotAvatar, Button, Input, Modal } from '../../design-system';
import { type Bot } from '../../types/domain';
import { useTranslation } from '../../i18n/useTranslation';
import { Trans } from '../../i18n/Trans';

export interface DeleteAgentDialogProps {
  /** The agent to be deleted. */
  bot: Bot;
  /** Whether the dialog is visible. */
  open: boolean;
  /** Close without deleting (backdrop / ESC / Cancel). Ignored while `busy`. */
  onClose: () => void;
  /** Perform the delete. Only reachable once the typed name matches exactly. */
  onConfirm: () => void;
  /** Deletion in flight - locks the inputs and shows a spinner. */
  busy: boolean;
  /** Error message from a failed delete attempt. */
  error?: string;
}

/**
 * DeleteAgentDialog - a "type the name to confirm" destructive modal.
 *
 * The identity mark is the agent's real avatar with a small destructive badge -
 * grounding the operator in exactly which agent is about to be lost, rather than
 * a generic warning glyph. Deletion is irreversible (knowledge, conversations,
 * and leads go with it), so the confirm button stays disabled until the exact
 * name is typed; backdrop / ESC dismissal is blocked while the request is
 * in flight.
 */
export function DeleteAgentDialog({
  bot,
  open,
  onClose,
  onConfirm,
  busy,
  error,
}: DeleteAgentDialogProps): ReactElement {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const errorId = `${inputId}-error`;

  const matches = typed.trim() === bot.name;
  const canDelete = matches && !busy;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Delete ${bot.name}`}
      size="sm"
      dismissible={!busy}
    >
      <div className="space-y-5">
        {/* Identity - the real agent avatar, marked for deletion. */}
        <div className="flex flex-col items-center gap-2.5 text-center">
          <div className="relative">
            <BotAvatar bot={bot} size={56} radius="xl" />
            <span
              className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--ds-danger)] text-white shadow-[var(--ds-shadow-sm)] ring-2 ring-[var(--ds-bg-surface)]"
              aria-hidden="true"
            >
              <Trash2 size={12} />
            </span>
          </div>
          <div>
            <p className="text-[17px] font-semibold text-[var(--ds-text)]">{bot.name}</p>
            {bot.bot_key && (
              <p className="mt-0.5 font-mono text-[12px] text-[var(--ds-text-subtle)]">
                {bot.bot_key}
              </p>
            )}
          </div>
        </div>

        {/* What gets removed. */}
        <p className="rounded-[var(--ds-radius-md)] border border-[var(--ds-border)] bg-[var(--ds-danger-soft)] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[var(--ds-text-muted)]">
          {t('agents.deletePermanently') ||
            'This permanently deletes the chatbot along with its knowledge base, conversations, and captured leads. This action cannot be undone.'}
        </p>

        {/* Type-to-confirm gate. */}
        <div>
          <label htmlFor={inputId} className="block text-[13px] text-[var(--ds-text)]">
            <Trans
              k="agents.toConfirmType"
              fallback="To confirm, type {name} in the box below"
              values={{
                name: (
                  <span className="font-semibold text-[var(--ds-text)]">{bot.name}</span>
                ),
              }}
            />
          </label>
          <Input
            id={inputId}
            value={typed}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canDelete) {
                event.preventDefault();
                onConfirm();
              }
            }}
            className="mt-2"
          />
          {error && (
            <p id={errorId} role="alert" className="mt-2 text-[12px] text-[var(--ds-danger)]">
              {error}
            </p>
          )}
        </div>

        <Button
          type="button"
          variant="danger"
          className="w-full"
          disabled={!canDelete}
          onClick={onConfirm}
        >
          {busy && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
          {busy ? 'Deleting…' : t('agents.deleteThisChatbot') || 'Delete this chatbot'}
        </Button>
      </div>
    </Modal>
  );
}
