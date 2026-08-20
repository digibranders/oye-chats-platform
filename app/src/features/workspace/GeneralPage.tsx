import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, buttonClass, Card, CardBody, CardHeader, DefinitionList, ErrorState, Field, formatNumber, Input, LoadingRows, LockedState, normalizeUrl, PageHeader, SaveBar, Section, Stack, toast, validateUrl } from '../../ui';
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
 * the fields *are* the card, and the footer always says which state you are in.
 *
 * What is deliberately **not** here any more: the chatbot business-hours editor.
 * It wrote `bots[0]` unconditionally, so in a workspace with two chatbots the
 * second could never be given hours and the first was silently edited instead
 * (ledger B1). Hours are a property of a chatbot, so they belong on that
 * chatbot's own Experience page, and this page links there rather than
 * reproducing a control that edits the wrong object.
 */

const FIELD_LABELS = {
  name: 'Workspace name',
  company_name: 'Company',
  website: 'Website',
} as const;

type ProfileFields = { name: string; company_name: string; website: string };

export function GeneralPage() {
  const queryClient = useQueryClient();
  const { currentWorkspaceId, currentRole, workspaces, refresh: refreshWorkspace } = useWorkspace();
  const { bots } = useBotContext();
  const { planName, planSlug, limitFor } = useEntitlements();

  const me = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    staleTime: 60_000,
  });

  const draft = useDraft<ProfileFields>({ name: '', company_name: '', website: '' });

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

  const header = (
    <PageHeader
      title="Workspace"
      description="The account your chatbots, conversations and billing belong to."
    />
  );

  if (me.isPending) {
    return (
      <>
        {header}
        <Card>
          <CardBody>
            <LoadingRows rows={4} />
          </CardBody>
        </Card>
      </>
    );
  }

  if (me.isError) {
    return (
      <>
        {header}
        <Card>
          <ErrorState
            title="We could not load this workspace"
            description={me.error instanceof Error ? me.error.message : undefined}
            onRetry={() => void me.refetch()}
          />
        </Card>
      </>
    );
  }

  // Forbidden. An operator seat can reach this URL — the router lets them into
  // `/account`, and a linked admin lands here from a bookmark — but
  // `PATCH /client/profile` is client-identity only, so showing them the form
  // would be showing them a save button that always 403s.
  if (isOperator) {
    return (
      <>
        {header}
        <LockedState
          title="Only the workspace owner can change this"
          description="You are signed in with a team seat. The workspace name, company and website belong to the account that owns it — ask an owner to change them. Your own name, email and alerts are on your account page."
          action={
            <Link to="/account" className={buttonClass('primary', 'md')}>
              Go to your account
            </Link>
          }
        />
      </>
    );
  }

  const botLimit = limitFor('bots');

  return (
    <>
      {header}
      <Stack>
        <Card>
          <CardHeader
            title="Identity"
            titleAs="h2"
            description="Shown to your team in the workspace switcher, and on the invoices we issue you."
          />
          <CardBody className="space-y-5">
            {save.isError ? (
              <Alert tone="danger" live title="We could not save that">
                {save.error instanceof Error
                  ? save.error.message
                  : 'Something went wrong. Please try again.'}
              </Alert>
            ) : null}

            <Field
              label={FIELD_LABELS.name}
              required
              hint="What your team sees in the workspace switcher."
              error={draft.errors.name}
            >
              <Input
                value={draft.values.name}
                onChange={(event) => draft.set('name', event.target.value)}
                placeholder="Acme Support"
                autoComplete="organization"
              />
            </Field>

            <Field
              label={FIELD_LABELS.company_name}
              hint="Your registered business name. Used on invoices."
              error={draft.errors.company_name}
            >
              <Input
                value={draft.values.company_name}
                onChange={(event) => draft.set('company_name', event.target.value)}
                placeholder="Acme Corporation"
              />
            </Field>

            <Field
              label={FIELD_LABELS.website}
              hint="Your main site. New chatbots start from this address when you train them."
              error={draft.errors.website}
            >
              <Input
                value={draft.values.website}
                onChange={(event) => draft.set('website', event.target.value)}
                placeholder="acme.com"
                inputMode="url"
              />
            </Field>
          </CardBody>
          <SaveBar
          variant="footer"
            dirty={draft.isDirty}
            summary={describeDirty(draft.dirty, FIELD_LABELS)}
            saving={save.isPending}
            onSave={handleSave}
            onDiscard={draft.reset}
          />
        </Card>

        <Section
          title="This workspace"
          description="Facts about the account, not settings. Change the plan from Billing."
        >
          <Card>
            <CardBody>
              <DefinitionList
                columns={2}
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
                    value: (
                      <span className="figure">{currentWorkspaceId ?? me.data?.id ?? '—'}</span>
                    ),
                  },
                  {
                    label: 'Workspaces you belong to',
                    value: <span className="figure">{formatNumber(workspaces.length || 1)}</span>,
                  },
                  {
                    label: 'Sign-in email',
                    value: me.data?.email ?? '—',
                  },
                ]}
              />
            </CardBody>
          </Card>
        </Section>

        <Section
          title="Chatbot settings"
          description="Anything that changes how one chatbot behaves lives on that chatbot."
        >
          <Card>
            <CardBody>
              <Alert
                tone="neutral"
                action={
                  <Link to="/chatbots" className={buttonClass('secondary', 'sm')}>
                    Open chatbots
                  </Link>
                }
              >
                Business hours, greeting, tone, knowledge and the install snippet are set per
                chatbot, so a workspace with two of them can give each its own. Open a chatbot and
                use its Experience and Deploy tabs.
              </Alert>
            </CardBody>
          </Card>
        </Section>
      </Stack>
    </>
  );
}
