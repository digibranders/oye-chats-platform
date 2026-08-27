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

/**
 * What this form edits, and what each field is really called.
 *
 * `company_name` is labelled "Workspace name" because that is what it *is*:
 * `GET /me/workspaces` resolves a workspace's display name as
 * `company_name or name or email`, so this field is the one that actually
 * names the workspace everywhere the product shows one.
 *
 * The Client row's `name` used to be edited here too, under the label "Name"
 * and the hint "Shown in the workspace switcher." Both were wrong. It is the
 * PERSON's name — the account menu at the foot of the rail renders it, and so
 * does Home's greeting — and the switcher it named was removed. Worse, it was
 * a second editor for a field `/account` already owns (see
 * `ProfileSection`, whose own docstring says a workspace owner's name lives
 * on the Client row and goes through this same endpoint). Two forms writing
 * one field, one of them describing it as something else entirely. It is gone
 * from here; "Managed elsewhere" at the foot of the page points at its real
 * home.
 */
const FIELD_LABELS = {
  company_name: 'Workspace name',
  website: 'Website',
} as const;

type ProfileFields = { company_name: string; website: string };

export function GeneralPage() {
  const queryClient = useQueryClient();
  const { currentWorkspaceId, currentRole, refresh: refreshWorkspace } = useWorkspace();
  const { bots } = useBotContext();
  const { planName, planSlug, limitFor } = useEntitlements();
  const fieldId = useId();

  const me = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    staleTime: 60_000,
  });

  const draft = useDraft<ProfileFields>({
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
      company_name: me.data.company_name ?? '',
      website: me.data.website ?? '',
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      const patch: Record<string, string> = {};
      if (draft.patch.company_name !== undefined) patch.company_name = draft.patch.company_name;
      if (draft.patch.website !== undefined) patch.website = normalizeUrl(draft.patch.website);
      return updateClientProfile(patch);
    },
    onSuccess: (updated) => {
      draft.commit({
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
    // No required rule on the workspace name. Blank is a real answer: the
    // backend falls back to the owner's own name, so an empty field still
    // produces a workspace that is named somewhere — the row's own hint says
    // as much. Rejecting it would be inventing a constraint the API does not
    // have.
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
          label={FIELD_LABELS.company_name}
          htmlFor={`${fieldId}-company`}
          description="Names this workspace across the app, and on your invoices. Leave it blank to use your own name."
          error={draft.errors.company_name}
        >
          <Input
            id={`${fieldId}-company`}
            value={draft.values.company_name}
            onChange={(event) => draft.set('company_name', event.target.value)}
            placeholder="Acme Corporation"
            autoComplete="organization"
          />
        </SettingRow>

        <SettingRow
          label={FIELD_LABELS.website}
          htmlFor={`${fieldId}-website`}
          // Every other row in this group carries a clause, and a bare label
          // beside two described ones reads as a row that lost its hint.
          description="Where your chatbot lives. Used as the default crawl target."
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

      {/* Facts only, and only the ones somebody reads. "Workspaces: 1" went:
          a count that says "one" to almost every account is not information,
          and the accounts it would say "two" to already switch from the
          account menu. `Workspace ID` stays but sits last — it is the one
          value here nobody wants until support asks for it. */}
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
              { label: 'Sign-in email', value: me.data?.email },
              {
                label: 'Workspace ID',
                value: <span className="figure">{currentWorkspaceId ?? me.data?.id}</span>,
              },
            ]}
          />
        </SettingBand>
      </SettingGroup>

      {/* The two things people come to Settings for and do not find here.
          Both used to be either absent (your own profile) or a lone row
          hanging off the bottom of the fact sheet, where a navigation link
          read as one more read-only property. Named as a group, the absence
          is an answer rather than a gap. */}
      <SettingGroup title="Managed elsewhere" titleAs="h2">
        <SettingRow
          label="Your profile"
          description="Your own name, password, email and alerts."
        >
          <Link to="/account" className={buttonClass('secondary', 'sm')}>
            Open account
          </Link>
        </SettingRow>
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
