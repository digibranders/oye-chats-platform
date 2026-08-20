import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ExternalLink, ShieldOff } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  formatDateTime,
  toast,
} from '../../ui';
import { platform } from '../client';
import {
  SupportSessionsContext,
  isLive,
  minutesRemaining,
  sessionState,
  useSupportSessions,
  type SupportSession,
  type SupportSessionState,
} from './supportSessionStore';

const STATE_LABEL: Record<SupportSessionState, string> = {
  ready: 'Not opened yet',
  open: 'Live',
  expired: 'Expired',
  revoked: 'Revoked',
};

const STATE_TONE: Record<SupportSessionState, 'success' | 'warning' | 'neutral'> = {
  ready: 'warning',
  open: 'success',
  expired: 'neutral',
  revoked: 'neutral',
};

/**
 * Holds the impersonation tokens this console has minted.
 *
 * Mounted once for the whole customers section rather than per customer, so
 * navigating from one account to another does not lose sight of a session that
 * is still live on the first.
 */
export function SupportSessionsProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<readonly SupportSession[]>([]);

  const open = useCallback((session: SupportSession) => {
    setSessions((current) => [session, ...current.filter((entry) => entry.tokenId !== session.tokenId)]);
  }, []);

  const markOpened = useCallback((tokenId: number) => {
    setSessions((current) =>
      current.map((entry) => (entry.tokenId === tokenId ? { ...entry, handoffUrl: null } : entry)),
    );
  }, []);

  const revoke = useCallback(async (tokenId: number) => {
    const result = await platform.post<{ ok: boolean; revoked_at: string }>(
      `/impersonation/${tokenId}/revoke`,
    );
    setSessions((current) =>
      current.map((entry) =>
        entry.tokenId === tokenId
          ? { ...entry, revokedAt: result.revoked_at ?? new Date().toISOString(), handoffUrl: null }
          : entry,
      ),
    );
  }, []);

  const value = useMemo(
    () => ({ sessions, open, markOpened, revoke }),
    [sessions, open, markOpened, revoke],
  );

  return <SupportSessionsContext.Provider value={value}>{children}</SupportSessionsContext.Provider>;
}

/**
 * The live-session list, with its off switch.
 *
 * The most dangerous control in the product needs a visible inventory, so this
 * renders wherever a super-admin might be standing when they need to end a
 * session — beside the mint control on a customer, and above the accounts list.
 */
export function SupportSessionsPanel({ clientId }: { clientId?: number }) {
  const { sessions, markOpened, revoke } = useSupportSessions();
  const [now, setNow] = useState(() => Date.now());
  const [pendingRevoke, setPendingRevoke] = useState<SupportSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A 30-minute expiry that only updates when something else re-renders would
  // show a token as live minutes after it stopped working.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const visible = clientId ? sessions.filter((entry) => entry.clientId === clientId) : sessions;
  const liveCount = visible.filter((entry) => isLive(entry, now)).length;

  function handOff(session: SupportSession): void {
    if (!session.handoffUrl) return;
    // Opened straight from the click, so the popup blocker sees a user gesture,
    // and with `noopener` so the customer app cannot reach back into the console.
    window.open(session.handoffUrl, '_blank', 'noopener,noreferrer');
    markOpened(session.tokenId);
  }

  return (
    <Card>
      <CardHeader
        titleAs="h3"
        eyebrow="Impersonation"
        title="Support sessions"
        description="Minted in this browser tab."
        actions={
          liveCount > 0 ? (
            <Badge tone="warning" dot>
              {liveCount} live
            </Badge>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" live title="Could not revoke that session">
            {error}
          </Alert>
        ) : null}

        {visible.length === 0 ? (
          <EmptyState
            compact
            title="No support session opened from here"
            description="The API lists no impersonation tokens, so only what this tab minted appears here — a session opened elsewhere cannot be seen or revoked."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {visible.map((session) => {
              const state = sessionState(session, now);
              const left = minutesRemaining(session, now);
              return (
                <li
                  key={session.tokenId}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-surface-sunken px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {session.clientName}
                    </p>
                    <p className="truncate text-xs text-text-secondary">
                      {session.clientEmail} · token{' '}
                      <span className="figure">#{session.tokenId}</span> · minted{' '}
                      <span className="figure">{formatDateTime(session.mintedAt)}</span>
                    </p>
                  </div>
                  <Badge tone={STATE_TONE[state]} dot={state === 'open'}>
                    {STATE_LABEL[state]}
                  </Badge>
                  <p className="figure text-xs text-text-tertiary">
                    {state === 'revoked'
                      ? `Revoked ${formatDateTime(session.revokedAt)}`
                      : left === null
                        ? '—'
                        : state === 'expired'
                          ? 'Expired'
                          : `${left} min left`}
                  </p>
                  <div className="flex items-center gap-2">
                    {state === 'ready' ? (
                      <Button size="sm" variant="accent" onClick={() => handOff(session)}>
                        <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                        Open support session
                      </Button>
                    ) : null}
                    {isLive(session, now) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setError(null);
                          setPendingRevoke(session);
                        }}
                      >
                        <ShieldOff aria-hidden />
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>

      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRevoke(null);
        }}
        title={pendingRevoke ? `Revoke the support session for ${pendingRevoke.clientName}?` : 'Revoke'}
        description={
          <>
            The token stops being accepted on its next request. Anyone with the tab open — including
            you — is signed out of {pendingRevoke?.clientName ?? 'the account'} immediately and loses
            unsaved work in it. The customer&apos;s own session is unaffected.
          </>
        }
        confirmLabel="Revoke session"
        destructive
        onConfirm={async () => {
          if (!pendingRevoke) return;
          try {
            await revoke(pendingRevoke.tokenId);
            setPendingRevoke(null);
            toast.success('Support session revoked.');
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The session could not be revoked.');
            setPendingRevoke(null);
          }
        }}
      />
    </Card>
  );
}
