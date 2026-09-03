import { useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Avatar,
  Button,
  Input,
  SaveBar,
  SettingBand,
  SettingGroup,
  SettingRow,
  toast,
  validateEmail,
} from '../../ui';
import {
  removeOperatorAvatar,
  updateClientProfile,
  updateOperator,
  uploadOperatorAvatar,
} from '../../services/api';
import {
  AVATAR_ACCEPT,
  avatarHint,
  validateAvatarFile,
} from '../agents/experience/avatarRules';
import { keys } from '../../query/keys';
import type { CurrentUser } from '../../types/domain';
import { describeDirty, useDraft } from '../workspace/draft';
import { useTranslation } from '../../i18n/useTranslation';

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
  const { t } = useTranslation();
  const fieldId = useId();
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
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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
      toast.success(t('settings.profileUpdated') || 'Profile updated');
    },
  });

  /**
   * The picture is saved the moment it is chosen, not with the form.
   *
   * It is a separate endpoint from the profile PATCH, and pairing it with the
   * save bar would mean a dirty form the user cannot discard back — the file is
   * already uploaded by then. Immediate is also what every product does with an
   * avatar, and it is undoable in one click.
   */
  const avatar = useMutation({
    mutationFn: async (file: File | null) =>
      file ? (await uploadOperatorAvatar(file)).avatar_url : (await removeOperatorAvatar(), null),
    onSuccess: (avatar_url) => {
      void queryClient.invalidateQueries({ queryKey: keys.session.me() });
      toast.success(avatar_url ? t('settings.pictureUpdated') || 'Picture updated' : t('settings.pictureRemoved') || 'Picture removed');
    },
  });

  function chooseFile(file: File | undefined) {
    if (!file) return;
    const reason = validateAvatarFile(file);
    if (reason) {
      setAvatarError(reason);
      return;
    }
    setAvatarError(null);
    avatar.mutate(file);
  }

  function submit() {
    const errors: Record<string, string> = {};
    if (!draft.values.name.trim()) {
      errors.name = t('settings.enterYourNameVisitorsSee') || 'Enter your name. Visitors see it beside every message you send.';
    }
    if (isOperator) {
      const email = draft.values.email.trim();
      const reason = email ? validateEmail(email) : t('settings.enterYourEmailAddress') || 'Enter your email address.';
      if (reason) errors.email = reason;
    }
    if (Object.keys(errors).length > 0) {
      draft.setErrors(errors);
      return;
    }
    save.mutate();
  }

  return (
    <SettingGroup title={t('settings.profile') || 'Profile'}>
      {save.isError ? (
        <SettingBand>
          <Alert tone="danger" live title={t('settings.weCouldNotSaveThat') || 'We could not save that'}>
            {save.error instanceof Error
              ? save.error.message
              : t('settings.somethingWentWrongPleaseTry') || 'Something went wrong. Please try again.'}
          </Alert>
        </SettingBand>
      ) : null}

      <SettingRow
        label={t('settings.picture') || 'Picture'}
        description={
          isOperator
            ? t('settings.optionalTeammatesAndVisitorsSee') || 'Optional. Teammates and visitors see it beside your messages; without one they see your initials.'
            : t('settings.fromTheAccountYouSigned') || 'From the account you signed in with.'
        }
        controlWidth="auto"
        error={avatarError ?? undefined}
      >
        <span className="flex items-center gap-3">
          <Avatar name={draft.values.name || user.email || t('settings.you') || 'You'} size="lg" src={user.avatar_url} />
          {isOperator ? (
            <>
              {/* A hidden input driven by real buttons: a styled `<label>`
                  wrapping a file input is not in the tab order as a button and
                  announces as a label, so the keyboard path to it is guesswork. */}
              <input
                ref={fileInput}
                type="file"
                accept={AVATAR_ACCEPT.join(',')}
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // Cleared so choosing the same file twice still fires.
                  event.target.value = '';
                  chooseFile(file);
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                loading={avatar.isPending}
                onClick={() => fileInput.current?.click()}
              >
                {user.avatar_url ? t('settings.replace') || 'Replace' : t('settings.upload') || 'Upload'}
              </Button>
              {user.avatar_url ? (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={avatar.isPending}
                  onClick={() => avatar.mutate(null)}
                >
                  {t('settings.remove') || 'Remove'}
                </Button>
              ) : null}
            </>
          ) : null}
        </span>
      </SettingRow>
      {isOperator ? <SettingBand>{avatarHint()}</SettingBand> : null}

      <SettingRow
        label={t('settings.name') || 'Name'}
        htmlFor={`${fieldId}-name`}
        description={isOperator ? t('settings.visitorsSeeThisBesideYour') || 'Visitors see this beside your messages.' : undefined}
        error={draft.errors.name}
      >
        <Input
          id={`${fieldId}-name`}
          required
          value={draft.values.name}
          onChange={(event) => draft.set('name', event.target.value)}
          autoComplete="name"
          placeholder={t('settings.priyaSharma') || 'Priya Sharma'}
        />
      </SettingRow>

      {isOperator ? (
        <SettingRow
          label={t('settings.email') || 'Email'}
          htmlFor={`${fieldId}-email`}
          description={t('settings.onlyYouCanChangeThis') || 'Only you can change this.'}
          error={draft.errors.email}
        >
          <Input
            id={`${fieldId}-email`}
            type="email"
            required
            value={draft.values.email ?? ''}
            onChange={(event) => draft.set('email', event.target.value)}
            autoComplete="email"
          />
        </SettingRow>
      ) : null}

      <SaveBar
        variant="footer"
        dirty={draft.isDirty}
        summary={describeDirty(draft.dirty, isOperator ? OPERATOR_LABELS : CLIENT_LABELS)}
        saving={save.isPending}
        onSave={submit}
        onDiscard={draft.reset}
      />
    </SettingGroup>
  );
}
