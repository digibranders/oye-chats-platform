import { type FormEvent, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Check,
  Headphones,
  Mail,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  UserPlus,
  Users,
  UserRound,
  X,
} from 'lucide-react';
import {
  Button,
  DataTable,
  EmptyState,
  Input,
  MetricCard,
  PageContainer,
  QuotaMeter,
  SectionHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  cn,
  type Column,
} from '../../design-system';
import {
  addSelfAsOperator,
  createDepartment,
  createOperatorInvite,
  deleteDepartment,
  deleteOperator,
  getCurrentUser,
  getDepartments,
  getOperators,
  listOperatorInvites,
  resendOperatorInvite,
  revokeOperatorInvite,
  updateOperator,
} from '../../services/api';
import { useBotContext } from '../../context/BotContext';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import { type Department, type Operator, type OperatorInvite } from '../../types/domain';

// ── Local helpers ────────────────────────────────────────────────────────────

/**
 * Some legacy list endpoints return a `{ key: [...] }` envelope while others
 * return the bare array. Normalize both at this boundary so the page never
 * cares which shape the runtime hands back.
 */
function unwrapList<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  // en-GB → DD/MM/YYYY, unambiguous for a primarily-Indian audience.
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

type RoleTone = 'accent' | 'info' | 'neutral';
const ROLE_TONE: Record<string, RoleTone> = { owner: 'accent', admin: 'info', operator: 'neutral' };

const INVITE_ROLES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'operator', label: 'Operator' },
  { value: 'admin', label: 'Admin' },
];

/** Fields an admin may change on another member. Name/email are self-only. */
const EDITABLE_ROLES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'operator', label: 'Operator' },
  { value: 'admin', label: 'Admin' },
  { value: 'owner', label: 'Owner' },
];

const selectClass =
  'h-10 w-full rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 text-sm text-[var(--ds-text)] outline-none transition-colors focus-visible:border-[var(--ds-accent)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]';
const labelClass = 'mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]';

// ── Data loading state machine ───────────────────────────────────────────────

interface TeamData {
  operators: Operator[];
  departments: Department[];
  invites: OperatorInvite[];
  currentUserId: number | null;
}

type LoadPhase =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly data: TeamData };

type Feedback = { readonly tone: 'success' | 'error'; readonly message: string };
type TabKey = 'people' | 'departments';

// ── Small presentational pieces ──────────────────────────────────────────────

function Avatar({ name }: { name: string }): ReactElement {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ds-accent-soft)] text-[12px] font-bold text-[var(--ds-accent-text)]"
    >
      {initial}
    </span>
  );
}

