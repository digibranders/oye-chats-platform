import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Avatar,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  toast,
  validateEmail,
} from '../../ui';
import { updateClientProfile, updateOperator } from '../../services/api';
import { keys } from '../../query/keys';
import type { CurrentUser } from '../../types/domain';
import { describeDirty, useDraft } from '../workspace/draft';
import { SaveBar } from '../workspace/SaveBar';

export interface ProfileSectionProps {
  user: CurrentUser;
  onSaved: (patch: { name?: string; email?: string }) => void;
}

const CLIENT_LABELS = { name: 'Name' } as const;
const OPERATOR_LABELS = { name: 'Name', email: 'Email' } as const;

/**
 * Your own name — and, for a team seat, your own email.
 *
 * The split follows the backend exactly. `PATCH /operators/{id}` refuses a
 * name or email change unless the caller *is* that operator, which is why the
 * team page shows those fields read-only and points here. It is also the
 * ledger's "operator profile edit": a team member could be edited by an admin
 * (role, department, capacity) and had no way at all to correct their own name,
 * which is the one that appears beside every message they send a visitor.
 *
 * A workspace owner's name lives on the Client row instead, so it goes through
 * `PATCH /client/profile`. Their email is a sign-in credential and moves
 * through the verified change flow below, never through this form.
 */
export function ProfileSection({ user, onSaved }: ProfileSectionProps) {
  const queryClient = useQueryClient();
  const isOperator = user.kind === 'operator';

  const draft = useDraft<Record<string, string>>({
    name: user.name ?? '',
    ...(isOperator ? { email: user.email ?? '' } : {}),
  });
  // Adopted during render, not in an effect: the form must never paint blank
  // and then fill in, and a background refetch must never overwrite an edit in
  // progress. See React's "adjust state when a prop changes".
  const [adoptedFor, setAdoptedFor] = useState<number | null>(null);
  if (adoptedFor !== user.id) {
    setAdoptedFor(user.id);
    draft.commit({
      name: user.name ?? '',
      ...(isOperator ? { email: user.email ?? '' } : {}),
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      const name = draft.values.name.trim();
      if (isOperator) {
        const patch: Record<string, string> = {};
        if (draft.patch.name !== undefined) patch.name = name;
        if (draft.patch.email !== undefined) patch.email = draft.values.email.trim().toLowerCase();
        await updateOperator(user.id, patch);
        return { name, email: draft.values.email.trim().toLowerCase() };
      }
      const updated = await updateClientProfile({ name });
      return { name: updated.name, email: user.email };
    },
    onSuccess: (result) => {
      draft.commit({
        name: result.name ?? '',
        ...(isOperator ? { email: result.email ?? '' } : {}),
      });
      void queryClient.invalidateQueries({ queryKey: keys.session.me() });
      onSaved({ name: result.name, email: result.email });
      toast.success('Profile updated');
    },
  });

  function submit() {
    const errors: Record<string, string> = {};
    if (!draft.values.name.trim()) {
      errors.name = 'Enter your name — visitors see it beside every message you send.';
    }
    if (isOperator) {
      const email = draft.values.email.trim();
      const reason = email ? validateEmail(email) : 'Enter your email address.';
      if (reason) errors.email = reason;
    }
    if (Object.keys(errors).length > 0) {
      draft.setErrors(errors);
      return;
    }
    save.mutate();
  }

  return (
    <Card>
      <CardHeader
        title="Profile"
        titleAs="h2"
        description={
          isOperator
            ? 'Your name is what visitors see when you take a conversation over from the chatbot.'
            : 'How you appear to your team.'
        }
      />
      <CardBody className="space-y-5">
        {save.isError ? (
          <Alert tone="danger" live title="We could not save that">
            {save.error instanceof Error
              ? save.error.message
              : 'Something went wrong. Please try again.'}
          </Alert>
        ) : null}

        <div className="flex items-center gap-3">
          <Avatar name={draft.values.name || user.email || 'You'} size="lg" src={user.avatar_url} />
          <p className="text-xs text-text-secondary">
            Your picture comes from the account you signed in with. There is nothing to upload
            here.
          </p>
        </div>

        <Field label="Name" required error={draft.errors.name}>
          <Input
            value={draft.values.name}
            onChange={(event) => draft.set('name', event.target.value)}
            autoComplete="name"
            placeholder="Priya Sharma"
          />
        </Field>

        {isOperator ? (
          <Field
            label="Email"
            required
            hint="Where your sign-in link goes. Only you can change it — not an admin, and not the workspace owner."
            error={draft.errors.email}
          >
            <Input
              type="email"
              value={draft.values.email ?? ''}
              onChange={(event) => draft.set('email', event.target.value)}
              autoComplete="email"
            />
          </Field>
        ) : null}
      </CardBody>
      <SaveBar
        dirty={draft.isDirty}
        summary={describeDirty(draft.dirty, isOperator ? OPERATOR_LABELS : CLIENT_LABELS)}
        saving={save.isPending}
        onSave={submit}
        onDiscard={draft.reset}
      />
    </Card>
  );
}
