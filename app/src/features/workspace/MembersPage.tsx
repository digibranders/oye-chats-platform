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
  Power,
  RotateCcw,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  ABSENT,
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
  Section,
  Stack,
  StatusDot,
  Tabs,
  TabPanel,
  Toolbar,
  buttonClass,
  formatNumber,
  formatDate,
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
  updateOperator,
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
  const [deactivating, setDeactivating] = useState<Operator | null>(null);
  const [reactivating, setReactivating] = useState<Operator | null>(null);

  const roster = rosterFor(team.operators, botId).sort(byPresenceThenName);
  const invites = pendingInvitesFor(team.invites, botId);
  const used = seatsUsed(team.operators, botId);
  const seatLimit = limitFor('operators');
  const atSeatLimit = seatLimit >= 0 && used >= seatLimit;
  const self = selfSeat(team.operators, team.clientId, botId);

  const membersIn = (department: Department): number =>
    team.operators.filter((operator) => operator.department_id === department.id).length;

  const invalidate = team.refetch;

  const remove = useMutation({
    mutationFn: (operator: Operator) => deleteOperator(operator.id),
    onSuccess: (_data, operator) => {
      toast.success(`${operator.name || operator.email} removed from the team`);
      setRemoving(null);
      invalidate();
    },
  });

  /**
   * Deactivate and reactivate are not symmetrical, and the dialogs say so.
   *
   * Deactivating always works: the server hands their live conversations back
   * to the queue, drops their socket and frees the seat. Reactivating asks for
   * a seat back, and `invite_service._require_seat_available` can refuse — so
   * the roster is never flipped optimistically. `ConfirmDialog` keeps itself
   * open and prints the server's reason when this rejects, which is the only
   * honest way to render "we could not give them their seat back".
   */
  const setActive = useMutation({
    mutationFn: ({ operator, active }: { operator: Operator; active: boolean }) =>
      updateOperator(operator.id, { is_active: active }),
    onSuccess: (_data, { operator, active }) => {
      toast.success(
        active
          ? `${operator.name || operator.email} can answer conversations again`
          : `${operator.name || operator.email} deactivated`,
      );
      setDeactivating(null);
      setReactivating(null);
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

  const mutationError = [
    remove.error,
    revoke.error,
    join.error,
    leave.error,
    removeDepartment.error,
  ]
    .filter((error): error is Error => error instanceof Error)
    .map((error) => error.message)[0];

  // ── Plan gate ─────────────────────────────────────────────────────────────
  if (isFree || !hasFeature('live_chat')) {
    return (
      <LockedState
        title="Your plan does not include a team"
        description="A paid plan adds teammates, roles, departments and opening hours."
        action={
          <Link to="/billing" className={buttonClass('primary', 'md')}>
            See plans
          </Link>
        }
        preview={<RosterPreview />}
      />
    );
  }

  // ── Forbidden ─────────────────────────────────────────────────────────────
  if (team.forbidden || !canManage) {
    return (
      <LockedState
        title="Only owners and admins can manage the team"
        description="Your own profile and alerts are on your account page."
        action={
          <Link to="/account" className={buttonClass('primary', 'md')}>
            Go to your account
          </Link>
        }
      />
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (team.loading) {
    return (
      <Card>
        <CardBody>
          <LoadingRows rows={5} />
        </CardBody>
      </Card>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (team.error) {
    return (
      <Card>
        <ErrorState
          title="We could not load your team"
          description={team.error.message}
          onRetry={invalidate}
        />
      </Card>
    );
  }

  const memberColumns: Column<Operator>[] = [
    {
      key: 'name',
      header: 'Member',
      width: '17rem',
      pinned: true,
      sortable: (a, b) =>
        (a.name || a.email).localeCompare(b.name || b.email, undefined, { sensitivity: 'base' }),
      render: (operator) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={operator.name || operator.email} size="sm" src={operator.avatar_url} />
          <div className="min-w-0">
            {/* The "You" marker sits outside the truncating span. Inside it, the
                one row the reader most needs to identify was the row whose
                marker a long name truncated away. */}
            <p className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate font-medium text-text-primary">
                {operator.name || operator.email}
              </span>
              {operator.linked_client_id === team.clientId ? (
                <Badge tone="neutral">You</Badge>
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
      sortable: (a, b) =>
        (departmentName(team.departments, a.department_id) ?? '\uffff').localeCompare(
          departmentName(team.departments, b.department_id) ?? '\uffff',
        ),
      render: (operator) => (
        <span className="text-text-secondary">
          {departmentName(team.departments, operator.department_id) ?? ABSENT}
        </span>
      ),
    },
    {
      key: 'availability',
      header: 'Availability',
      sortable: (a, b) =>
        Number(availability(b) === 'online') - Number(availability(a) === 'online'),
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
      // `0 / 3` on every offline row states a capacity fact that is not
      // currently meaningful and fills the column with noise on a roster where
      // most people are offline. An absent value is `—`.
      render: (operator) =>
        availability(operator) === 'online' ? (
          <span className="text-text-secondary">
            {formatNumber(operator.active_chats ?? 0)}
            <span className="text-text-tertiary">
              {' / '}
              {formatNumber(operator.max_concurrent_chats ?? 0)}
            </span>
          </span>
        ) : (
          <span className="text-text-tertiary">{ABSENT}</span>
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
            <MoreHorizontal aria-hidden />
          </MenuTrigger>
          <MenuContent>
            <MenuItem icon={<Pencil aria-hidden />} onSelect={() => setEditing(operator)}>
              Edit member
            </MenuItem>
            {operator.linked_client_id === team.clientId ? (
              <MenuItem
                icon={<LogOut aria-hidden />}
                onSelect={() => setLeaving(true)}
              >
                Leave live chat
              </MenuItem>
            ) : operator.is_active === false ? (
              <MenuItem
                icon={<Power aria-hidden />}
                onSelect={() => setReactivating(operator)}
              >
                Reactivate…
              </MenuItem>
            ) : (
              <>
                <MenuItem
                  icon={<Power aria-hidden />}
                  onSelect={() => setDeactivating(operator)}
                >
                  Deactivate…
                </MenuItem>
                <MenuItem
                  destructive
                  icon={<Trash2 aria-hidden />}
                  onSelect={() => setRemoving(operator)}
                >
                  Remove from team
                </MenuItem>
              </>
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
      // Two facts in one cell before this: a column headed Status rendered a
      // date phrase, and an expired invitation was signalled by hue alone.
      key: 'status',
      header: 'Status',
      render: (invite) =>
        inviteExpired(invite.expires_at, Date.now()) ? (
          <Badge tone="danger">Expired</Badge>
        ) : (
          <Badge tone="warning">Pending</Badge>
        ),
    },
    {
      key: 'expiry',
      header: 'Expires',
      type: 'text',
      sortable: (a, b) =>
        (Date.parse(a.expires_at ?? '') || 0) - (Date.parse(b.expires_at ?? '') || 0),
      render: (invite) => (
        <span className="figure text-text-secondary">
          {invite.expires_at ? formatDate(invite.expires_at) : ABSENT}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '10rem',
      render: (invite) => (
        <div className="flex items-center justify-end gap-1.5">
          {/* Resend stays promoted — it is the common act — and Revoke moves
              into the same row menu People and Departments use, so the reader
              does not relearn where actions live on each tab. */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => resend.mutate(invite)}
            loading={resend.isPending && resend.variables?.id === invite.id}
            iconLeft={<RotateCcw aria-hidden />}
          >
            Resend
          </Button>
          <MenuRoot>
            <MenuTrigger
              aria-label={`Actions for the invitation to ${invite.email}`}
              className={buttonClass('ghost', 'icon-sm')}
            >
              <MoreHorizontal aria-hidden />
            </MenuTrigger>
            <MenuContent>
              <MenuItem
                destructive
                icon={<Trash2 aria-hidden />}
                onSelect={() => setRevoking(invite)}
              >
                Revoke the invitation
              </MenuItem>
            </MenuContent>
          </MenuRoot>
        </div>
      ),
    },
  ];

  const departmentColumns: Column<Department>[] = [
    {
      key: 'name',
      header: 'Department',
      pinned: true,
      width: '20rem',
      rowHeader: true,
      sortable: (a, b) => a.name.localeCompare(b.name),
      render: (department) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-text-primary">{department.name}</p>
          <p className="truncate text-xs text-text-secondary">
            {department.description || ABSENT}
          </p>
        </div>
      ),
    },
    {
      key: 'members',
      header: 'Members',
      type: 'number',
      sortable: (a, b) => membersIn(a) - membersIn(b),
      render: (department) => formatNumber(membersIn(department)),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '3rem',
      render: (department) => (
        <MenuRoot>
          <MenuTrigger
            aria-label={`Actions for the ${department.name} department`}
            className={buttonClass('ghost', 'icon-sm')}
          >
            <MoreHorizontal aria-hidden />
          </MenuTrigger>
          <MenuContent>
            <MenuItem
              icon={<Pencil aria-hidden />}
              onSelect={() => setDepartmentDraft(department)}
            >
              Edit department
            </MenuItem>
            <MenuItem
              destructive
              icon={<Trash2 aria-hidden />}
              onSelect={() => setDeletingDepartment(department)}
            >
              Delete department
            </MenuItem>
          </MenuContent>
        </MenuRoot>
      ),
    },
  ];

  return (
    <>
      <Stack>
        {/* A confirmation dialog surfaces its own failure inline and stays open,
            so this only ever catches a failure that arrived after the dialog
            closed. It sits above the tabs, not below the table: after a failed
            remove on row 30 of a roster, an explanation under the table is off
            screen. */}
        {mutationError ? (
          <Alert tone="danger" live title="That did not go through">
            {mutationError}
          </Alert>
        ) : null}

        {/* Seats and your own seat are the table's header facts, not two peers
            of it. As two cards they were 220px of chrome — one `Meter` and one
            sentence each — before the reader reached the tab row. */}
        <Toolbar className="justify-between gap-4 border-y border-border py-3">
          <Meter
            className="w-64"
            label="Seats on this chatbot"
            used={used}
            limit={seatLimit}
            unit="seats"
          />
          <div className="flex flex-wrap items-center gap-3">
            <StatusDot
              tone={self ? 'success' : 'neutral'}
              pulse={Boolean(self)}
              label={self ? 'You are taking live chats' : 'You are not taking live chats'}
            />
            {/* The owner's own seat. The console this replaces could put an
                owner on the roster but never take them off —
                `removeSelfAsOperator` existed in the API client and nothing
                called it, so an owner who joined live chat was on it
                permanently. */}
            {self ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setLeaving(true)}
                iconLeft={<LogOut aria-hidden />}
              >
                Leave live chat
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setJoining(true)}
                disabled={atSeatLimit || botId == null}
                iconLeft={<Headphones aria-hidden />}
              >
                Join live chat
              </Button>
            )}
            <Button size="sm" onClick={() => setInviting(true)} iconLeft={<UserPlus aria-hidden />}>
              Invite teammate
            </Button>
          </div>
        </Toolbar>

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
              rowNoun="teammate"
            />
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
                  rowNoun="invitation"
                  defaultSort={{ key: 'expiry', direction: 'asc' }}
                />
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
                  iconLeft={<Plus aria-hidden />}
                >
                  New department
                </Button>
              }
            >
              {/* A table, like the two sibling tabs. The hand-built `ul` here
                  reimplemented `DataTable`'s row geometry at 20/14 against its
                  16/10, so the three tabs' left text edges did not line up when
                  you switched between them — and it had no sort. */}
              <DataTable
                caption="Departments a conversation can be routed to"
                columns={departmentColumns}
                rows={team.departments}
                rowKey={(department) => String(department.id)}
                rowLabel={(department) => department.name}
                rowNoun="department"
                empty={
                  <EmptyState
                    icon={Building2}
                    title="No departments"
                    description="Without departments every conversation goes to whoever is online."
                    action={
                      <Button size="sm" onClick={() => setDepartmentDraft('new')}>
                        Create a department
                      </Button>
                    }
                  />
                }
              />
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
        description="They lose access immediately and their seat is freed. Live conversations go back to the chatbot; past replies stay in the transcripts."
        confirmLabel="Remove from team"
        destructive
        onConfirm={async () => {
          if (removing) await remove.mutateAsync(removing);
        }}
      />

      <ConfirmDialog
        open={deactivating !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivating(null);
        }}
        title={`Deactivate ${deactivating ? deactivating.name || deactivating.email : 'this person'}?`}
        description="They cannot sign in, their seat is freed, and live conversations go back to the queue. Nothing is deleted — you can reactivate them when a seat is free."
        confirmLabel="Deactivate"
        destructive
        onConfirm={async () => {
          if (deactivating) await setActive.mutateAsync({ operator: deactivating, active: false });
        }}
      />

      <ConfirmDialog
        open={reactivating !== null}
        onOpenChange={(open) => {
          if (!open) setReactivating(null);
        }}
        title={`Reactivate ${reactivating ? reactivating.name || reactivating.email : 'this person'}?`}
        description={
          <>
            They can sign in and be handed conversations again. This takes one of this
            chatbot&rsquo;s seats; if none is free nothing changes.
          </>
        }
        confirmLabel="Reactivate"
        onConfirm={async () => {
          if (reactivating) await setActive.mutateAsync({ operator: reactivating, active: true });
        }}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke the invitation to ${revoking?.email ?? ''}?`}
        description="The link we emailed them stops working. You can invite the same address again."
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
        description="You will be handed conversations and appear to visitors by name. This takes one of your plan's seats."
        confirmLabel="Join live chat"
        onConfirm={async () => {
          await join.mutateAsync();
        }}
      />

      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title="Leave the live-chat roster?"
        description="You stop being routed new conversations and the seat is freed. Conversations you are already in finish normally, and you still own the workspace."
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
        description="Its members stay on the team but lose their grouping, its hours are deleted, and its conversations go to whoever is online."
        confirmLabel="Delete department"
        destructive
        onConfirm={async () => {
          if (deletingDepartment) await removeDepartment.mutateAsync(deletingDepartment);
        }}
      />
    </>
  );
}
