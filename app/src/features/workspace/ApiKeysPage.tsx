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
  SettingBand,
  SettingGroup,
  SettingRow,
  buttonClass,
  toast,
} from '../../ui';
import { getApiBaseUrl, getClientApiKey, regenerateClientApiKey } from '../../services/api';
import { getAuthItem, setAuthItem } from '../../utils/authStorage';
import { keys } from '../../query/keys';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useWorkspace } from '../../context/WorkspaceContext';

/**
 * Settings ▸ Developers — the workspace's API key, and how to use it.
 *
 * Two things this page has to get right.
 *
 * **Never offer to copy a mask.** The console this replaces had a copy button
 * beside the bullets, and it copied the bullets. A button that silently puts
 * `••••••a3f9` on the clipboard is worse than no button, because the user
 * believes they have the key.
 *
 * That rule used to be enforced by having no copy control at all, on the
 * belief — printed on the page as "Stored as a hash" — that the key was
 * unrecoverable. It is not: `Client.api_key` is a plain column, `GET
 * /client/api-key` masks it only for display, and this browser is holding the
 * full value already, because the console authenticates with the very same
 * `X-API-Key`. So the honest conclusion was never "no copy button", it was
 * "copy the real key, which we have". Without one, the only route to a key you
 * had not written down was Rotate — which revokes every live integration to
 * recover a secret sitting in this tab's own storage.
 *
 * The copy is offered **only when the local credential is provably the current
 * one**: its last four characters have to match the mask the server just sent.
 * Rotate on another device and this tab's copy is stale, at which point
 * offering it would be the same lie as copying the bullets — see
 * `localKeyIfCurrent`.
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

/**
 * This browser's copy of the workspace key, but only when it is provably the
 * key the server currently holds.
 *
 * The console signs in with the workspace credential itself, so `admin_token`
 * IS the API key. That makes it copyable — but it can also go stale, because a
 * rotation on another device changes the server's key without touching this
 * tab's storage. `api_key_masked` is `••••••` plus the real key's last four, so
 * comparing those four is a cheap proof that the local copy is still live.
 *
 * `null` means "do not offer a copy": either there is no local credential, or
 * it no longer matches, and handing over a dead key is the same failure as
 * copying the mask.
 */
function localKeyIfCurrent(masked: string | undefined): string | null {
  const local = getAuthItem('admin_token');
  if (!local || local.length < 4) return null;
  if (!masked || masked.length < 4) return null;
  return local.slice(-4) === masked.slice(-4) ? local : null;
}

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
  // Recomputed per render rather than memoised: `rotate` writes the new key
  // straight to storage, and a stale memo here would keep showing the old
  // one as copyable for the rest of the session.
  const copyable = localKeyIfCurrent(apiKey.data?.api_key_masked);

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
              <SettingBand>
                <LoadingRows rows={1} />
              </SettingBand>
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
                description={
                  copyable
                    ? 'The credential this browser is signed in with. Reveal it to copy.'
                    : 'Rotated on another device, so this browser no longer holds it. Rotate again to issue a key you can copy.'
                }
                controlWidth="auto"
              >
                {copyable ? (
                  <CopyField
                    className="w-72"
                    compact
                    secret
                    maskedValue={apiKey.data.api_key_masked}
                    value={copyable}
                    label="Workspace API key"
                  />
                ) : (
                  // No local copy, or a stale one. The mask is all there
                  // honestly is, and a mask never gets a copy button.
                  <span className="figure text-base text-text-primary">
                    {apiKey.data.api_key_masked}
                  </span>
                )}
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
            <KeyRound aria-hidden className="me-1 inline h-icon-sm w-icon-sm align-[-3px]" />
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
