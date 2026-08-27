/**
 * CannedResponsesPanel - manage the team's reusable quick replies (CRUD).
 *
 * Rebuilt from the legacy `pages/CannedResponses.jsx`, whose management surface
 * was dropped in the rebuild: Admin 2.0 only *consumed* canned responses (as
 * offline-reply templates) with no way to author or maintain them. Lives on the
 * Inbox "Quick replies" tab because that's where operators use them; the parent
 * gates the whole tab behind the `live_chat` feature, so this panel assumes
 * access.
 *
 * Backend reused verbatim (typed in services/api.d.ts): getCannedResponses,
 * createCannedResponse, updateCannedResponse, deleteCannedResponse. Delete uses
 * the app's inline two-step confirm (no global ConfirmProvider is mounted).
 */
import { type FormEvent, type ReactElement, useEffect, useMemo, useState } from 'react';
import { MessageSquareText, Pencil, Plus, Search, Tag, Trash2 } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  FeedbackBanner,
  Input,
  Modal,
  SectionHeader,
  Select,
  Skeleton,
  Textarea,
  useFeedback,
} from '../../design-system';
import {
  createCannedResponse,
  deleteCannedResponse,
  getCannedResponses,
  updateCannedResponse,
} from '../../services/api';
import { type CannedResponse } from '../../types/domain';
// `translateNow` inside effects and async handlers: the hook's `t` changes
// identity per locale, so capturing it there adds a dependency that would
// re-run a data load on every language change. The module-level function is
// stable and still resolves against the current locale when called.
import { t as translateNow } from '../../i18n/i18n';
import { useTranslation } from '../../i18n/useTranslation';

interface ReplyForm {
  title: string;
  content: string;
  shortcut: string;
  category: string;
}

const EMPTY_FORM: ReplyForm = { title: '', content: '', shortcut: '', category: '' };

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}

