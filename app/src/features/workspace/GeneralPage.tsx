import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  buttonClass,
  Card,
  CardBody,
  ErrorState,
  formatNumber,
  Input,
  LoadingRows,
  LockedState,
  normalizeUrl,
  PropertyGrid,
  SaveBar,
  SettingBand,
  SettingGroup,
  SettingRow,
  Stack,
  toast,
  validateUrl,
} from '../../ui';
import { getCurrentUser, updateClientProfile } from '../../services/api';
import { keys } from '../../query/keys';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useBotContext } from '../../context/BotContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { roleLabel, roleTone } from './roles';
import { describeDirty, useDraft } from './draft';

/**
 * Settings ▸ Workspace — who this account is.
 *
 * Three fields and a fact sheet. The page it replaces put an "Edit details"
 * button beside a read-only card, so the fields were invisible until you asked
 * for them and the page could not tell you whether anything was unsaved. Here
 * the fields *are* the group, and the footer always says which state you are in.
 *
 * The fields and the facts share one form measure, in that order. The fact
 * sheet is read-only context for the form, and as a *full-width* card under a
 * full-width form it was context nobody ever had in view while editing — 500px
 * below the fields, because both boxes were 900px wide to hold a 256px control.
 * At 672 the whole page is about 550px tall and both are on screen at once,
 * which is what putting them side by side was trying to buy.
 *
 * What is deliberately **not** here any more: the chatbot business-hours editor.
 * It wrote `bots[0]` unconditionally, so in a workspace with two chatbots the
 * second could never be given hours and the first was silently edited instead
 * (ledger B1). Hours are a property of a chatbot, so they belong on that
 * chatbot's own Experience page, and this page links there rather than
 * reproducing a control that edits the wrong object.
 */

const FIELD_LABELS = {
  name: 'Name',
  company_name: 'Company',
  website: 'Website',
} as const;

type ProfileFields = { name: string; company_name: string; website: string };

