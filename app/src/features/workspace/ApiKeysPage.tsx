import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  ConfirmDialog,
  CopyField,
  Dialog,
  ErrorState,
  LoadingRows,
  LockedState,
  PageHeader,
  Section,
  Stack,
  buttonClass,
  toast,
} from '../../ui';
import { getApiBaseUrl, getClientApiKey, regenerateClientApiKey } from '../../services/api';
import { setAuthItem } from '../../utils/authStorage';
import { keys } from '../../query/keys';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useWorkspace } from '../../context/WorkspaceContext';

/**
 * Settings ▸ Developers — the workspace's API key, and how to use it.
 *
 * Two things this page has to get right.
 *
 * **A key is shown in full exactly once.** After that it is a mask, and a mask
 * has no copy button: the console this replaces put one there, and it copied
 * the bullets. A button that silently puts `••••••a3f9` on the clipboard is
 * worse than no button, because the user believes they have the key.
 *
 * **Rotating it signs out every integration — including this browser.** The
 * console authenticates with the same `X-API-Key` the API does (see the request
 * interceptor in `services/api.js`), so the old key stops working the instant
 * the new one is issued. The previous page rotated and left the stale key in
 * `localStorage`, so the next request 401'd and the user was thrown to the
 * login screen holding a key they had not copied. Here the new key is written
 * back to the session before the reveal dialog opens, and the confirmation says
 * plainly what else breaks.
 */

