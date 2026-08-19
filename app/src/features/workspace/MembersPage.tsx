import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import {
  Building2,
  Headphones,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingRows,
  LockedState,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  Meter,
  PageHeader,
  Section,
  Stack,
  StatusDot,
  Tabs,
  TabPanel,
  buttonClass,
  formatNumber,
  toast,
  type Column,
} from '../../ui';
import {
  addSelfAsOperator,
  deleteDepartment,
  deleteOperator,
  removeSelfAsOperator,
  resendOperatorInvite,
  revokeOperatorInvite,
} from '../../services/api';
import { useBotContext } from '../../context/BotContext';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import type { Department, Operator, OperatorInvite } from '../../types/domain';
import { canManageTeam, roleLabel, roleTone } from './roles';
import {
  AVAILABILITY_LABEL,
  availability,
  byPresenceThenName,
  departmentName,
  inviteExpired,
  inviteExpiry,
  pendingInvitesFor,
  rosterFor,
  seatsUsed,
  selfSeat,
} from './teamModel';
import { useTeamData } from './useTeamData';
import { MemberDialog } from './MemberDialog';
import { InviteDialog } from './InviteDialog';
import { DepartmentDialog } from './DepartmentDialog';
import { QueueSettingsCard } from './QueueSettingsCard';

/**
 * Settings ▸ Team — who is in this workspace, and what each of them may do.
 *
 * Three questions, three tabs, all of them in the URL: the people on the
 * roster, the invitations still outstanding, and the departments that group
 * them. The console this replaces put invitations inside the people tab, where
 * a pending invite looked like a member who had never come online.
 *
 * Every destructive act here confirms and says what it costs. The previous
 * version had none: removing a teammate, deleting a department, revoking an
 * invitation and promoting somebody to Owner were all one unguarded click.
 */

type TabKey = 'people' | 'invitations' | 'departments' | 'routing';

const TAB_ITEMS = [
  { value: 'people', label: 'People' },
  { value: 'invitations', label: 'Invitations' },
  { value: 'departments', label: 'Departments' },
  { value: 'routing', label: 'Routing' },
] as const;

function isTab(value: string | null): value is TabKey {
  return (
    value === 'people' ||
    value === 'invitations' ||
    value === 'departments' ||
    value === 'routing'
  );
}