export function GeneralPage() {
  const queryClient = useQueryClient();
  const { currentWorkspaceId, currentRole, workspaces, refresh: refreshWorkspace } = useWorkspace();
  const { bots } = useBotContext();
  const { planName, planSlug, limitFor } = useEntitlements();
  const fieldId = useId();

  const me = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    staleTime: 60_000,
  });

  const draft = useDraft<ProfileFields>({
    name: '',
    company_name: '',
    website: '',
  });

  // Adopt the server's copy exactly once per identity, during render rather
  // than in an effect. React's own "adjust state when a prop changes" pattern:
  // an effect would render the empty form first and then replace it, and
  // re-running on every background refetch would discard whatever the user is
  // halfway through typing.
  const [committedFor, setCommittedFor] = useState<number | null>(null);
  if (me.data && committedFor !== me.data.id) {
    setCommittedFor(me.data.id);
    draft.commit({
      name: me.data.name ?? '',
      company_name: me.data.company_name ?? '',
      website: me.data.website ?? '',
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      const patch: Record<string, string> = {};
      if (draft.patch.name !== undefined) patch.name = draft.patch.name;
      if (draft.patch.company_name !== undefined) patch.company_name = draft.patch.company_name;
      if (draft.patch.website !== undefined) patch.website = normalizeUrl(draft.patch.website);
      return updateClientProfile(patch);
    },
    onSuccess: (updated) => {
      draft.commit({
        name: updated.name ?? '',
        company_name: updated.company_name ?? '',
        website: updated.website ?? '',
      });
      void queryClient.invalidateQueries({ queryKey: keys.session.me() });
      // The rail and the top bar read the workspace name from their own
      // context, not from this query — without this they keep the old name
      // until a reload, which reads as a save that did not take.
      void refreshWorkspace();
      toast.success('Workspace updated');
    },
  });

  function handleSave() {
    const errors: Partial<Record<keyof ProfileFields, string>> = {};
    if (!draft.values.name.trim()) {
      errors.name = 'Give the workspace a name — it is what your team sees in the switcher.';
    }
    const website = draft.values.website.trim();
    if (website) {
      const reason = validateUrl(website);
      if (reason) errors.website = reason;
    }
    if (Object.keys(errors).length > 0) {
      draft.setErrors(errors);
      return;
    }
    save.mutate();
  }

  const isOperator = currentRole === 'operator' || me.data?.kind === 'operator';

  if (me.isPending) {
    return (
      <Card>
        <CardBody>
          <LoadingRows rows={4} />
        </CardBody>
      </Card>
    );
  }

  if (me.isError) {
    return (
      <Card>
        <ErrorState
          title="We could not load this workspace"
          description={me.error instanceof Error ? me.error.message : undefined}
          onRetry={() => void me.refetch()}
        />
      </Card>
    );
  }

  // Forbidden. An operator seat can reach this URL — the router lets them into
  // `/account`, and a linked admin lands here from a bookmark — but
  // `PATCH /client/profile` is client-identity only, so showing them the form
  // would be showing them a save button that always 403s.
  if (isOperator) {
    return (
      <LockedState
        title="Only the workspace owner can change this"
        description="Your name, email and alerts are on your account page."
        action={
          <Link to="/account" className={buttonClass('primary', 'md')}>
            Go to your account
          </Link>
        }
      />
    );
  }

  const botLimit = limitFor('bots');

  return (
    /* One column, not two. `Columns asideWidth="md"` splits at `@5xl/page`
       (1024) and this content column is 904px inside the settings rail at 1440,
       so the side-by-side layout this page was written for never rendered at the
       width it was designed for — the fact sheet sat under the form anyway, with
       the rail's own column empty beside it. Splitting 904 in two instead is
       worse, not better: the control column is a fixed 256px, so a 440px half
       leaves 120px for a label and its hint, and "Shown in the workspace
       switcher." wraps onto three lines.

       The measure is `SettingGroup`'s own now, so there is no `Measure` here:
       both groups cap themselves at 672, which is where a label and its control
       stay bound and where Linear, Stripe and the Razorpay dashboard all put a
       settings form. It is also one right edge for the page — the row's 640px
       pair cap and the save bar's edge were 264px apart at 904 wide. */
    <Stack>
      <SettingGroup title="Identity">
        {save.isError ? (
          <SettingBand>
            <Alert tone="danger" live title="We could not save that">
              {save.error instanceof Error
                ? save.error.message
                : 'Something went wrong. Please try again.'}
            </Alert>
          </SettingBand>
        ) : null}

        <SettingRow
          label={FIELD_LABELS.name}
          htmlFor={`${fieldId}-name`}
          description="Shown in the workspace switcher."
          error={draft.errors.name}
        >
          <Input
            id={`${fieldId}-name`}
            required
            value={draft.values.name}
            onChange={(event) => draft.set('name', event.target.value)}
            placeholder="Acme Support"
            autoComplete="organization"
          />
        </SettingRow>

        <SettingRow
          label={FIELD_LABELS.company_name}
          htmlFor={`${fieldId}-company`}
          description="Printed on invoices."
          error={draft.errors.company_name}
        >
          <Input
            id={`${fieldId}-company`}
            value={draft.values.company_name}
            onChange={(event) => draft.set('company_name', event.target.value)}
            placeholder="Acme Corporation"
          />
        </SettingRow>

        <SettingRow
          label={FIELD_LABELS.website}
          htmlFor={`${fieldId}-website`}
          error={draft.errors.website}
        >
          <Input
            id={`${fieldId}-website`}
            value={draft.values.website}
            onChange={(event) => draft.set('website', event.target.value)}
            placeholder="acme.com"
            inputMode="url"
          />
        </SettingRow>

        <SaveBar
          variant="footer"
          dirty={draft.isDirty}
          summary={describeDirty(draft.dirty, FIELD_LABELS)}
          saving={save.isPending}
          onSave={handleSave}
          onDiscard={draft.reset}
        />
      </SettingGroup>

      <SettingGroup title="This workspace" titleAs="h2">
        <SettingBand>
          <PropertyGrid
            items={[
              {
                label: 'Your role',
                value: (
                  <Badge tone={roleTone(currentRole ?? 'owner')}>
                    {roleLabel(currentRole ?? 'owner')}
                  </Badge>
                ),
              },
              {
                label: 'Plan',
                value: (
                  <Link
                    to="/billing"
                    className="text-accent-600 underline-offset-2 hover:underline"
                  >
                    {planName || planSlug || 'Free'}
                  </Link>
                ),
              },
              {
                label: 'Chatbots',
                value: (
                  <span className="figure">
                    {formatNumber(bots.length)}
                    {botLimit > 0 ? (
                      <span className="text-text-tertiary"> of {formatNumber(botLimit)}</span>
                    ) : null}
                  </span>
                ),
              },
              {
                label: 'Workspace ID',
                value: <span className="figure">{currentWorkspaceId ?? me.data?.id}</span>,
              },
              {
                label: 'Workspaces',
                value: <span className="figure">{formatNumber(workspaces.length || 1)}</span>,
              },
              { label: 'Sign-in email', value: me.data?.email },
            ]}
          />
        </SettingBand>
        <SettingRow
          label="Chatbot settings"
          description="Hours, greeting, tone and the install snippet live on each chatbot."
        >
          <Link to="/chatbots" className={buttonClass('secondary', 'sm')}>
            Open chatbots
          </Link>
        </SettingRow>
      </SettingGroup>
    </Stack>
  );
}