export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const { hasFeature } = useEntitlements();
  const { currentRole } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  const isOperator = currentRole === 'operator';

  const apiKey = useQuery({
    queryKey: keys.workspace.apiKey(),
    queryFn: getClientApiKey,
    staleTime: 5 * 60_000,
    retry: false,
    // A team seat is never shown the workspace credential, so it must not ask
    // for it either — a request whose 403 is a foregone conclusion is noise in
    // the logs and a rate-limit budget spent on nothing.
    enabled: !isOperator,
  });

  const rotate = useMutation({
    mutationFn: regenerateClientApiKey,
    onSuccess: (result) => {
      // Before anything else: the session's credential *is* this key. Writing
      // it back is what keeps the user signed in through the rotation.
      setAuthItem('admin_token', result.api_key);
      queryClient.setQueryData(keys.workspace.apiKey(), {
        api_key_masked: result.api_key_masked,
      });
      setConfirming(false);
      setRevealed(result.api_key);
      toast.success('API key rotated');
    },
  });

  const header = (
    <PageHeader
      title="Developers"
      description="One key authenticates every request your own software makes to OyeChats."
    />
  );

  const forbidden = isOperator || (apiKey.isError && statusOf(apiKey.error) === 403);

  if (forbidden) {
    return (
      <>
        {header}
        <LockedState
          title="Only the workspace owner can see the API key"
          description="The key authenticates as the whole workspace, so it is not shown to team seats. Ask an owner if you need it."
          action={
            <Link to="/account" className={buttonClass('primary', 'md')}>
              Go to your account
            </Link>
          }
        />
      </>
    );
  }

  return (
    <>
      {header}
      <Stack>
        <Card>
          <CardHeader
            eyebrow="Secret"
            title="Workspace API key"
            titleAs="h2"
            description="Send it as an X-API-Key header. Treat it like a password — anyone holding it can read and change everything in this workspace."
            actions={
              <Button
                variant="secondary"
                onClick={() => setConfirming(true)}
                disabled={apiKey.isPending || apiKey.isError}
                iconLeft={<RefreshCw aria-hidden className="h-3.5 w-3.5" />}
              >
                Rotate key
              </Button>
            }
          />
          <CardBody>
            {apiKey.isPending ? (
              <LoadingRows rows={1} />
            ) : apiKey.isError ? (
              <ErrorState
                compact
                title="We could not load your API key"
                description={apiKey.error instanceof Error ? apiKey.error.message : undefined}
                onRetry={() => void apiKey.refetch()}
              />
            ) : (
              <>
                {/* Deliberately not a `CopyField`: this is the mask, and the
                    only honest thing to do with a mask is show it. */}
                <p className="text-xs text-text-secondary">Currently in use</p>
                <p className="figure mt-1 text-base text-text-primary">
                  {apiKey.data.api_key_masked}
                </p>
                <p className="mt-3 text-xs leading-relaxed text-text-secondary">
                  We only ever store a hash of what you see here, so the full key cannot be shown
                  again. If you have lost it, rotate it and copy the new one.
                </p>
              </>
            )}
          </CardBody>
        </Card>

        <Section
          title="Making a request"
          description="Every endpoint takes the same header. There is nothing else to set up."
        >
          <Card>
            <CardBody className="space-y-4">
              <div>
                <p className="text-base font-medium text-text-primary">Base URL</p>
                <CopyField className="mt-1.5" value={getApiBaseUrl()} label="API base URL" />
              </div>
              <CodeBlock
                label="example request"
                caption="Replace <endpoint> and paste your key"
                code={`curl ${getApiBaseUrl()}/<endpoint> \\\n  -H "X-API-Key: <your-api-key>"`}
              />
              <Alert tone="neutral">
                A key belongs to the workspace, not to you. Rotating it is how you revoke access for
                someone who has left — removing them from the team does not invalidate a key they
                already copied.
              </Alert>
            </CardBody>
          </Card>
        </Section>

        <Section
          title="On your plan"
          description="What the plan says about programmatic access and support."
        >
          <Card>
            <CardBody className="space-y-3">
              <PlanRow
                label="API access"
                included={hasFeature('api_access')}
                includedText="Included. Build against the REST API with the key above."
                excludedText="Not included on your plan. The key above still authenticates this dashboard, and the endpoints are not currently blocked — but API access is not something we support on this plan, so treat it as unsupported until you upgrade."
              />
              <PlanRow
                label="Priority support"
                included={hasFeature('online_support')}
                includedText="Included. Your questions are answered ahead of the general queue."
                excludedText="Not included on your plan. Email support is still available to everyone."
              />
              <PlanRow
                label="Webhooks"
                included={hasFeature('webhooks')}
                includedText="Included. Register endpoints under Integrations to receive events."
                excludedText="Not included on your plan. Webhooks are how you get told about a lead without polling."
              />
              <div className="pt-1">
                <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                  Compare plans
                </Link>
              </div>
            </CardBody>
          </Card>
        </Section>
      </Stack>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Rotate the workspace API key?"
        description={
          <>
            The current key stops working immediately. Every script, integration and server that
            sends it will start getting 401s until you paste the new one in. This dashboard uses the
            same key, so we will update it here for you and keep you signed in — but any{' '}
            <strong>other</strong> tab or device you are signed in on will be signed out. The new
            key is shown once, and cannot be shown again.
          </>
        }
        confirmLabel="Rotate key"
        destructive
        onConfirm={async () => {
          await rotate.mutateAsync();
        }}
      />

      <Dialog
        open={revealed !== null}
        onOpenChange={(open) => {
          if (!open) setRevealed(null);
        }}
        title="Your new API key"
        description="Copy it now. This is the only time it is shown in full."
        footer={<Button onClick={() => setRevealed(null)}>I have copied it</Button>}
      >
        <div className="space-y-4">
          <Alert tone="warning" live>
            Once you close this, the key becomes a mask. If you lose it you will have to rotate
            again and update every integration a second time.
          </Alert>
          {revealed ? <CopyField value={revealed} label="new API key" /> : null}
          <p className="text-xs leading-relaxed text-text-secondary">
            <KeyRound aria-hidden className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
            Store it in your server's secret manager, not in source control.
          </p>
        </div>
      </Dialog>
    </>
  );
}

function PlanRow({
  label,
  included,
  includedText,
  excludedText,
}: {
  label: string;
  included: boolean;
  includedText: string;
  excludedText: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium text-text-primary">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
          {included ? includedText : excludedText}
        </p>
      </div>
      <Badge tone={included ? 'success' : 'neutral'}>{included ? 'Included' : 'Not included'}</Badge>
    </div>
  );
}

function statusOf(error: unknown): number | undefined {
  const withResponse = error as { response?: { status?: number }; status?: number } | null;
  return withResponse?.response?.status ?? withResponse?.status;
}
