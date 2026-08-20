import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ExternalLink, KeyRound, Link2, MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react';
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
  /** What the last copy was of, so the toast can name it. */
  const copied = useRef<'demo link' | 'chatbot key'>('demo link');

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

  const [pauseOpen, setPauseOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);

  // `is_active` is optional on the list payload; only an explicit `false` means
  // paused, so an older response never renders a chatbot as switched off.
  const paused = bot.is_active === false;

  const setActive = useMutation({
    mutationFn: (next: boolean) => updateBot(bot.id, { is_active: next }),
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
   * Pause and resume are asymmetric, and the UI has to be too.
   *
   * Pausing is a straight write. Resuming re-runs the server's whole create
   * gate — deactivating a chatbot frees its billing slot, so bringing it back
   * is an admission decision that can be refused with a 402 when the plan has
   * no room any more. Neither direction is flipped optimistically: the switch
   * only moves once the server has said it moved, and a refusal is shown in
   * the dialog that asked for it rather than as a toast the reader may miss.
   */
  const confirmPause = async () => {
    await setActive.mutateAsync(false);
    setPauseOpen(false);
    onChanged();
    toast.success(`${name} paused`);
  };

  const confirmResume = async () => {
    await setActive.mutateAsync(true);
    setResumeOpen(false);
    onChanged();
    toast.success(`${name} is answering again`);
  };

  /**
   * Copying the demo link records a share. Fire-and-forget on purpose: a failed
   * analytics ping must never turn a successful copy into an error. The event
   * the backend records is `demo_share_clicked`, so the intent to share is the
   * signal — not whether the browser's clipboard happened to cooperate.
   */
  const copyDemoLink = () => {
    if (!demoUrl) return;
    copied.current = 'demo link';
    void copy(demoUrl);
    void trackDemoShareClick(bot.id).catch(() => undefined);
  };

  /**
   * The chatbot key, one menu item instead of a `CopyField` on every row.
   *
   * It used to be an 84px band on every card of the index — twelve mono strings
   * the eye had to skip past to reach the one chatbot that needed attention. It
   * is needed on Deploy, where the embed snippet already contains it, and here,
   * once, for the support ticket that asks for it.
   */
  const copyBotKey = () => {
    if (!bot.bot_key) return;
    copied.current = 'chatbot key';
    void copy(bot.bot_key);
  };

  // `navigator.clipboard` rejects on an insecure origin, without permission,
  // and when the document is not focused, so the outcome is reported rather
  // than assumed. The menu has closed by the time it settles, which is why this
  // is a toast and not an inline message. The ref names *what* was copied: one
  // clipboard hook now serves two items, and "Demo link copied" after copying a
  // chatbot key is worse than no confirmation at all.
  useEffect(() => {
    if (clipboard === 'idle') return;
    const what = copied.current;
    if (clipboard === 'copied') {
      toast.success(what === 'chatbot key' ? 'Chatbot key copied' : 'Demo link copied');
    } else if (clipboard === 'failed') {
      toast.error(`Could not copy the ${what}. Open it and copy it by hand.`);
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
          {bot.bot_key ? (
            <MenuItem
              icon={<KeyRound aria-hidden className="h-3.5 w-3.5" />}
              onSelect={copyBotKey}
            >
              Copy chatbot key
            </MenuItem>
          ) : null}
          {demoUrl || bot.bot_key ? <MenuSeparator /> : null}
          <MenuItem icon={<Pencil aria-hidden className="h-3.5 w-3.5" />} onSelect={openRename}>
            Rename…
          </MenuItem>
          {paused ? (
            <MenuItem
              icon={<Play aria-hidden className="h-3.5 w-3.5" />}
              onSelect={() => setResumeOpen(true)}
            >
              Resume chatbot…
            </MenuItem>
          ) : (
            <MenuItem
              icon={<Pause aria-hidden className="h-3.5 w-3.5" />}
              onSelect={() => setPauseOpen(true)}
            >
              Pause chatbot…
            </MenuItem>
          )}
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
          {/* The ambiguity is between two names, so it belongs on the field that
              sets one of them — not as a dialog description a reader meets
              before they know there is a second name at all. */}
          <Field
            label="Chatbot name"
            error={nameError}
            hint="Internal only — visitors see the display name in Experience."
            required
          >
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
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        title={`Pause ${name}?`}
        // Two facts, one clause each. It was 83 words across two paragraphs, and
        // a confirm dialog is read at the moment of highest impatience — nobody
        // reached the second paragraph, which is where the consequence that
        // actually costs money lived.
        description="It stops answering visitors immediately, and nothing is deleted. Pausing also frees its plan slot, so resuming has to pass the same check as a new chatbot."
        confirmLabel="Pause chatbot"
        onConfirm={confirmPause}
      />

      <ConfirmDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        title={`Resume ${name}?`}
        description="It answers visitors again on every site running its script, and counts against your plan from that moment. If the plan is full, nothing changes and we say so here."
        confirmLabel="Resume chatbot"
        onConfirm={confirmResume}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${name}?`}
        description="Deletes the chatbot, everything it learned, every conversation and every lead. Sites running its script stop showing a chatbot."
        confirmLabel="Delete chatbot"
        confirmPhrase={name}
        destructive
        onConfirm={confirmDelete}
      />
    </>
  );
}
