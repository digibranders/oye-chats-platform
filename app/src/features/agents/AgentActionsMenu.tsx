import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ExternalLink, Link2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import {
  Alert,
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  buttonClass,
  toast,
  useClipboard,
} from '../../ui';
import { deleteBot, getBotDemoUrl, trackDemoShareClick, updateBot } from '../../services/api';
import type { Bot } from '../../types/domain';

const MAX_NAME_LENGTH = 50;

export interface AgentActionsMenuProps {
  bot: Bot;
  /** Called after a successful rename or delete, so the list can refetch. */
  onChanged: () => void;
}

/** Returns the reason the name is unusable, or `null` when it will do. */
function validateAgentName(value: string, current: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Give the chatbot a name.';
  if (trimmed.length > MAX_NAME_LENGTH) return `Keep it to ${MAX_NAME_LENGTH} characters or fewer.`;
  if (trimmed === current) return 'That is already its name.';
  return null;
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : 'Something went wrong. Please try again.';
}

/**
 * The per-chatbot "⋯" menu.
 *
 * Rebuilt on the system's own `Menu`, `Dialog` and `ConfirmDialog` rather than
 * the hand-rolled popup it replaces, which had three defects that only showed
 * up when something failed.
 *
 * It shared one `error` string between the menu and the delete dialog, so a
 * rename that the server refused surfaced its message inside the delete
 * confirmation — under a button that deletes a knowledge base. Rename and
 * delete now own separate state and separate surfaces.
 *
 * Its `busy` flag was never released after a successful delete ("leave it set,
 * the tile is about to unmount"), so if the refresh that follows failed, the
 * dialog stayed stuck on "Deleting…" with dismissal blocked and no way out but
 * a page reload. `ConfirmDialog` releases in a `finally`, unconditionally.
 *
 * And rename had no validation at all: an empty or whitespace-only name closed
 * the editor silently, as if it had saved.
 *
 * Rename is a dialog rather than an inline field inside the menu because
 * `role="menu"` obliges every child to be a `menuitem` — a text input inside
 * one makes the whole popup unnavigable with a screen reader.
 */
export function AgentActionsMenu({ bot, onChanged }: AgentActionsMenuProps) {
  const name = bot.name || `Chatbot ${bot.id}`;
  const { state: clipboard, copy } = useClipboard();

  const [renameOpen, setRenameOpen] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const demoUrl = bot.bot_key ? getBotDemoUrl(bot.bot_key) : null;

  const rename = useMutation({
    mutationFn: (next: string) => updateBot(bot.id, { name: next }),
  });

  const remove = useMutation({
    mutationFn: () => deleteBot(bot.id),
  });

  const openRename = useCallback(() => {
    setDraftName(name);
    setNameError(null);
    setRenameError(null);
    setRenameOpen(true);
  }, [name]);

  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (rename.isPending) return;
    const invalid = validateAgentName(draftName, name);
    if (invalid) {
      setNameError(invalid);
      return;
    }
    setNameError(null);
    setRenameError(null);
    try {
      await rename.mutateAsync(draftName.trim());
      setRenameOpen(false);
      onChanged();
      toast.success(`Renamed to ${draftName.trim()}`);
    } catch (cause) {
      // Stays on the page, beside the control that produced it: the user has to
      // read this before they can proceed, which a toast does not guarantee.
      setRenameError(messageFrom(cause));
    }
  };

  const confirmDelete = async () => {
    await remove.mutateAsync();
    // Only reached when the delete actually succeeded — `ConfirmDialog` keeps
    // itself open and shows the reason when this throws.
    setDeleteOpen(false);
    onChanged();
    toast.success(`${name} deleted`);
  };

  /**
   * Copying the demo link records a share. Fire-and-forget on purpose: a failed
   * analytics ping must never turn a successful copy into an error. The event
   * the backend records is `demo_share_clicked`, so the intent to share is the
   * signal — not whether the browser's clipboard happened to cooperate.
   */
  const copyDemoLink = () => {
    if (!demoUrl) return;
    void copy(demoUrl);
    void trackDemoShareClick(bot.id).catch(() => undefined);
  };

  // `navigator.clipboard` rejects on an insecure origin, without permission,
  // and when the document is not focused, so the outcome is reported rather
  // than assumed. The menu has closed by the time it settles, which is why this
  // is a toast and not an inline message.
  useEffect(() => {
    if (clipboard === 'copied') toast.success('Demo link copied');
    else if (clipboard === 'failed') {
      toast.error('Could not copy the link. Open the demo page and copy it from the address bar.');
    }
  }, [clipboard]);

  return (
    <>
      <MenuRoot>
        <MenuTrigger
          aria-label={`Actions for ${name}`}
          className={buttonClass('ghost', 'icon-sm')}
        >
          <MoreHorizontal aria-hidden className="h-4 w-4" />
        </MenuTrigger>
        <MenuContent>
          {demoUrl ? (
            <MenuItem
              icon={<ExternalLink aria-hidden className="h-3.5 w-3.5" />}
              onSelect={() => window.open(demoUrl, '_blank', 'noopener,noreferrer')}
            >
              Open demo page
            </MenuItem>
          ) : null}
          {demoUrl ? (
            <MenuItem
              icon={<Link2 aria-hidden className="h-3.5 w-3.5" />}
              onSelect={copyDemoLink}
            >
              Copy demo link
            </MenuItem>
          ) : null}
          {demoUrl ? <MenuSeparator /> : null}
          <MenuItem icon={<Pencil aria-hidden className="h-3.5 w-3.5" />} onSelect={openRename}>
            Rename…
          </MenuItem>
          <MenuItem
            destructive
            icon={<Trash2 aria-hidden className="h-3.5 w-3.5" />}
            onSelect={() => setDeleteOpen(true)}
          >
            Delete…
          </MenuItem>
        </MenuContent>
      </MenuRoot>

      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          setRenameOpen(open);
          if (!open) setRenameError(null);
        }}
        title={`Rename ${name}`}
        description="Only you and your team see this name. Visitors see the display name set in Experience."
        size="sm"
        dismissible={!rename.isPending}
        footer={
          <>
            <Button variant="ghost" disabled={rename.isPending} onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              form={`rename-agent-${bot.id}`}
              type="submit"
              loading={rename.isPending}
            >
              Save name
            </Button>
          </>
        }
      >
        <form id={`rename-agent-${bot.id}`} onSubmit={(event) => void submitRename(event)}>
          <Field label="Chatbot name" error={nameError} required>
            <Input
              value={draftName}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="off"
              disabled={rename.isPending}
              onChange={(event) => {
                setDraftName(event.target.value);
                if (nameError) setNameError(null);
              }}
            />
          </Field>
          {renameError ? (
            <Alert tone="danger" live className="mt-3">
              {renameError}
            </Alert>
          ) : null}
        </form>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${name}?`}
        description={
          <>
            This removes the chatbot, everything it has learned, every conversation it has held and
            every lead it captured. It cannot be undone, and any site still running its script will
            stop showing a chatbot.
          </>
        }
        confirmLabel="Delete chatbot"
        confirmPhrase={name}
        destructive
        onConfirm={confirmDelete}
      />
    </>
  );
}