export function MembersPage() {
  const [params, setParams] = useSearchParams();
  const tab: TabKey = isTab(params.get('tab')) ? (params.get('tab') as TabKey) : 'people';

  const { selectedBot, bots } = useBotContext();
  const { currentRole } = useWorkspace();
  const { isFree, limitFor, hasFeature } = useEntitlements();

  // One resolution of "which chatbot is this page about", so the seat meter,
  // the invite dialog and the queue settings can never disagree about it.
  const routedBot = selectedBot ?? bots[0] ?? null;
  const botId = routedBot?.id ?? null;
  const botName = routedBot?.name ?? null;
  const canManage = canManageTeam(currentRole);

  const team = useTeamData(!isFree);

  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Operator | null>(null);
  const [removing, setRemoving] = useState<Operator | null>(null);
  const [revoking, setRevoking] = useState<OperatorInvite | null>(null);
  const [departmentDraft, setDepartmentDraft] = useState<Department | null | 'new'>(null);
  const [deletingDepartment, setDeletingDepartment] = useState<Department | null>(null);
  const [joining, setJoining] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const roster = rosterFor(team.operators, botId).sort(byPresenceThenName);
  const invites = pendingInvitesFor(team.invites, botId);
  const used = seatsUsed(team.operators, botId);
  const seatLimit = limitFor('operators');
  const atSeatLimit = seatLimit >= 0 && used >= seatLimit;
  const self = selfSeat(team.operators, team.clientId, botId);

  const invalidate = team.refetch;

  const remove = useMutation({
    mutationFn: (operator: Operator) => deleteOperator(operator.id),
    onSuccess: (_data, operator) => {
      toast.success(`${operator.name || operator.email} removed from the team`);
      setRemoving(null);
      invalidate();
    },
  });

  const resend = useMutation({
    mutationFn: (invite: OperatorInvite) => resendOperatorInvite(invite.id),
    onSuccess: (_data, invite) => {
      toast.success(`Invitation to ${invite.email} sent again`);
      invalidate();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not resend that invitation.'),
  });

  const revoke = useMutation({
    mutationFn: (invite: OperatorInvite) => revokeOperatorInvite(invite.id),
    onSuccess: (_data, invite) => {
      toast.success(`Invitation to ${invite.email} revoked`);
      setRevoking(null);
      invalidate();
    },
  });

  const join = useMutation({
    mutationFn: () => {
      if (botId == null) throw new Error('Pick a chatbot first.');
      return addSelfAsOperator(botId);
    },
    onSuccess: () => {
      toast.success('You are on the live-chat roster');
      setJoining(false);
      invalidate();
    },
  });

  const leave = useMutation({
    mutationFn: () => removeSelfAsOperator(),
    onSuccess: () => {
      toast.success('You have left live chat');
      setLeaving(false);
      invalidate();
    },
  });

  const removeDepartment = useMutation({
    mutationFn: (department: Department) => deleteDepartment(department.id),
    onSuccess: (_data, department) => {
      toast.success(`Department “${department.name}” deleted`);
      setDeletingDepartment(null);
      invalidate();
    },
  });

  const mutationError = [remove.error, revoke.error, join.error, leave.error, removeDepartment.error]
    .filter((error): error is Error => error instanceof Error)
    .map((error) => error.message)[0];

  const header = (
    <PageHeader
      title="Team"
      description={
        botName
          ? `Who can answer conversations on ${botName}, and what they are allowed to change.`
          : 'Who can answer conversations, and what they are allowed to change.'
      }
      actions={
        canManage && !isFree ? (
          <Button onClick={() => setInviting(true)} iconLeft={<UserPlus aria-hidden className="h-4 w-4" />}>
            Invite teammate
          </Button>
        ) : undefined
      }
    />
  );

  // ── Plan gate ─────────────────────────────────────────────────────────────
  if (isFree || !hasFeature('live_chat')) {
    return (
      <>
        {header}
        <LockedState
          title="Your plan does not include a team"
          description="On a paid plan you can invite people to answer live conversations, give each of them a role, group them into departments, and set the hours each group is available."
          action={
            <Link to="/billing" className={buttonClass('primary', 'md')}>
              See plans
            </Link>
          }
        />
      </>
    );
  }

  // ── Forbidden ─────────────────────────────────────────────────────────────
  if (team.forbidden || !canManage) {
    return (
      <>
        {header}
        <LockedState
          title="Only owners and admins can manage the team"
          description="You are signed in with an operator seat, which can answer conversations but cannot change who else is in the workspace. Your own profile and alerts are on your account page."
          action={
            <Link to="/account" className={buttonClass('primary', 'md')}>
              Go to your account
            </Link>
          }
        />
      </>
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (team.loading) {
    return (
      <>
        {header}
        <Card>
          <CardBody>
            <LoadingRows rows={5} />
          </CardBody>
        </Card>
      </>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (team.error) {
    return (
      <>
        {header}
        <Card>
          <ErrorState
            title="We could not load your team"
            description={team.error.message}
            onRetry={invalidate}
          />
        </Card>
      </>
    );
  }

  const memberColumns: Column<Operator>[] = [
    {
      key: 'name',
      header: 'Member',
      width: '17rem',
      pinned: true,
      render: (operator) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={operator.name || operator.email} size="sm" src={operator.avatar_url} />
          <div className="min-w-0">
            <p className="truncate font-medium text-text-primary">
              {operator.name || operator.email}
              {operator.linked_client_id === team.clientId ? (
                <span className="ml-1.5 text-xs font-normal text-text-tertiary">You</span>
              ) : null}
            </p>
            <p className="truncate text-xs text-text-secondary">{operator.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      sortable: (a, b) => (a.role ?? '').localeCompare(b.role ?? ''),
      render: (operator) => <Badge tone={roleTone(operator.role)}>{roleLabel(operator.role)}</Badge>,
    },
    {
      key: 'department',
      header: 'Department',
      secondary: true,
      render: (operator) => (
        <span className="text-text-secondary">
          {departmentName(team.departments, operator.department_id) ?? '—'}
        </span>
      ),
    },
    {
      key: 'availability',
      header: 'Availability',
      render: (operator) => {
        const state = availability(operator);
        return (
          <StatusDot
            tone={state === 'online' ? 'success' : 'neutral'}
            pulse={state === 'online'}
            label={AVAILABILITY_LABEL[state]}
          />
        );
      },
    },
    {
      key: 'load',
      header: 'Live now',
      align: 'right',
      secondary: true,
      sortable: (a, b) => (a.active_chats ?? 0) - (b.active_chats ?? 0),
      render: (operator) => (
        <span className="figure text-text-secondary">
          {formatNumber(operator.active_chats ?? 0)}
          <span className="text-text-tertiary"> / {formatNumber(operator.max_concurrent_chats ?? 0)}</span>
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '3rem',
      render: (operator) => (
        <MenuRoot>
          <MenuTrigger
            aria-label={`Actions for ${operator.name || operator.email}`}
            className={buttonClass('ghost', 'icon-sm')}
          >
            <MoreHorizontal aria-hidden className="h-4 w-4" />
          </MenuTrigger>
          <MenuContent>
            <MenuItem icon={<Pencil aria-hidden className="h-3.5 w-3.5" />} onSelect={() => setEditing(operator)}>
              Edit member
            </MenuItem>
            {operator.linked_client_id === team.clientId ? (
              <MenuItem
                icon={<LogOut aria-hidden className="h-3.5 w-3.5" />}
                onSelect={() => setLeaving(true)}
              >
                Leave live chat
              </MenuItem>
            ) : (
              <MenuItem
                destructive
                icon={<Trash2 aria-hidden className="h-3.5 w-3.5" />}
                onSelect={() => setRemoving(operator)}
              >
                Remove from team
              </MenuItem>
            )}
          </MenuContent>
        </MenuRoot>
      ),
    },
  ];

  const inviteColumns: Column<OperatorInvite>[] = [
    {
      key: 'email',
      header: 'Invited',
      pinned: true,
      width: '16rem',
      render: (invite) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-text-primary">{invite.email}</p>
          <p className="truncate text-xs text-text-secondary">
            {invite.invited_by_name ? `Invited by ${invite.invited_by_name}` : 'Invited'}
          </p>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (invite) => <Badge tone={roleTone(invite.role)}>{roleLabel(invite.role)}</Badge>,
    },
    {
      key: 'expiry',
      header: 'Status',
      render: (invite) => {
        const expired = inviteExpired(invite.expires_at, Date.now());
        return (
          <span className={expired ? 'text-danger' : 'text-text-secondary'}>
            {inviteExpiry(invite.expires_at, Date.now())}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '11rem',
      render: (invite) => (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => resend.mutate(invite)}
            loading={resend.isPending && resend.variables?.id === invite.id}
            iconLeft={<RotateCcw aria-hidden className="h-3.5 w-3.5" />}
          >
            Resend
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Revoke the invitation to ${invite.email}`}
            onClick={() => setRevoking(invite)}
          >
            <X aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      {header}
      <Stack>
        {/* Seats first: it is the constraint every other action on this page
            runs into, and finding out at the moment an invite is refused is the
            worst possible time to learn it. */}
        <Card>
          <CardBody>
            <Meter label="Seats used on this chatbot" used={used} limit={seatLimit} unit="seats" />
            <p className="mt-2 text-xs text-text-secondary">
              Seats are counted per chatbot, and the owner takes one too while they are on the
              roster. Add more from{' '}
              <Link to="/billing" className="text-accent-600 underline-offset-2 hover:underline">
                Billing
              </Link>
              .
            </p>
          </CardBody>
        </Card>

        {/* The owner's own seat. The console this replaces could put an owner on
            the roster but never take them off — `removeSelfAsOperator` existed
            in the API client and nothing called it, so an owner who joined live
            chat was on it permanently. */}
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-base font-medium text-text-primary">
                {self ? 'You are taking live chats' : 'You are not taking live chats'}
              </p>
              <p className="mt-0.5 text-xs text-text-secondary">
                {self
                  ? 'Conversations that ask for a person can be routed to you, and you appear on the roster above.'
                  : 'Join the roster to be handed conversations yourself. It uses one of the seats above.'}
              </p>
            </div>
            {self ? (
              <Button variant="secondary" onClick={() => setLeaving(true)} iconLeft={<LogOut aria-hidden className="h-4 w-4" />}>
                Leave live chat
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={() => setJoining(true)}
                disabled={atSeatLimit || botId == null}
                iconLeft={<Headphones aria-hidden className="h-4 w-4" />}
              >
                Join live chat
              </Button>
            )}
          </CardBody>
        </Card>

        <Tabs
          label="Team sections"
          items={TAB_ITEMS.map((item) => ({
            ...item,
            badge:
              item.value === 'invitations' && invites.length > 0
                ? formatNumber(invites.length)
                : undefined,
          }))}
          value={tab}
          onValueChange={(next) => {
            const nextParams = new URLSearchParams(params);
            nextParams.set('tab', next);
            setParams(nextParams, { replace: true });
          }}
        >
          <TabPanel value="people">
            <Card>
              <DataTable
                caption="Everyone who can answer conversations on this chatbot"
                columns={memberColumns}
                rows={roster}
                rowKey={(operator) => String(operator.id)}
                rowLabel={(operator) => operator.name || operator.email}
                empty={
                  <EmptyState
                    icon={Users}
                    title="Nobody on the roster yet"
                    description="Invite a teammate to answer live conversations, or join the roster yourself."
                    action={
                      <Button onClick={() => setInviting(true)} size="sm">
                        Invite a teammate
                      </Button>
                    }
                  />
                }
              />
            </Card>
          </TabPanel>

          <TabPanel value="invitations">
            {team.invitesForbidden ? (
              <Card>
                <ErrorState
                  compact
                  title="We could not load the invitations"
                  description="Only owners and admins can see outstanding invitations. If that is you, try again."
                  onRetry={invalidate}
                />
              </Card>
            ) : (
              <Card>
                <DataTable
                  caption="Invitations that have been sent but not yet accepted"
                  columns={inviteColumns}
                  rows={invites}
                  rowKey={(invite) => String(invite.id)}
                  rowLabel={(invite) => invite.email}
                  empty={
                    <EmptyState
                      icon={UserPlus}
                      title="No invitations outstanding"
                      description="Everyone you have invited has either accepted or been revoked."
                      action={
                        <Button size="sm" onClick={() => setInviting(true)}>
                          Invite a teammate
                        </Button>
                      }
                    />
                  }
                />
              </Card>
            )}
          </TabPanel>

          <TabPanel value="departments">
            <Section
              title="Departments"
              description="Groups a conversation can be routed to, each with its own opening hours."
              actions={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setDepartmentDraft('new')}
                  iconLeft={<Plus aria-hidden className="h-3.5 w-3.5" />}
                >
                  New department
                </Button>
              }
            >
              <Card>
                {team.departments.length === 0 ? (
                  <EmptyState
                    icon={Building2}
                    title="No departments"
                    description="Without departments every conversation goes to whoever is online. Create one when you want billing questions and support questions to reach different people."
                    action={
                      <Button size="sm" onClick={() => setDepartmentDraft('new')}>
                        Create a department
                      </Button>
                    }
                  />
                ) : (
                  <ul>
                    {team.departments.map((department) => {
                      const members = team.operators.filter(
                        (operator) => operator.department_id === department.id,
                      ).length;
                      return (
                        <li
                          key={department.id}
                          className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3.5 first:border-t-0"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-base font-medium text-text-primary">
                              {department.name}
                            </p>
                            <p className="mt-0.5 truncate text-xs text-text-secondary">
                              {department.description || 'No description'}
                            </p>
                          </div>
                          <span className="figure text-sm text-text-secondary">
                            {formatNumber(members)}
                            <span className="text-text-tertiary">
                              {members === 1 ? ' member' : ' members'}
                            </span>
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setDepartmentDraft(department)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Delete the ${department.name} department`}
                            onClick={() => setDeletingDepartment(department)}
                          >
                            <Trash2 aria-hidden className="h-4 w-4" />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </Section>
          </TabPanel>

          <TabPanel value="routing">
            {routedBot ? (
              <QueueSettingsCard bot={routedBot} onSaved={invalidate} />
            ) : (
              <Card>
                <EmptyState
                  icon={Users}
                  title="No chatbot to route"
                  description="Queue settings belong to a chatbot. Create one and its waiting rules appear here."
                />
              </Card>
            )}
          </TabPanel>
        </Tabs>

        {/* A confirmation dialog surfaces its own failure inline and stays open,
            so this only ever catches a failure that arrived after the dialog
            closed — which would otherwise be a silent no-op. */}
        {mutationError ? (
          <Alert tone="danger" live title="That did not go through">
            {mutationError}
          </Alert>
        ) : null}
      </Stack>

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        botId={botId}
        botName={botName}
        departments={team.departments}
        callerRole={currentRole}
        atSeatLimit={atSeatLimit}
        onInvited={invalidate}
      />

      <MemberDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        member={editing}
        departments={team.departments}
        callerRole={currentRole}
        isSelf={editing?.linked_client_id === team.clientId}
        onSaved={invalidate}
      />

      <DepartmentDialog
        open={departmentDraft !== null}
        onOpenChange={(open) => {
          if (!open) setDepartmentDraft(null);
        }}
        department={departmentDraft === 'new' ? null : departmentDraft}
        onSaved={invalidate}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing ? removing.name || removing.email : 'this person'}?`}
        description={
          <>
            They lose access to this workspace immediately. Any conversation they are handling right
            now goes back to the chatbot, and the visitor is not told why. Their past replies stay in
            the transcripts under their name, and the seat is freed for someone else. To stop them
            being routed new chats without removing them, ask them to go offline instead.
          </>
        }
        confirmLabel="Remove from team"
        destructive
        onConfirm={async () => {
          if (removing) await remove.mutateAsync(removing);
        }}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke the invitation to ${revoking?.email ?? ''}?`}
        description="The link we emailed them stops working. If they click it they are told the invitation is no longer valid. You can invite the same address again afterwards."
        confirmLabel="Revoke invitation"
        destructive
        onConfirm={async () => {
          if (revoking) await revoke.mutateAsync(revoking);
        }}
      />

      <ConfirmDialog
        open={joining}
        onOpenChange={setJoining}
        title="Join the live-chat roster?"
        description="You will be handed conversations that ask for a person, and you will appear to visitors by name. This takes one of your plan's seats for this chatbot — the same as inviting a teammate. You can leave again at any time."
        confirmLabel="Join live chat"
        onConfirm={async () => {
          await join.mutateAsync();
        }}
      />

      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title="Leave the live-chat roster?"
        description="You stop being routed new conversations and the seat is freed. Conversations you are already in finish normally, and your past replies stay in the transcripts. You still own the workspace, and you can rejoin whenever you like."
        confirmLabel="Leave live chat"
        onConfirm={async () => {
          await leave.mutateAsync();
        }}
      />

      <ConfirmDialog
        open={deletingDepartment !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingDepartment(null);
        }}
        title={`Delete the ${deletingDepartment?.name ?? ''} department?`}
        description="Everyone in it stays on the team but loses their grouping, and conversations that were routed to this department go to whoever is online instead. Its opening hours are deleted with it."
        confirmLabel="Delete department"
        destructive
        onConfirm={async () => {
          if (deletingDepartment) await removeDepartment.mutateAsync(deletingDepartment);
        }}
      />
    </>
  );
}
