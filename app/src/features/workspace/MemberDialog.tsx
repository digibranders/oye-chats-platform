import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import {
  Alert,
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  RadioCards,
  Select,
  buttonClass,
  toast,
} from '../../ui';
import { updateOperator } from '../../services/api';
import type { Department, Operator } from '../../types/domain';
import {
  assignableRoles,
  roleChangeConsequence,
  roleDefinition,
  validateConcurrentChats,
  type WorkspaceRole,
} from './roles';

/** "an admin" / "an operator" / "an owner" — every role here starts with a vowel,
 *  but the helper keeps the sentence correct if one ever does not. */
function article(label: string): string {
  const lower = label.toLowerCase();
  return `${/^[aeiou]/.test(lower) ? 'an' : 'a'} ${lower}`;
}

export interface MemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: Operator | null;
  departments: readonly Department[];
  /** The signed-in person's own role — decides whether Owner may be granted. */
  callerRole: string | null;
  /** True when this row is the signed-in person's own seat. */
  isSelf: boolean;
  onSaved: () => void;
}

/**
 * Edit a teammate.
 *
 * Split by who owns the field, exactly as the backend splits it. Name and email
 * are personal identity: `PATCH /operators/{id}` returns 403 unless the caller
 * *is* that operator, because an admin who could rewrite a colleague's email
 * could quietly redirect their sign-in. So they are shown read-only here, with
 * a pointer to the one place they can be changed — the person's own account
 * page. The console this replaces rendered them as editable inputs, which
 * produced a form that always failed for the only people who could open it.
 *
 * The role picker explains each role while it is being chosen. "Admin" on its
 * own does not tell the person choosing that they are handing over the ability
 * to remove other teammates, and the previous console asked that question with
 * a bare three-item dropdown and no confirmation of any kind.
 */
export function MemberDialog({
  open,
  onOpenChange,
  member,
  departments,
  callerRole,
  isSelf,
  onSaved,
}: MemberDialogProps) {
  const [role, setRole] = useState<WorkspaceRole>('operator');
  const [departmentId, setDepartmentId] = useState('');
  const [capacity, setCapacity] = useState('3');
  const [capacityError, setCapacityError] = useState<string | null>(null);
  const [confirmingRole, setConfirmingRole] = useState(false);

  // Seeded during render, keyed on the member's id. Two reasons it is not an
  // effect: the dialog would paint one frame of the previous member's values,
  // and keying on the id (rather than on `open`) means re-opening the same row
  // does not discard a correction the user has not saved.
  const [seededFor, setSeededFor] = useState<number | null>(null);
  if (member && seededFor !== member.id) {
    setSeededFor(member.id);
    setRole((member.role as WorkspaceRole) ?? 'operator');
    setDepartmentId(member.department_id != null ? String(member.department_id) : '');
    setCapacity(String(member.max_concurrent_chats ?? 3));
    setCapacityError(null);
    setConfirmingRole(false);
  }

  const save = useMutation({
    mutationFn: async (parsedCapacity: number) => {
      if (!member) throw new Error('No member selected.');
      return updateOperator(member.id, {
        role,
        department_id: departmentId ? Number(departmentId) : null,
        max_concurrent_chats: parsedCapacity,
      });
    },
    onSuccess: () => {
      toast.success(`${member?.name ?? 'Member'} updated`);
      setConfirmingRole(false);
      onOpenChange(false);
      onSaved();
    },
  });

  if (!member) return null;

  const roleChanged = role !== member.role;
  const options = assignableRoles(callerRole);

  function attemptSave() {
    const parsed = validateConcurrentChats(capacity);
    if (parsed.error !== null || parsed.value === null) {
      setCapacityError(parsed.error);
      return;
    }
    setCapacityError(null);
    if (roleChanged) {
      setConfirmingRole(true);
      return;
    }
    save.mutate(parsed.value);
  }

  async function confirmRoleChange(): Promise<void> {
    const parsed = validateConcurrentChats(capacity);
    if (parsed.value === null) {
      setConfirmingRole(false);
      setCapacityError(parsed.error);
      return;
    }
    await save.mutateAsync(parsed.value);
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={member.name || member.email}
        description="What this person can do, and how much live chat they are handed."
        dismissible={!save.isPending}
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={attemptSave} loading={save.isPending}>
              {roleChanged ? 'Review and save' : 'Save changes'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {save.isError ? (
            <Alert tone="danger" live title="We could not save that">
              {save.error instanceof Error
                ? save.error.message
                : 'Something went wrong. Please try again.'}
            </Alert>
          ) : null}

          <Field
            label="Email"
            hint={
              isSelf
                ? 'Yours to change, on your account page.'
                : 'Only this person can change their own email.'
            }
          >
            <Input value={member.email} readOnly disabled />
          </Field>

          {isSelf ? (
            <Link to="/account" className={buttonClass('secondary', 'sm')}>
              Edit your name and email
            </Link>
          ) : null}

          {/* Every role's summary, visible at once. This was a `Select` with a
              live region beside it printing the selected role's capabilities —
              the workaround `RadioCards`' own docstring names verbatim. It
              forced the reader to change the value in order to read what each
              value meant, so they could not compare before choosing. The
              consequence of the change still lands in the confirmation. */}
          <Field label="Role" required>
            <RadioCards
              label="Role"
              columns={1}
              value={role}
              onChange={setRole}
              items={options.map((definition) => ({
                value: definition.value,
                label: definition.label,
                description: definition.summary,
              }))}
            />
          </Field>

          <Field label="Department" optional hint="Routes a conversation to a group.">
            {/* An explicit "no department" option rather than a placeholder:
                a placeholder renders a *disabled* option, so once a department
                was chosen the user could never take it away again. */}
            <Select
              value={departmentId}
              options={[
                { value: '', label: 'No department' },
                ...departments.map((department) => ({
                  value: String(department.id),
                  label: department.name,
                })),
              ]}
              onChange={(event) => setDepartmentId(event.target.value)}
            />
          </Field>

          <Field
            label="Live chats at once"
            required
            hint="Between 1 and 100."
            error={capacityError}
          >
            <Input
              value={capacity}
              onChange={(event) => {
                setCapacity(event.target.value);
                setCapacityError(null);
              }}
              inputMode="numeric"
              className="figure"
            />
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmingRole}
        onOpenChange={setConfirmingRole}
        title={`Make ${member.name || member.email} ${article(roleDefinition(role)?.label ?? role)}?`}
        description={roleChangeConsequence(member.name || member.email, member.role, role)}
        confirmLabel="Change role"
        destructive={role === 'owner' || member.role === 'owner'}
        onConfirm={confirmRoleChange}
      />
    </>
  );
}
