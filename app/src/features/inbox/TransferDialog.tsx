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
        if (active) setError('Could not load the people and departments you can transfer to.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, sessionId]);

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
          description: `${operator.is_online ? 'Online' : 'Offline'} · ${operatorLoad(operator)}`,
        })),
      ...departments
        .filter((department) => matches(department.name))
        .map<RadioCardItem<TargetValue>>((department) => ({
          value: `dept:${department.id}`,
          label: department.name,
          description: department.description ?? 'A department, not one person',
        })),
    ];
  }, [candidates, departments, query]);

  const nobody = candidates.length === 0 && departments.length === 0;

  async function submit(): Promise<void> {
    if (!target || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await transferChat(sessionId, parseTarget(target));
      toast.success('Conversation transferred', {
        description: `${visitorName} is now with the person you chose.`,
      });
      onTransferred();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? `Could not transfer: ${err.message}` : 'Could not transfer this conversation.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Transfer conversation"
      description={`${visitorName} will be told they are being connected to someone else.`}
      dismissible={!submitting}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!target || submitting} loading={submitting}>
            Transfer
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
          title="Nobody to transfer to"
          description="Invite a teammate from Settings → Team, or create a department, before you can hand a conversation over."
          action={
            <Link to="/settings/team" className={buttonClass('primary', 'sm')}>
              Invite a teammate
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          <SearchField
            size="sm"
            label="Search people and departments"
            placeholder="Search people and departments…"
            value={query}
            onValueChange={setQuery}
          />
          {options.length === 0 ? (
            <EmptyState
              size="inline"
              title="Nothing matched"
              description={`No person or department matches “${query}”.`}
              action={
                <Button size="sm" variant="secondary" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <RadioCards<TargetValue>
              label="Transfer to"
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
