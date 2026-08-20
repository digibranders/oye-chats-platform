import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Alert,
  Button,
  CopyField,
  Dialog,
  Field,
  Input,
  RadioCards,
  Select,
  toast,
  validateEmail,
} from '../../ui';
import { createOperatorInvite } from '../../services/api';
import type { Department } from '../../types/domain';
import { assignableRoles, type WorkspaceRole } from './roles';

export interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  botId: number | null;
  botName: string | null;
  departments: readonly Department[];
  callerRole: string | null;
  /** True when the chatbot's seats are already all taken. */
  atSeatLimit: boolean;
  onInvited: () => void;
}

/**
 * Invite someone to the workspace.
 *
 * The invite email can bounce, land in spam, or be sent to someone who has
 * already left — so the accept link is shown here as well, once, to be copied
 * and passed on another way. The console this replaces discarded it, and the
 * only recovery was "Resend" into the same inbox that had already swallowed it.
 */
export function InviteDialog({
  open,
  onOpenChange,
  botId,
  botName,
  departments,
  callerRole,
  atSeatLimit,
  onInvited,
}: InviteDialogProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('operator');
  const [departmentId, setDepartmentId] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);

  // Reset on close, not on open: the fields must survive a failed submit so the
  // user is not made to retype an address the server has just rejected. Done
  // during render rather than in an effect so the dialog never animates out
  // while showing values it is about to clear.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setEmail('');
      setRole('operator');
      setDepartmentId('');
      setEmailError(null);
      setAcceptUrl(null);
    }
  }

  const invite = useMutation({
    mutationFn: async () => {
      if (botId == null) throw new Error('Choose a chatbot before inviting someone.');
      return createOperatorInvite({
        email: email.trim(),
        botId,
        role,
        departmentId: departmentId ? Number(departmentId) : null,
      });
    },
    onSuccess: (created) => {
      toast.success(`Invitation sent to ${email.trim()}`);
      setAcceptUrl(created?.accept_url ?? null);
      onInvited();
      // Stay open only when there is a link worth copying; otherwise the job is
      // done and the dialog is in the way.
      if (!created?.accept_url) onOpenChange(false);
    },
  });

  function submit() {
    const trimmed = email.trim();
    const reason = trimmed ? validateEmail(trimmed) : 'Enter the email address to invite.';
    if (reason) {
      setEmailError(reason);
      return;
    }
    setEmailError(null);
    invite.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Invite a teammate"
      description={
        botName
          ? `They will be able to answer conversations on ${botName}.`
          : 'They will be able to answer conversations on this chatbot.'
      }
      dismissible={!invite.isPending}
      footer={
        acceptUrl ? (
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={invite.isPending}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              loading={invite.isPending}
              disabled={atSeatLimit || botId == null}
            >
              Send invitation
            </Button>
          </>
        )
      }
    >
      <div className="space-y-5">
        {acceptUrl ? (
          <>
            <Alert tone="success" title="Invitation sent">
              We emailed {email.trim()}. If it does not arrive, send them this link instead — it
              works exactly once and expires with the invitation.
            </Alert>
            <CopyField value={acceptUrl} label="invitation link" />
          </>
        ) : (
          <>
            {atSeatLimit ? (
              <Alert tone="warning" title="No seats left on this chatbot">
                Your plan's seats for this chatbot are all taken. Remove someone, or add seats from
                Billing, and the invitation will go through.
              </Alert>
            ) : null}

            {botId == null ? (
              <Alert tone="warning" title="No chatbot selected">
                Seats belong to a chatbot, so pick one before inviting anyone.
              </Alert>
            ) : null}

            {invite.isError ? (
              <Alert tone="danger" live title="We could not send that invitation">
                {invite.error instanceof Error
                  ? invite.error.message
                  : 'Something went wrong. Please try again.'}
              </Alert>
            ) : null}

            <Field
              label="Email address"
              required
              hint="They get a sign-in link — no account needed first."
              error={emailError}
            >
              <Input
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailError(null);
                }}
                placeholder="teammate@example.com"
                autoComplete="off"
              />
            </Field>

            {/* All three roles readable at once. See `MemberDialog` — this was
                the same `Select`-plus-live-region workaround, copied. */}
            <Field label="Role" required>
              <RadioCards
                label="Role"
                columns={1}
                value={role}
                onChange={setRole}
                items={assignableRoles(callerRole).map((definition) => ({
                  value: definition.value,
                  label: definition.label,
                  description: definition.summary,
                }))}
              />
            </Field>

            <Field label="Department" optional hint="Routes a conversation to a group.">
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
          </>
        )}
      </div>
    </Dialog>
  );
}
