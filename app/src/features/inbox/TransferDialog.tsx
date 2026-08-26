import { useEffect, useState, type ReactElement } from 'react';
import { ArrowRightLeft, Building2, User } from 'lucide-react';
import { Button, Modal, Skeleton, cn } from '../../design-system';
import { getDepartments, getOperators, transferChat } from '../../services/api';
import type { Department, Operator } from '../../types/domain';
import { initials } from './liveChatHelpers';
// `translateNow` inside effects and async handlers: the hook's `t` changes
// identity per locale, so capturing it there adds a dependency that would
// re-run a data load on every language change. The module-level function is
// stable and still resolves against the current locale when called.
import { t as translateNow } from '../../i18n/i18n';
import { useTranslation } from '../../i18n/useTranslation';

export interface TransferDialogProps {
  sessionId: string;
  visitorName: string;
  /** Current owner - excluded from the operator target list. */
  currentOperatorId: number | null;
  onClose: () => void;
  /** Called after a successful transfer so the caller can drop the chat locally. */
  onTransferred: () => void;
}

type Target = { kind: 'operator'; id: number } | { kind: 'department'; id: number };

/**
 * TransferDialog - hand the active conversation to another online operator or a
 * department. Targets load from `getOperators` / `getDepartments`; the transfer
 * itself goes through the typed `transferChat` REST wrapper. The backend emits
 * `chat_transferred` over WS, which removes the chat from this operator's board.
 */
export function TransferDialog({
  sessionId,
  visitorName,
  currentOperatorId,
  onClose,
  onTransferred,
}: TransferDialogProps): ReactElement {
  const { t } = useTranslation();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<Target | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mounted fresh each time the dialog opens (the parent renders it only while
  // open), so the targets load once here - no synchronous setState in the effect.
  useEffect(() => {
    let active = true;
    Promise.all([getOperators(), getDepartments()])
      .then(([ops, depts]) => {
        if (!active) return;
        setOperators(ops);
        setDepartments(depts);
      })
      .catch(() => {
        if (!active) return;
        setError(translateNow('inbox.couldntLoadTransferTargets') || 'Couldn’t load transfer targets.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  const eligibleOperators = operators.filter(
    (op) => op.id !== currentOperatorId && op.is_active !== false && op.is_online,
  );

  const submit = async (): Promise<void> => {
    if (!target || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await transferChat(
        sessionId,
        target.kind === 'operator' ? { target_operator_id: target.id } : { target_department_id: target.id },
      );
      onTransferred();
    } catch (err) {
      setError(
        err instanceof Error ? (translateNow('inbox.transferFailedDetail', { reason: err.message }) || `Transfer failed: ${err.message}`) : t('inbox.transferFailedPleaseTryAgain') || 'Transfer failed. Please try again.',
      );
      setSubmitting(false);
    }
  };

  const isSelected = (kind: Target['kind'], id: number): boolean =>
    target?.kind === kind && target.id === id;

  return (
    <Modal
      open
      onClose={onClose}
      title={t('inbox.transferConversation') || 'Transfer conversation'}
      description={
          t('inbox.handToOperator', { name: visitorName }) ||
          `Hand ${visitorName} to an operator or department.`
        }
      size="sm"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {t('inbox.cancel') || 'Cancel'}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={!target || submitting}>
            <ArrowRightLeft size={14} aria-hidden="true" />
            {submitting ? t('inbox.transferring') || 'Transferring…' : t('inbox.transfer') || 'Transfer'}
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : (
        <div className="space-y-4">
          {error && (
            <p role="alert" className="text-[13px] text-[var(--ds-danger)]">
              {error}
            </p>
          )}

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
              {t('inbox.onlineOperators') || 'Online operators'}
            </p>
            {eligibleOperators.length === 0 ? (
              <p className="text-[13px] text-[var(--ds-text-muted)]">{t('inbox.noOtherOperatorsAreOnline') || 'No other operators are online right now.'}</p>
            ) : (
              <div className="space-y-1.5">
                {eligibleOperators.map((op) => (
                  <button
                    key={op.id}
                    type="button"
                    onClick={() => setTarget({ kind: 'operator', id: op.id })}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-[var(--ds-radius-lg)] border px-3 py-2 text-left transition-colors',
                      isSelected('operator', op.id)
                        ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
                        : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)] hover:bg-[var(--ds-bg-hover)]',
                    )}
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[11px] font-semibold text-[var(--ds-text-muted)]">
                      {initials(op.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-[var(--ds-text)]">{op.name}</span>
                      <span className="block text-[11px] text-[var(--ds-text-muted)]">
                        {t('inbox.activeChats', { count: op.active_chats ?? 0 }) ||
                          `${op.active_chats ?? 0} active`}
                      </span>
                    </span>
                    <User size={14} className="text-[var(--ds-text-subtle)]" aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {departments.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
                {t('inbox.departments') || 'Departments'}
              </p>
              <div className="space-y-1.5">
                {departments.map((dept) => (
                  <button
                    key={dept.id}
                    type="button"
                    onClick={() => setTarget({ kind: 'department', id: dept.id })}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-[var(--ds-radius-lg)] border px-3 py-2 text-left transition-colors',
                      isSelected('department', dept.id)
                        ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
                        : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)] hover:bg-[var(--ds-bg-hover)]',
                    )}
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)]">
                      <Building2 size={14} aria-hidden="true" />
                    </span>
                    <span className="truncate text-[13px] font-medium text-[var(--ds-text)]">{dept.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
