import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Dialog,
  EmptyState,
  LoadingRows,
  RadioCards,
  SearchField,
  buttonClass,
  toast,
  type RadioCardItem,
} from '../../ui';
import { getDepartments, getOperators, transferChat } from '../../services/api';
import type { Department, Operator } from '../../types/domain';
import { useTranslation } from '../../i18n/useTranslation';

export interface TransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  visitorName: string;
  /** The current owner, excluded from the list — you cannot transfer to yourself. */
  currentOperatorId: number | null;
  /** Called after the transfer lands, so the caller can drop the conversation. */
  onTransferred: () => void;
}

/**
 * A target, encoded so one radiogroup can hold both kinds.
 *
 * Two independent `role="radiogroup"`s held one value between them, which means
 * both could read as checked to a screen reader — and neither implemented the
 * arrow-key movement and roving tabindex the pattern requires, so walking past
 * twelve operators cost twelve tab presses.
 */
type TargetValue = `op:${number}` | `dept:${number}`;

function parseTarget(value: TargetValue): { to_operator_id: number } | { to_department_id: number } {
  const [kind, id] = value.split(':');
  return kind === 'op' ? { to_operator_id: Number(id) } : { to_department_id: Number(id) };
}

/** Online first, then whoever is carrying the least. */
function byAvailability(a: Operator, b: Operator): number {
  if (Boolean(a.is_online) !== Boolean(b.is_online)) return a.is_online ? -1 : 1;
  return (a.active_chats ?? 0) - (b.active_chats ?? 0);
}

function operatorLoad(operator: Operator): string {
  const active = operator.active_chats ?? 0;
  return operator.max_concurrent_chats && operator.max_concurrent_chats > 0
    ? `${active}/${operator.max_concurrent_chats} chats`
    : `${active} chats`;
}

/**
 * Hand this conversation to someone else.
 *
 * Operators are listed with their availability and current load, because
 * "transfer to Priya" is a decision about whether Priya can actually take it —
 * the previous dialog listed names alone, so a chat could be handed to someone
 * who was offline or already at their concurrency limit, and the visitor waited
 * in silence.
 *
 * One `RadioCards`, filtered by a search field: at thirty operators an
 * unfiltered list in a scrolling dialog is a hunt while a visitor waits.
 */
export function TransferDialog({
  open,
  onOpenChange,
  sessionId,
  visitorName,
  currentOperatorId,
  onTransferred,
}: TransferDialogProps) {
  const { t } = useTranslation();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<TargetValue | ''>('');
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    setTarget('');
    setQuery('');
    Promise.all([getOperators(), getDepartments()])
      .then(([ops, depts]) => {
        if (!active) return;
        setOperators(ops);
        setDepartments(depts);
      })
      .catch(() => {
        if (active) setError(t('inbox.couldNotLoadThePeople') || 'Could not load the people and departments you can transfer to.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, sessionId, t]);

  const candidates = useMemo(
    () =>
      operators
        .filter((operator) => operator.id !== currentOperatorId && operator.is_active !== false)
        .sort(byAvailability),
    [operators, currentOperatorId],
  );

  const options = useMemo<RadioCardItem<TargetValue>[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = (name: string) => needle === '' || name.toLowerCase().includes(needle);
    return [
      ...candidates
        .filter((operator) => matches(operator.name))
        .map<RadioCardItem<TargetValue>>((operator) => ({
          value: `op:${operator.id}`,
          label: operator.name,
          description: `${operator.is_online ? t('inbox.online') || 'Online' : t('inbox.offline') || 'Offline'} · ${operatorLoad(operator)}`,
        })),
      ...departments
        .filter((department) => matches(department.name))
        .map<RadioCardItem<TargetValue>>((department) => ({
          value: `dept:${department.id}`,
          label: department.name,
          description: department.description ?? (t('inbox.aDepartmentNotOnePerson') || 'A department, not one person'),
        })),
    ];
  }, [candidates, departments, query, t]);

  const nobody = candidates.length === 0 && departments.length === 0;

  async function submit(): Promise<void> {
    if (!target || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await transferChat(sessionId, parseTarget(target));
      toast.success(t('inbox.conversationTransferred') || 'Conversation transferred', {
        description:
          t('inbox.isNowWithThePersonYouChose', { name: visitorName }) ||
          `${visitorName} is now with the person you chose.`,
      });
      onTransferred();
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof Error
          ? t('inbox.couldNotTransferReason', { reason: err.message }) ||
            `Could not transfer: ${err.message}`
          : t('inbox.couldNotTransferThisConversation') || 'Could not transfer this conversation.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('inbox.transferConversation') || 'Transfer conversation'}
      description={
        t('inbox.willBeToldTheyAreBeingConnected', { name: visitorName }) ||
        `${visitorName} will be told they are being connected to someone else.`
      }
      dismissible={!submitting}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('inbox.cancel') || 'Cancel'}
          </Button>
          <Button onClick={() => void submit()} disabled={!target || submitting} loading={submitting}>
            {t('inbox.transfer') || 'Transfer'}
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}

      {loading ? (
        <LoadingRows rows={4} />
      ) : nobody ? (
        // One answer to one condition. It used to say both "Nobody else is set
        // up as an operator yet" and "Invite a teammate from Settings → Team".
        <EmptyState
          size="panel"
          title={t('inbox.nobodyToTransferTo') || 'Nobody to transfer to'}
          description={t('inbox.inviteATeammateFromSettings') || 'Invite a teammate from Settings → Team, or create a department, before you can hand a conversation over.'}
          action={
            <Link to="/settings/team" className={buttonClass('primary', 'sm')}>
              {t('inbox.inviteATeammate') || 'Invite a teammate'}
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          <SearchField
            size="sm"
            label={t('inbox.searchPeopleAndDepartments2') || 'Search people and departments'}
            placeholder={t('inbox.searchPeopleAndDepartments') || 'Search people and departments…'}
            value={query}
            onValueChange={setQuery}
          />
          {options.length === 0 ? (
            <EmptyState
              size="inline"
              title={t('inbox.nothingMatched') || 'Nothing matched'}
              description={
                t('inbox.noPersonOrDepartmentMatches', { query }) ||
                `No person or department matches “${query}”.`
              }
              action={
                <Button size="sm" variant="secondary" onClick={() => setQuery('')}>
                  {t('inbox.clearSearch') || 'Clear search'}
                </Button>
              }
            />
          ) : (
            <RadioCards<TargetValue>
              label={t('inbox.transferTo') || 'Transfer to'}
              items={options}
              value={target as TargetValue}
              onChange={setTarget}
            />
          )}
        </div>
      )}
    </Dialog>
  );
}