function PresenceBadge({ online }: { online: boolean }): ReactElement {
  return (
    <StatusBadge tone={online ? 'success' : 'neutral'} dot>
      {online ? 'Online' : 'Offline'}
    </StatusBadge>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * MembersPage — the Workspace ▸ Members surface. One job: answer
 * "Who is on my team?". Shows the roster (roles, presence, department),
 * pending invitations, and the departments that group members. Invite,
 * edit-role, remove, and department create/delete are wired against the
 * reused operator/department/invite backend.
 */
export function MembersPage(): ReactElement {
  const { selectedBot } = useBotContext();
  const { currentRole } = useWorkspace();
  // A member acting purely as an operator can't manage the team; owners/admins
  // (and the solo-owner case where role is still null) can.
  const canManage = currentRole !== 'operator';
  const selectedBotId = selectedBot?.id ?? null;

  const { entitlements, limitFor, withinLimit } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();
  const seatLimit = limitFor('operators');

  const [phase, setPhase] = useState<LoadPhase>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [tab, setTab] = useState<TabKey>('people');

  // Mirror the latest committed phase so the async loader can tell an initial
  // load (nothing on screen yet) from a background refresh (roster already
  // rendered) without depending on a stale closure.
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Feedback is scoped to the selected agent's roster — drop it the moment the
  // agent changes so a stale message never bleeds across contexts. Render-time
  // state adjustment (the React-sanctioned reset pattern), guarded to run once
  // per change so it can't loop.
  const [feedbackBotId, setFeedbackBotId] = useState(selectedBotId);
  if (feedbackBotId !== selectedBotId) {
    setFeedbackBotId(selectedBotId);
    setFeedback(null);
  }

  // Success toasts are transient confirmations; auto-dismiss them so they don't
  // linger while the user moves on. Errors persist until dismissed or replaced.
  useEffect(() => {
    if (feedback?.tone !== 'success') return;
    const timer = window.setTimeout(() => setFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  // Invite form
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('operator');
  const [inviteDept, setInviteDept] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);

  // Edit member
  const [editing, setEditing] = useState<Operator | null>(null);
  const [editRole, setEditRole] = useState('operator');
  const [editDept, setEditDept] = useState('');
  const [editMaxChats, setEditMaxChats] = useState('3');
  const [editBusy, setEditBusy] = useState(false);

  // `editMaxChats` is the raw string from a number input: clearing it yields ''
  // (Number('') === 0, an operator that can never be routed a live chat) and it
  // does not enforce the documented [1, 20] cap. Parse + validate before we let
  // the operator be saved.
  const maxChats = Number.parseInt(editMaxChats, 10);
  const maxChatsValid = Number.isInteger(maxChats) && maxChats >= 1 && maxChats <= 20;

  // Row-level busy / confirm
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [rowBusyId, setRowBusyId] = useState<number | null>(null);
  const [selfBusy, setSelfBusy] = useState(false);

  // Departments
  const [deptOpen, setDeptOpen] = useState(false);
  const [deptName, setDeptName] = useState('');
  const [deptDesc, setDeptDesc] = useState('');
  const [deptBusy, setDeptBusy] = useState(false);
  const [deptRemovingId, setDeptRemovingId] = useState<number | null>(null);
  const [deptRowBusyId, setDeptRowBusyId] = useState<number | null>(null);

  // Load / reload. No synchronous setState in the effect body — the first
  // setState always follows an await, so `loading` is a genuine derived phase.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [opsRes, deptRes, inviteRes, user] = await Promise.all([
          getOperators(),
          getDepartments(),
          // Non-fatal: operators without a client identity can't list invites.
          listOperatorInvites('pending').catch(() => [] as OperatorInvite[]),
          getCurrentUser().catch(() => null),
        ]);
        if (!active) return;
        setPhase({
          status: 'ready',
          data: {
            operators: unwrapList<Operator>(opsRes, 'operators'),
            departments: unwrapList<Department>(deptRes, 'departments'),
            invites: unwrapList<OperatorInvite>(inviteRes, 'invites'),
            currentUserId: user ? user.id : null,
          },
        });
      } catch (error) {
        if (!active) return;
        // A background refresh (fired after a successful mutation) must not blow
        // away the roster the user is already looking at. Only hard-fail to the
        // full-page error state on the initial load / explicit retry; on a
        // background flake keep the last-good data and surface the failure as a
        // non-destructive banner.
        if (phaseRef.current.status === 'ready') {
          setFeedback({
            tone: 'error',
            message: toMessage(
              error,
              'We couldn’t refresh your team — showing the last loaded data.',
            ),
          });
        } else {
          setPhase({
            status: 'error',
            message: toMessage(error, 'We couldn’t load your team. Please try again.'),
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshToken]);

  const reload = (): void => setRefreshToken((token) => token + 1);
  const retry = (): void => {
    setPhase({ status: 'loading' });
    reload();
  };

  const data = phase.status === 'ready' ? phase.data : null;

  // Workspace-wide seat usage. `getOperators()` (above) already fetches every
  // active operator for the client — not just this bot's roster — so its
  // length matches what `entitlements.usage.operators` counts server-side.
  // Prefer the entitlements value (authoritative, workspace-scoped); fall
  // back to what the page already loaded only if it's ever absent.
  const seatsUsed = entitlements.usage.operators ?? data?.operators.length ?? 0;
  const atSeatLimit = !withinLimit('operators', seatsUsed);

  // Derived, bot-scoped rosters. Operators and invites are bound to a single
  // bot; departments are workspace-level and shown in full.
  const botOperators = useMemo(
    () =>
      data && selectedBotId
        ? data.operators.filter((operator) => operator.bot_id === selectedBotId)
        : [],
    [data, selectedBotId],
  );
  const botInvites = useMemo(
    () =>
      data && selectedBotId
        ? data.invites.filter((invite) => invite.bot_id === selectedBotId)
        : [],
    [data, selectedBotId],
  );
  const departments = data?.departments ?? [];

  const departmentName = (id: number | null | undefined): string =>
    departments.find((department) => department.id === id)?.name ?? '—';

  // The current owner acting as an operator on the selected bot, if any.
  const selfOperator = useMemo(() => {
    if (!data || data.currentUserId == null) return null;
    return botOperators.find((operator) => operator.linked_client_id === data.currentUserId) ?? null;
  }, [data, botOperators]);
  const showSelfCta = canManage && !!selectedBotId && data?.currentUserId != null && !selfOperator;

  const onlineCount = botOperators.filter((operator) => operator.is_online).length;

  // ── Mutations ──────────────────────────────────────────────────────────────

  const handleInvite = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!selectedBotId) return;
    setFeedback(null);
    setInviteBusy(true);
    try {
      await createOperatorInvite({
        email: inviteEmail.trim(),
        botId: selectedBotId,
        role: inviteRole,
        departmentId: inviteDept ? Number(inviteDept) : null,
      });
      setFeedback({ tone: 'success', message: `Invitation sent to ${inviteEmail.trim()}.` });
      setInviteOpen(false);
      setInviteEmail('');
      setInviteRole('operator');
      setInviteDept('');
      reload();
    } catch (error) {
      setFeedback({ tone: 'error', message: toMessage(error, 'Failed to send the invitation.') });
    } finally {
      setInviteBusy(false);
    }
  };

  const handleResend = async (invite: OperatorInvite): Promise<void> => {
    setFeedback(null);
    setRowBusyId(invite.id);
    try {
      await resendOperatorInvite(invite.id);
      setFeedback({ tone: 'success', message: `Invitation to ${invite.email} resent.` });
      reload();
    } catch (error) {
      setFeedback({ tone: 'error', message: toMessage(error, 'Failed to resend the invitation.') });
    } finally {
      setRowBusyId(null);
    }
  };

  const handleRevoke = async (invite: OperatorInvite): Promise<void> => {
    setFeedback(null);
    setRowBusyId(invite.id);
    try {
      await revokeOperatorInvite(invite.id);
      setFeedback({ tone: 'success', message: `Invitation to ${invite.email} revoked.` });
      reload();
    } catch (error) {
      setFeedback({ tone: 'error', message: toMessage(error, 'Failed to revoke the invitation.') });
    } finally {
      setRowBusyId(null);
    }
  };

  const openEdit = (operator: Operator): void => {
    setEditing(operator);
    setEditRole(operator.role);
    setEditDept(operator.department_id != null ? String(operator.department_id) : '');
    setEditMaxChats(String(operator.max_concurrent_chats ?? 3));
    setRemovingId(null);
  };

  const handleSaveEdit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!editing || !maxChatsValid) return;
    setFeedback(null);
    setEditBusy(true);
    try {
      await updateOperator(editing.id, {
        role: editRole,
        department_id: editDept ? Number(editDept) : null,
        max_concurrent_chats: maxChats,
      });
      setFeedback({ tone: 'success', message: `${editing.name} updated.` });
      setEditing(null);
      reload();
    } catch (error) {
      setFeedback({ tone: 'error', message: toMessage(error, 'Failed to update this member.') });
    } finally {
      setEditBusy(false);
    }
  };

  const handleRemove = async (operator: Operator): Promise<void> => {
    setFeedback(null);
    setRowBusyId(operator.id);
    try {
      await deleteOperator(operator.id);
      setFeedback({ tone: 'success', message: `${operator.name} removed from the team.` });
      setRemovingId(null);
      if (editing?.id === operator.id) setEditing(null);
      reload();
    } catch (error) {
      setFeedback({ tone: 'error', message: toMessage(error, 'Failed to remove this member.') });
    } finally {
      setRowBusyId(null);
    }
  };

  const handleSelfJoin = async (): Promise<void> => {
    if (!selectedBotId) return;
    setFeedback(null);
    setSelfBusy(true);
    try {
      await addSelfAsOperator(selectedBotId);
      setFeedback({ tone: 'success', message: 'You’re now taking live chats on this agent.' });
      reload();
    } catch (error) {
      setFeedback({ tone: 'error', message: toMessage(error, 'Failed to add you to the roster.') });
    } finally {
      setSelfBusy(false);
    }
  };

  const handleCreateDept = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFeedback(null);
    setDeptBusy(true);
    try {
      await createDepartment({ name: deptName.trim(), description: deptDesc.trim() || null });
      setFeedback({ tone: 'success', message: `Department “${deptName.trim()}” created.` });
      setDeptOpen(false);
      setDeptName('');
      setDeptDesc('');
      reload();
    } catch (error) {
      setFeedback({ tone: 'error', message: toMessage(error, 'Failed to create the department.') });
    } finally {
      setDeptBusy(false);
    }
  };

  const handleDeleteDept = async (department: Department): Promise<void> => {
    setFeedback(null);
    setDeptRowBusyId(department.id);
    try {
      await deleteDepartment(department.id);
      setFeedback({ tone: 'success', message: `Department “${department.name}” deleted.` });
      setDeptRemovingId(null);
      reload();
    } catch (error) {
      setFeedback({ tone: 'error', message: toMessage(error, 'Failed to delete the department.') });
    } finally {
      setDeptRowBusyId(null);
    }
  };

  // ── Roster columns ───────────────────────────────────────────────────────────

  const columns: Column<Operator>[] = [
    {
      key: 'name',
      header: 'Member',
      render: (operator) => (
        <div className="flex items-center gap-3">
          <Avatar name={operator.name} />
          <div className="min-w-0">
            <p className="truncate font-medium text-[var(--ds-text)]">{operator.name}</p>
            <p className="truncate text-[12px] text-[var(--ds-text-subtle)]">{operator.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (operator) => (
        <StatusBadge tone={ROLE_TONE[operator.role] ?? 'neutral'} className="capitalize">
          {operator.role}
        </StatusBadge>
      ),
    },
    {
      key: 'department_id',
      header: 'Department',
      render: (operator) => (
        <span className="text-[var(--ds-text-muted)]">{departmentName(operator.department_id)}</span>
      ),
    },
    {
      key: 'is_online',
      header: 'Presence',
      render: (operator) => <PresenceBadge online={!!operator.is_online} />,
    },
    {
      key: 'active_chats',
      header: 'Live chats',
      align: 'right',
      render: (operator) => (
        <span className="tabular-nums text-[var(--ds-text-muted)]">
          {operator.active_chats ?? 0}
          {operator.max_concurrent_chats ? ` / ${operator.max_concurrent_chats}` : ''}
        </span>
      ),
    },
  ];

  if (canManage) {
    columns.push({
      key: 'id',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '7rem',
      render: (operator) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Edit ${operator.name}`}
            onClick={() => openEdit(operator)}
          >
            <Pencil size={15} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${operator.name}`}
            onClick={() => {
              setRemovingId(operator.id);
              setEditing(null);
            }}
          >
            <Trash2 size={15} aria-hidden="true" className="text-[var(--ds-danger)]" />
          </Button>
        </div>
      ),
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const canInvite = canManage && !!selectedBotId;

  const handleInviteClick = (): void => {
    // `atSeatLimit` is only ever true for a finite limit — `withinLimit`
    // returns true for the unlimited (-1) sentinel — so the copy can assume a
    // real seat count here.
    if (atSeatLimit) {
      openUpgradeModal({
        title: 'You’ve used all your seats',
        description: `You’ve used all ${seatLimit} seat${seatLimit === 1 ? '' : 's'} on your plan. Upgrade to invite more members.`,
      });
      return;
    }
    setInviteOpen((open) => !open);
  };

  const pageActions = canInvite ? (
    <Button onClick={handleInviteClick}>
      <UserPlus size={16} aria-hidden="true" />
      Invite member
    </Button>
  ) : undefined;

  return (
    <PageContainer
      title="Members"
      description="Everyone who can see conversations and answer visitors in this workspace."
      actions={pageActions}
    >
      {/* Seats used against the plan's operator limit — workspace-wide. */}
      {phase.status === 'ready' && (
        <div className="max-w-xs">
          <QuotaMeter label="Seats" used={seatsUsed} limit={seatLimit} />
        </div>
      )}

      {/* Live feedback for every mutation. */}
      <div aria-live="polite" className="empty:hidden">
        {feedback && (
          <div
            className={cn(
              'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-[13px]',
              feedback.tone === 'success'
                ? 'border-[var(--ds-success)] bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
                : 'border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]',
            )}
          >
            <span>{feedback.message}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              aria-label="Dismiss message"
              className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {phase.status === 'loading' && <LoadingState />}

      {phase.status === 'error' && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn’t load your team"
          description={phase.message}
          action={<Button onClick={retry}>Try again</Button>}
        />
      )}

      {phase.status === 'ready' && (
        <>
          {/* Metrics — a quick read on team size and availability. */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="Members" value={botOperators.length} icon={Users} />
            <MetricCard label="Online now" value={onlineCount} icon={Headphones} />
            <MetricCard label="Pending invites" value={botInvites.length} icon={Mail} />
            <MetricCard label="Departments" value={departments.length} icon={Building2} />
          </div>

          <Tabs
            ariaLabel="Members sections"
            value={tab}
            onChange={(key) => {
              setFeedback(null);
              setTab(key as TabKey);
            }}
            tabs={[
              { key: 'people', label: 'People' },
              { key: 'departments', label: 'Departments' },
            ]}
          />

          {tab === 'people' && (
            <div
              role="tabpanel"
              id="tabpanel-people"
              aria-labelledby="tab-people"
              tabIndex={0}
              className="space-y-6 focus-visible:outline-none"
            >
              {/* Self-join: the owner opts into taking live chats themselves. */}
              {showSelfCta && (
                <div className="flex flex-col gap-4 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)] sm:flex-row sm:items-center">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
                    <Headphones size={20} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold text-[var(--ds-text)]">
                      Handle live chats yourself
                    </p>
                    <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
                      Join the roster to take waiting conversations on{' '}
                      {selectedBot?.name ?? 'this agent'} directly.
                    </p>
                  </div>
                  <Button variant="outline" onClick={handleSelfJoin} disabled={selfBusy}>
                    {selfBusy ? 'Adding…' : 'Take chats'}
                  </Button>
                </div>
              )}

              {/* Invite form — progressive disclosure from the header button. */}
              {inviteOpen && canInvite && (
                <form
                  onSubmit={handleInvite}
                  className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]"
                >
                  <SectionHeader
                    title="Invite a member"
                    description="They’ll get an email with a link to join and set up their account."
                  />
                  <div className="mt-4 grid gap-4 sm:grid-cols-3">
                    <div className="sm:col-span-1">
                      <label htmlFor="invite-email" className={labelClass}>
                        Email address
                      </label>
                      <Input
                        id="invite-email"
                        type="email"
                        required
                        autoFocus
                        placeholder="teammate@company.com"
                        value={inviteEmail}
                        onChange={(event) => setInviteEmail(event.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor="invite-role" className={labelClass}>
                        Role
                      </label>
                      <select
                        id="invite-role"
                        className={selectClass}
                        value={inviteRole}
                        onChange={(event) => setInviteRole(event.target.value)}
                      >
                        {INVITE_ROLES.map((role) => (
                          <option key={role.value} value={role.value}>
                            {role.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="invite-dept" className={labelClass}>
                        Department
                      </label>
                      <select
                        id="invite-dept"
                        className={selectClass}
                        value={inviteDept}
                        onChange={(event) => setInviteDept(event.target.value)}
                      >
                        <option value="">Any department</option>
                        {departments.map((department) => (
                          <option key={department.id} value={department.id}>
                            {department.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={() => setInviteOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={inviteBusy || !inviteEmail.trim()}>
                      {inviteBusy ? 'Sending…' : 'Send invitation'}
                    </Button>
                  </div>
                </form>
              )}

              {/* Pending invitations. */}
              {botInvites.length > 0 && (
                <section aria-label="Pending invitations" className="space-y-3">
                  <SectionHeader title="Pending invitations" />
                  <ul className="divide-y divide-[var(--ds-border)] overflow-hidden rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)]">
                    {botInvites.map((invite) => (
                      <li key={invite.id} className="flex items-center gap-3 px-4 py-3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
                          <Mail size={15} aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">
                            {invite.email}
                          </p>
                          <p className="truncate text-[12px] text-[var(--ds-text-subtle)]">
                            <span className="capitalize">{invite.role}</span>
                            {invite.expires_at ? ` · Expires ${formatDate(invite.expires_at)}` : ''}
                            {invite.resend_count > 0 ? ` · Resent ${invite.resend_count}×` : ''}
                          </p>
                        </div>
                        {canManage && (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Resend invitation to ${invite.email}`}
                              disabled={rowBusyId === invite.id}
                              onClick={() => handleResend(invite)}
                            >
                              <RotateCcw size={15} aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Revoke invitation to ${invite.email}`}
                              disabled={rowBusyId === invite.id}
                              onClick={() => handleRevoke(invite)}
                            >
                              <X size={15} aria-hidden="true" className="text-[var(--ds-danger)]" />
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Edit-member panel (progressive disclosure). */}
              {editing && canManage && (
                <form
                  onSubmit={handleSaveEdit}
                  className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]"
                >
                  <SectionHeader
                    title={`Edit ${editing.name}`}
                    description="Change their role, department, or how many chats they can take at once."
                  />
                  <div className="mt-4 grid gap-4 sm:grid-cols-3">
                    <div>
                      <label htmlFor="edit-role" className={labelClass}>
                        Role
                      </label>
                      <select
                        id="edit-role"
                        className={selectClass}
                        value={editRole}
                        onChange={(event) => setEditRole(event.target.value)}
                      >
                        {EDITABLE_ROLES.map((role) => (
                          <option key={role.value} value={role.value}>
                            {role.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="edit-dept" className={labelClass}>
                        Department
                      </label>
                      <select
                        id="edit-dept"
                        className={selectClass}
                        value={editDept}
                        onChange={(event) => setEditDept(event.target.value)}
                      >
                        <option value="">No department</option>
                        {departments.map((department) => (
                          <option key={department.id} value={department.id}>
                            {department.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="edit-max" className={labelClass}>
                        Max concurrent chats
                      </label>
                      <Input
                        id="edit-max"
                        type="number"
                        min={1}
                        max={20}
                        aria-invalid={!maxChatsValid}
                        aria-describedby="edit-max-hint"
                        value={editMaxChats}
                        onChange={(event) => setEditMaxChats(event.target.value)}
                      />
                      <p
                        id="edit-max-hint"
                        className="mt-1.5 text-[12px] text-[var(--ds-text-subtle)]"
                      >
                        Between 1 and 20 chats at once.
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={editBusy || !maxChatsValid}>
                      {editBusy ? 'Saving…' : (
                        <>
                          <Check size={16} aria-hidden="true" />
                          Save changes
                        </>
                      )}
                    </Button>
                  </div>
                </form>
              )}

              {/* Remove-member confirmation. */}
              {removingId != null && canManage && (() => {
                const target = botOperators.find((operator) => operator.id === removingId);
                if (!target) return null;
                return (
                  <div className="flex flex-col gap-3 rounded-xl border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] p-5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-[var(--ds-text)]">
                        Remove {target.name}?
                      </p>
                      <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
                        Their active chats will be unassigned. This can’t be undone.
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="ghost" onClick={() => setRemovingId(null)}>
                        Cancel
                      </Button>
                      <Button
                        variant="danger"
                        disabled={rowBusyId === target.id}
                        onClick={() => handleRemove(target)}
                      >
                        {rowBusyId === target.id ? 'Removing…' : 'Remove member'}
                      </Button>
                    </div>
                  </div>
                );
              })()}

              {/* The roster. */}
              {!selectedBotId ? (
                <EmptyState
                  icon={UserRound}
                  title="Pick an agent to see its team"
                  description="Members are attached to a specific agent. Choose one from the switcher to view and manage its roster."
                />
              ) : (
                <DataTable
                  caption="Team members"
                  columns={columns}
                  rows={botOperators}
                  rowKey={(operator) => operator.id}
                  empty={
                    <EmptyState
                      className="border-0 py-6"
                      icon={UserRound}
                      title={`No members on ${selectedBot?.name ?? 'this agent'} yet`}
                      description="Invite a teammate to help answer conversations."
                      action={
                        canInvite ? (
                          <Button onClick={handleInviteClick}>
                            <UserPlus size={16} aria-hidden="true" />
                            Invite member
                          </Button>
                        ) : undefined
                      }
                    />
                  }
                />
              )}
            </div>
          )}

          {tab === 'departments' && (
            <div
              role="tabpanel"
              id="tabpanel-departments"
              aria-labelledby="tab-departments"
              tabIndex={0}
              className="space-y-6 focus-visible:outline-none"
            >
              <SectionHeader
                title="Departments"
                description="Group members so conversations reach the right team."
                actions={
                  canManage ? (
                    <Button variant="outline" onClick={() => setDeptOpen((open) => !open)}>
                      <Plus size={16} aria-hidden="true" />
                      New department
                    </Button>
                  ) : undefined
                }
              />

              {deptOpen && canManage && (
                <form
                  onSubmit={handleCreateDept}
                  className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]"
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="dept-name" className={labelClass}>
                        Name
                      </label>
                      <Input
                        id="dept-name"
                        required
                        autoFocus
                        placeholder="e.g. Sales"
                        value={deptName}
                        onChange={(event) => setDeptName(event.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor="dept-desc" className={labelClass}>
                        Description <span className="text-[var(--ds-text-subtle)]">(optional)</span>
                      </label>
                      <Input
                        id="dept-desc"
                        placeholder="What this team handles"
                        value={deptDesc}
                        onChange={(event) => setDeptDesc(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={() => setDeptOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={deptBusy || !deptName.trim()}>
                      {deptBusy ? 'Creating…' : 'Create department'}
                    </Button>
                  </div>
                </form>
              )}

              {departments.length === 0 ? (
                <EmptyState
                  icon={Building2}
                  title="No departments yet"
                  description="Create departments to organize members by team, like Sales or Support."
                />
              ) : (
                <ul className="grid gap-3">
                  {departments.map((department) => {
                    const memberCount = (data?.operators ?? []).filter(
                      (operator) => operator.department_id === department.id,
                    ).length;
                    const confirming = deptRemovingId === department.id;
                    return (
                      <li
                        key={department.id}
                        className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-4 shadow-[var(--ds-shadow-sm)]"
                      >
                        <div className="flex items-center gap-3">
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
                            <Building2 size={18} aria-hidden="true" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[14px] font-semibold text-[var(--ds-text)]">
                              {department.name}
                            </p>
                            {department.description && (
                              <p className="truncate text-[12px] text-[var(--ds-text-subtle)]">
                                {department.description}
                              </p>
                            )}
                          </div>
                          <span className="shrink-0 text-[12px] text-[var(--ds-text-muted)]">
                            {memberCount} member{memberCount === 1 ? '' : 's'}
                          </span>
                          {canManage && !confirming && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete ${department.name}`}
                              onClick={() => setDeptRemovingId(department.id)}
                            >
                              <Trash2
                                size={15}
                                aria-hidden="true"
                                className="text-[var(--ds-danger)]"
                              />
                            </Button>
                          )}
                        </div>
                        {confirming && canManage && (
                          <div className="mt-3 flex flex-col gap-3 border-t border-[var(--ds-border)] pt-3 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-[13px] text-[var(--ds-text-muted)]">
                              Delete “{department.name}”? Members in it will be unassigned.
                            </p>
                            <div className="flex shrink-0 items-center gap-2">
                              <Button variant="ghost" onClick={() => setDeptRemovingId(null)}>
                                Cancel
                              </Button>
                              <Button
                                variant="danger"
                                disabled={deptRowBusyId === department.id}
                                onClick={() => handleDeleteDept(department)}
                              >
                                {deptRowBusyId === department.id ? 'Deleting…' : 'Delete'}
                              </Button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-9 w-64 rounded-lg" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
