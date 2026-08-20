import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  CardSection,
  CodeBlock,
  ConfirmDialog,
  Columns,
  CopyField,
  Dialog,
  ErrorState,
  LoadingRows,
  LockedState,
  SettingGroup,
  SettingRow,
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

  const forbidden = isOperator || (apiKey.isError && statusOf(apiKey.error) === 403);

  if (forbidden) {
    return (
      <LockedState
        title="Only the workspace owner can see the API key"
        description="The key authenticates as the whole workspace, so it is not shown to team seats."
        action={
          <Link to="/account" className={buttonClass('primary', 'md')}>
            Go to your account
          </Link>
        }
      />
    );
  }

  return (
    <>
      <Columns
        asideWidth="sm"
        asideLabel="On your plan"
        main={
          <SettingGroup
            title="Workspace API key"
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setConfirming(true)}
                disabled={apiKey.isPending || apiKey.isError}
                iconLeft={<RefreshCw aria-hidden />}
              >
                Rotate key
              </Button>
            }
          >
            {apiKey.isPending ? (
              <div className="px-cell py-4">
                <LoadingRows rows={1} />
              </div>
            ) : apiKey.isError ? (
              <ErrorState
                size="panel"
                title="We could not load your API key"
                description={apiKey.error instanceof Error ? apiKey.error.message : undefined}
                onRetry={() => void apiKey.refetch()}
              />
            ) : (
              <SettingRow
                label="Current key"
                description="Stored as a hash — rotate to get a new one."
                controlWidth="auto"
              >
                {/* Deliberately not a `CopyField`: this is the mask, and the
                    only honest thing to do with a mask is show it. */}
                <span className="figure text-base text-text-primary">
                  {apiKey.data.api_key_masked}
                </span>
              </SettingRow>
            )}

            <SettingRow label="Base URL" controlWidth="auto">
              <CopyField className="w-64" compact value={getApiBaseUrl()} label="API base URL" />
            </SettingRow>

            <CardSection className="space-y-4">
              <CodeBlock
                label="example request"
                caption="Replace <endpoint> and paste your key"
                code={`curl ${getApiBaseUrl()}/<endpoint> \\\n  -H "X-API-Key: <your-api-key>"`}
              />
              {/* A genuine security note, and a band of the card that owns the
                  code block rather than the sole content of a card body. */}
              <Alert tone="neutral">
                Treat it like a password. Rotating is how you revoke access for someone who has left
                — removing them from the team does not invalidate a key they already copied.
              </Alert>
            </CardSection>
          </SettingGroup>
        }
        aside={
          <SettingGroup
            title="On your plan"
            actions={
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                Compare
              </Link>
            }
          >
            <SettingRow
              label="API access"
              description={
                hasFeature('api_access')
                  ? 'Build against the REST API with the key above.'
                  : 'Unsupported on this plan.'
              }
              controlWidth="auto"
            >
              <PlanBadge included={hasFeature('api_access')} />
            </SettingRow>
            <SettingRow
              label="Priority support"
              description={
                hasFeature('online_support')
                  ? 'Answered ahead of the general queue.'
                  : 'Email support is included on every plan.'
              }
              controlWidth="auto"
            >
              <PlanBadge included={hasFeature('online_support')} />
            </SettingRow>
            <SettingRow
              label="Webhooks"
              description={
                hasFeature('webhooks')
                  ? 'Register endpoints under Integrations.'
                  : 'Push leads to your CRM without polling.'
              }
              controlWidth="auto"
            >
              <PlanBadge included={hasFeature('webhooks')} />
            </SettingRow>
          </SettingGroup>
        }
      />

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Rotate the workspace API key?"
        description={
          <>
            Every script and server sending the old key will start getting 401s until you paste the
            new one in. Any <strong>other</strong> tab or device you are signed in on is signed out.
            The new key is shown once.
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
            Once you close this, the key becomes a mask.
          </Alert>
          {revealed ? <CopyField value={revealed} label="new API key" /> : null}
          <p className="text-xs leading-relaxed text-text-secondary">
            <KeyRound aria-hidden className="mr-1 inline h-icon-sm w-icon-sm align-[-3px]" />
            Store it in your server's secret manager, not in source control.
          </p>
        </div>
      </Dialog>
    </>
  );
}

/** The entitlement's state, as a word. */
function PlanBadge({ included }: { included: boolean }) {
  return (
    <Badge tone={included ? 'success' : 'neutral'}>{included ? 'Included' : 'Not included'}</Badge>
  );
}

function statusOf(error: unknown): number | undefined {
  const withResponse = error as {
    response?: { status?: number };
    status?: number;
  } | null;
  return withResponse?.response?.status ?? withResponse?.status;
}
