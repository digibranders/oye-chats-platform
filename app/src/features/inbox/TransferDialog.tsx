import { useEffect, useMemo, useState } from 'react';
import { Building2, User } from 'lucide-react';
import { Alert, Avatar, Button, Dialog, LoadingRows, StatusDot, cn, toast } from '../../ui';
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

type Target = { kind: 'operator'; id: number } | { kind: 'department'; id: number };

function sameTarget(a: Target | null, b: Target): boolean {
  return a?.kind === b.kind && a.id === b.id;
}

/**
 * Hand this conversation to someone else.
 *
 * Operators are listed with their availability and current load, because
 * "transfer to Priya" is a decision about whether Priya can actually take it —
 * the previous dialog listed names alone, so a chat could be handed to someone
 * who was offline or already at their concurrency limit, and the visitor waited
 * in silence.
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
  const [target, setTarget] = useState<Target | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    setTarget(null);
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
    () => operators.filter((operator) => operator.id !== currentOperatorId && operator.is_active !== false),
    [operators, currentOperatorId],
  );

  async function submit(): Promise<void> {
    if (!target || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await transferChat(
        sessionId,
        target.kind === 'operator' ? { to_operator_id: target.id } : { to_department_id: target.id },
      );
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
      ) : (
        <div className="space-y-5">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-eyebrow text-text-tertiary">
              People
            </h3>
            {candidates.length === 0 ? (
              <p className="text-xs text-text-secondary">
                Nobody else is set up as an operator on this workspace yet.
              </p>
            ) : (
              <div role="radiogroup" aria-label="Transfer to a person" className="space-y-1.5">
                {candidates.map((operator) => {
                  const option: Target = { kind: 'operator', id: operator.id };
                  const selected = sameTarget(target, option);
                  const load =
                    operator.max_concurrent_chats && operator.max_concurrent_chats > 0
                      ? `${operator.active_chats ?? 0}/${operator.max_concurrent_chats} chats`
                      : `${operator.active_chats ?? 0} chats`;
                  return (
                    <button
                      key={operator.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setTarget(option)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left',
                        selected
                          ? 'border-accent-500 bg-accent-50'
                          : 'border-border bg-surface hover:bg-surface-hover',
                      )}
                    >
                      <Avatar size="sm" name={operator.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base text-text-primary">{operator.name}</span>
                        <span className="figure block text-2xs text-text-tertiary">{load}</span>
                      </span>
                      <StatusDot
                        tone={operator.is_online ? 'success' : 'neutral'}
                        pulse={operator.is_online}
                        label={operator.is_online ? 'Online' : 'Offline'}
                      />
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {departments.length > 0 ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-eyebrow text-text-tertiary">
                Departments
              </h3>
              <div role="radiogroup" aria-label="Transfer to a department" className="space-y-1.5">
                {departments.map((department) => {
                  const option: Target = { kind: 'department', id: department.id };
                  const selected = sameTarget(target, option);
                  return (
                    <button
                      key={department.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setTarget(option)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left',
                        selected
                          ? 'border-accent-500 bg-accent-50'
                          : 'border-border bg-surface hover:bg-surface-hover',
                      )}
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-xs bg-surface-sunken">
                        <Building2 aria-hidden className="h-3.5 w-3.5 text-text-tertiary" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base text-text-primary">{department.name}</span>
                        {department.description ? (
                          <span className="block truncate text-2xs text-text-tertiary">
                            {department.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {candidates.length === 0 && departments.length === 0 ? (
            <p className="flex items-center gap-2 text-xs text-text-secondary">
              <User aria-hidden className="h-3.5 w-3.5" />
              Invite a teammate from Settings → Team before you can transfer conversations.
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
