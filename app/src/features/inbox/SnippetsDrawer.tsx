import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  Alert,
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  Field,
  Input,
  Kbd,
  LoadingRows,
  Textarea,
  toast,
} from '../../ui';
import {
  createCannedResponse,
  deleteCannedResponse,
  updateCannedResponse,
} from '../../services/api';
import type { CannedResponse } from '../../types/domain';
import { useTranslation } from '../../i18n/useTranslation';

export interface SnippetsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snippets: CannedResponse[];
  loading: boolean;
  /** Refetch after a change, so the composer's `/` menu stays in step. */
  onChanged: () => void;
}

interface DraftState {
  id: number | null;
  title: string;
  shortcut: string;
  content: string;
}

const BLANK: DraftState = { id: null, title: '', shortcut: '', content: '' };

/** Shortcuts are typed after `/`, so the stored value never carries one. */
function normaliseShortcut(value: string): string {
  return value.trim().replace(/^\/+/, '').replace(/\s+/g, '-').toLowerCase();
}

/**
 * Saved replies, managed without leaving the conversation.
 *
 * These used to be a third tab in the inbox, which put a settings screen where
 * an operator expected a queue and meant editing one cost them the conversation
 * they were in the middle of. They are a tool of the composer, so they open from
 * it — the way Front, Intercom and Zendesk all landed on.
 */
export function SnippetsDrawer({ open, onOpenChange, snippets, loading, onChanged }: SnippetsDrawerProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<DraftState>(BLANK);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CannedResponse | null>(null);

  // Closing the drawer discards an unsaved draft rather than resurrecting it on
  // the next open, which would silently re-edit a snippet the operator had moved on from.
  useEffect(() => {
    if (open) return;
    setDraft(BLANK);
    setEditing(false);
    setError(null);
  }, [open]);

  async function save(): Promise<void> {
    const title = draft.title.trim();
    const content = draft.content.trim();
    if (!title || !content) {
      setError(t('inbox.aSavedReplyNeedsBoth') || 'A saved reply needs both a name and something to say.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const shortcut = normaliseShortcut(draft.shortcut);
      if (draft.id == null) {
        await createCannedResponse({ title, content, ...(shortcut ? { shortcut } : {}) });
        toast.success(t('inbox.savedReplyAdded') || 'Saved reply added');
      } else {
        await updateCannedResponse(draft.id, { title, content, shortcut: shortcut || null });
        toast.success(t('inbox.savedReplyUpdated') || 'Saved reply updated');
      }
      setDraft(BLANK);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? `Could not save: ${err.message}` : t('inbox.couldNotSaveThisReply') || 'Could not save this reply.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        // The title follows the body. It used to stay "Saved replies" with the
        // same description while the body had become an edit form for one
        // reply, so nothing on screen said which one was being edited.
        title={
          editing
            ? draft.id == null
              ? t('inbox.newSavedReply') || 'New saved reply'
              : `Edit “${draft.title.trim() || 'saved reply'}”`
            : t('inbox.savedReplies') || 'Saved replies'
        }
        description={
          editing
            ? undefined
            : t('inbox.typeInTheMessageBox') || 'Type / in the message box to drop one into a conversation. Use {name} and it becomes the visitor\'s first name.'
        }
        width="md"
        footer={
          editing ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(BLANK);
                  setEditing(false);
                  setError(null);
                }}
                disabled={saving}
              >
                {t('inbox.cancel') || 'Cancel'}
              </Button>
              <Button onClick={() => void save()} loading={saving} disabled={saving}>
                {draft.id == null ? t('inbox.addReply') || 'Add reply' : t('inbox.saveChanges') || 'Save changes'}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                setDraft(BLANK);
                setEditing(true);
              }}
            >
              <Plus aria-hidden />
              {t('inbox.newSavedReply') || 'New saved reply'}
            </Button>
          )
        }
      >
        {error ? (
          <Alert tone="danger" live className="mb-4">
            {error}
          </Alert>
        ) : null}

        {editing ? (
          <div className="space-y-4">
            <Field label={t('inbox.name') || 'Name'} required hint={t('inbox.whatYouWillRecogniseIt') || 'What you will recognise it by in the list.'}>
              <Input
                value={draft.title}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder={t('inbox.pricingQuestion') || 'Pricing question'}
              />
            </Field>
            {/* The one skippable field of the three, so it is the one that
                carries a marker — and it carries it beside the label rather
                than as the first word of its hint. See DESIGN.md rule 4. */}
            <Field
              label={t('inbox.shortcut') || 'Shortcut'}
              optional
              hint={t('inbox.typingPricingInTheMessage') || 'Typing /pricing in the message box finds it instantly.'}
            >
              <Input
                value={draft.shortcut}
                onChange={(event) => setDraft((current) => ({ ...current, shortcut: event.target.value }))}
                leading={<span className="figure text-text-tertiary">/</span>}
                placeholder={t('inbox.pricing') || 'pricing'}
              />
            </Field>
            <Field label={t('inbox.message') || 'Message'} required>
              <Textarea
                rows={6}
                value={draft.content}
                onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                placeholder={t('inbox.hiNameOurPlansStart') || 'Hi {name}, our plans start at…'}
              />
            </Field>
          </div>
        ) : loading ? (
          <LoadingRows rows={4} />
        ) : snippets.length === 0 ? (
          <EmptyState
            size="panel"
            title={t('inbox.noSavedRepliesYet') || 'No saved replies yet'}
            description={t('inbox.writeTheAnswersYourTeam') || 'Write the answers your team gives every day once, and reach them with a slash from any conversation.'}
          />
        ) : (
          <ul className="divide-y divide-border">
            {snippets.map((snippet) => (
              <li key={snippet.id} className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <p className="text-base font-medium text-text-primary">{snippet.title}</p>
                    {snippet.shortcut ? (
                      <Kbd>/{snippet.shortcut.replace(/^\//, '')}</Kbd>
                    ) : null}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-secondary">
                    {snippet.content}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Edit ${snippet.title}`}
                    onClick={() => {
                      setDraft({
                        id: snippet.id,
                        title: snippet.title,
                        shortcut: snippet.shortcut ?? '',
                        content: snippet.content,
                      });
                      setEditing(true);
                    }}
                  >
                    <Pencil aria-hidden />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${snippet.title}`}
                    onClick={() => setPendingDelete(snippet)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Drawer>

      <ConfirmDialog
        open={pendingDelete != null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title={pendingDelete ? `Delete “${pendingDelete.title}”?` : t('inbox.deleteThisReply') || 'Delete this reply?'}
        description={t('inbox.everyoneOnYourTeamLoses') || 'Everyone on your team loses this saved reply. Conversations where it was already sent are unaffected.'}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!pendingDelete) return;
          await deleteCannedResponse(pendingDelete.id);
          setPendingDelete(null);
          toast.success(t('inbox.savedReplyDeleted') || 'Saved reply deleted');
          onChanged();
        }}
      />
    </>
  );
}