export function CannedResponsesPanel(): ReactElement {
  const { t } = useTranslation();
  const [responses, setResponses] = useState<CannedResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CannedResponse | null>(null);
  const [form, setForm] = useState<ReplyForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const [removingId, setRemovingId] = useState<number | null>(null);
  const [rowBusyId, setRowBusyId] = useState<number | null>(null);
  const { feedback, notify, dismiss } = useFeedback();

  // Load (re-runs when the category filter changes - the backend scopes by it).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    void (async () => {
      try {
        const data = await getCannedResponses(categoryFilter || null);
        if (!cancelled) setResponses(data.responses ?? []);
      } catch (error) {
        if (!cancelled) setLoadError(toMessage(error, translateNow('inbox.weCouldntLoadYourQuick') || 'We couldn’t load your quick replies.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [categoryFilter, reloadKey]);

  const reload = (): void => setReloadKey((k) => k + 1);

  const categories = useMemo(
    () => [...new Set(responses.map((r) => r.category).filter((c): c is string => Boolean(c)))],
    [responses],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return responses;
    return responses.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.content.toLowerCase().includes(q) ||
        (r.shortcut ?? '').toLowerCase().includes(q),
    );
  }, [responses, search]);

  const openCreate = (): void => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setModalOpen(true);
  };

  const openEdit = (response: CannedResponse): void => {
    setEditing(response);
    setForm({
      title: response.title,
      content: response.content,
      shortcut: response.shortcut ?? '',
      category: response.category ?? '',
    });
    setFormError('');
    setModalOpen(true);
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      setFormError(t('inbox.titleAndContentAreBoth') || 'Title and content are both required.');
      return;
    }
    setSubmitting(true);
    setFormError('');
    const shortcut = form.shortcut.trim();
    const category = form.category.trim() || null;
    try {
      if (editing) {
        // Update takes a partial patch; send explicit null to CLEAR a field.
        await updateCannedResponse(editing.id, { title, content, shortcut: shortcut || null, category });
      } else {
        // Create's typed shape wants `shortcut?: string` (omit when empty).
        await createCannedResponse({ title, content, category, ...(shortcut ? { shortcut } : {}) });
      }
      setModalOpen(false);
      notify({ tone: 'success', message: editing ? t('inbox.quickReplyUpdated') || 'Quick reply updated.' : t('inbox.quickReplyCreated') || 'Quick reply created.' });
      reload();
    } catch (error) {
      setFormError(toMessage(error, t('inbox.failedToSaveTheQuick') || 'Failed to save the quick reply.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (response: CannedResponse): Promise<void> => {
    dismiss();
    setRowBusyId(response.id);
    try {
      await deleteCannedResponse(response.id);
      setRemovingId(null);
      notify({ tone: 'success', message: `“${response.title}” deleted.` });
      reload();
    } catch (error) {
      notify({ tone: 'error', message: toMessage(error, t('inbox.failedToDeleteTheQuick') || 'Failed to delete the quick reply.') });
    } finally {
      setRowBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <SectionHeader
        title={t('inbox.quickReplies') || 'Quick replies'}
        description={t('inbox.reusableCannedResponsesYourTeam') || 'Reusable canned responses your team can insert during a conversation.'}
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus size={15} aria-hidden="true" />
            {t('inbox.addReply') || 'Add reply'}
          </Button>
        }
      />

      <FeedbackBanner feedback={feedback} onDismiss={dismiss} />

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('inbox.searchReplies') || 'Search replies…'}
            className="pl-9"
            aria-label={t('inbox.searchQuickReplies') || 'Search quick replies'}
          />
        </div>
        {categories.length > 0 && (
          <Select
            value={categoryFilter}
            onChange={setCategoryFilter}
            aria-label={t('inbox.filterByCategory') || 'Filter by category'}
            placeholder={t('inbox.allCategories') || 'All categories'}
            className="sm:w-48"
            options={[
              { value: '', label: t('inbox.allCategories') || 'All categories' },
              ...categories.map((cat) => ({ value: cat, label: cat })),
            ]}
          />
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-3" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : loadError ? (
        <EmptyState
          icon={MessageSquareText}
          title={t('inbox.couldntLoadQuickReplies') || 'Couldn’t load quick replies'}
          description={loadError}
          action={
            <Button variant="outline" onClick={reload}>
              {t('inbox.tryAgain') || 'Try again'}
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          title={responses.length === 0 ? t('inbox.noQuickRepliesYet') || 'No quick replies yet' : t('inbox.noRepliesMatchYourSearch') || 'No replies match your search'}
          description={
            responses.length === 0
              ? t('inbox.createReusableRepliesYourTeam') || 'Create reusable replies your team can drop into a conversation in one click.'
              : t('inbox.tryADifferentSearchTerm') || 'Try a different search term or category.'
          }
          action={
            responses.length === 0 ? (
              <Button onClick={openCreate}>
                <Plus size={15} aria-hidden="true" />
                {t('inbox.addYourFirstReply') || 'Add your first reply'}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((response) => (
            <Card key={response.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <h3 className="text-[13px] font-semibold text-[var(--ds-text)]">{response.title}</h3>
                    {response.shortcut && (
                      <span className="rounded bg-[var(--ds-bg-sunken)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ds-text-muted)]">
                        /{response.shortcut}
                      </span>
                    )}
                    {response.category && (
                      <span className="inline-flex items-center gap-1 rounded bg-[var(--ds-accent-soft)] px-1.5 py-0.5 text-[11px] text-[var(--ds-accent-text)]">
                        <Tag size={11} aria-hidden="true" />
                        {response.category}
                      </span>
                    )}
                  </div>
                  <p className="line-clamp-2 text-[13px] text-[var(--ds-text-muted)]">{response.content}</p>
                </div>

                {removingId === response.id ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={rowBusyId === response.id}
                      onClick={() => void handleDelete(response)}
                    >
                      {rowBusyId === response.id ? t('inbox.deleting') || 'Deleting…' : t('inbox.delete') || 'Delete'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRemovingId(null)}>
                      {t('inbox.cancel') || 'Cancel'}
                    </Button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(response)}
                      aria-label={`Edit ${response.title}`}
                      className="rounded p-1.5 text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-bg-sunken)] hover:text-[var(--ds-text)]"
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        dismiss();
                        setRemovingId(response.id);
                      }}
                      aria-label={`Delete ${response.title}`}
                      className="rounded p-1.5 text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-danger-soft)] hover:text-[var(--ds-danger)]"
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create / edit */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        dismissible={!submitting}
        size="lg"
        title={editing ? t('inbox.editQuickReply') || 'Edit quick reply' : t('inbox.newQuickReply') || 'New quick reply'}
        description={t('inbox.savedRepliesAreSharedWith') || 'Saved replies are shared with everyone on your team.'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={submitting}>
              {t('inbox.cancel') || 'Cancel'}
            </Button>
            <Button type="submit" form="canned-response-form" disabled={submitting}>
              {submitting ? t('inbox.saving') || 'Saving…' : editing ? t('inbox.update') || 'Update' : t('inbox.create') || 'Create'}
            </Button>
          </>
        }
      >
        <form id="canned-response-form" onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]">{t('inbox.title') || 'Title'}</span>
            <Input
              value={form.title}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              placeholder={t('inbox.eGGreeting') || 'e.g. Greeting'}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]">{t('inbox.content') || 'Content'}</span>
            <Textarea
              value={form.content}
              onChange={(e) => setForm((prev) => ({ ...prev, content: e.target.value }))}
              placeholder={t('inbox.theMessageThatGetsInserted') || 'The message that gets inserted…'}
              rows={4}
            />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]">
                {t('inbox.shortcut') || 'Shortcut'}
              </span>
              <div className="flex items-center">
                <span className="flex h-10 items-center rounded-l-[var(--ds-radius-lg)] border border-r-0 border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-2.5 text-sm text-[var(--ds-text-subtle)]">
                  /
                </span>
                <Input
                  value={form.shortcut}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, shortcut: e.target.value.replace(/\s/g, '') }))
                  }
                  placeholder={t('inbox.greeting') || 'greeting'}
                  className="rounded-l-none"
                />
              </div>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]">
                {t('inbox.category') || 'Category'}
              </span>
              <Input
                value={form.category}
                onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
                placeholder={t('inbox.eGSalesSupport') || 'e.g. Sales, Support'}
              />
            </label>
          </div>
          {formError && (
            <p role="alert" className="text-[12px] text-[var(--ds-danger)]">
              {formError}
            </p>
          )}
        </form>
      </Modal>
    </div>
  );
}
