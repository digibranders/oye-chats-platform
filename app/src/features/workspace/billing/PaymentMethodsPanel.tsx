import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { CreditCard, Loader2, RefreshCw, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { Button, Card, CardContent, SectionHeader, cn } from '../../../design-system';
import { deletePaymentMethod, getPaymentMethods } from '../../../services/api';

/**
 * PaymentMethodsPanel - what the customer is paying WITH.
 *
 * Deliberately two sections, not one list. On Razorpay these are genuinely
 * different objects:
 *
 *   - The SUBSCRIPTION MANDATE cannot be swapped in place. Razorpay has no
 *     "change the card on this subscription" call, so replacing it means
 *     authorising a fresh mandate and retiring the old one - which is what
 *     Reactivate / plan-change already do. Showing it in a list with a Remove
 *     button would promise something the gateway cannot perform.
 *   - SAVED CARDS are real tokens, used for one-off credit top-ups. Those can
 *     genuinely be listed and removed.
 *
 * Only RBI-permitted metadata is ever shown: last four digits, network and
 * issuer. Expiry is not stored anywhere, by design.
 */

interface SavedMethod {
  id: number;
  token_id: string | null;
  type: string;
  last4: string | null;
  network: string | null;
  issuer: string | null;
  upi_handle: string | null;
}

interface PaymentMethodsPanelProps {
  /** Provider funding the subscription, e.g. "razorpay". Null on a free plan. */
  provider: string | null;
  /** True when a paid subscription is live, so the mandate section is meaningful. */
  hasPaidPlan: boolean;
}

function methodLabel(method: SavedMethod): string {
  if (method.type === 'upi' && method.upi_handle) return method.upi_handle;
  const network = method.network ?? 'Card';
  return method.last4 ? `${network} ···· ${method.last4}` : network;
}

export function PaymentMethodsPanel({ provider, hasPaidPlan }: PaymentMethodsPanelProps): ReactElement {
  const [methods, setMethods] = useState<SavedMethod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false): Promise<void> => {
    try {
      const rows = (await getPaymentMethods({ refresh })) as unknown as SavedMethod[];
      setMethods(Array.isArray(rows) ? rows : []);
      setError(null);
    } catch (err) {
      // An empty list and a failed lookup are different things: telling a
      // customer they have no saved cards when we simply could not check would
      // make them re-enter one they already have.
      setMethods([]);
      setError(err instanceof Error ? err.message : 'Couldn’t load your saved payment methods.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await getPaymentMethods().catch(() => null);
      if (cancelled) return;
      if (rows === null) {
        setMethods([]);
        setError('Couldn’t load your saved payment methods.');
      } else {
        setMethods(rows as unknown as SavedMethod[]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRemove = async (tokenId: string): Promise<void> => {
    setBusyToken(tokenId);
    setError(null);
    try {
      await deletePaymentMethod(tokenId);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t remove that payment method.');
    } finally {
      setBusyToken(null);
    }
  };

  const handleRefresh = (): void => {
    setRefreshing(true);
    void load(true).finally(() => setRefreshing(false));
  };

  return (
    <Card>
      {/* `CardContent` zeroes its top padding (it's meant to pair with a
          CardHeader). This panel has no header, so restore the top padding to
          match the card's other sides — otherwise the heading hugs the border. */}
      <CardContent className="pt-5 space-y-8">
        {/* ── Subscription mandate ─────────────────────────────────────── */}
        <div>
          <SectionHeader
            title="Subscription payment"
            description="The mandate your recurring charges are collected against."
          />
          <div className="mt-4 flex items-start gap-3 rounded-lg border border-[var(--ds-border)] px-3.5 py-3">
            <ShieldCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-text-muted)]" />
            <div className="min-w-0 text-[13px]">
              {hasPaidPlan && provider ? (
                <>
                  <p className="font-medium text-[var(--ds-text)]">
                    {provider.toLowerCase() === 'razorpay' ? 'UPI, card or NetBanking' : 'Billed manually'}
                  </p>
                  <p className="mt-0.5 text-[var(--ds-text-muted)]">
                    Held securely by Razorpay. To pay with a different instrument, cancel and
                    reactivate — Razorpay authorises a new mandate rather than swapping the old one.
                  </p>
                </>
              ) : (
                <p className="text-[var(--ds-text-muted)]">
                  No recurring payment yet. One is set up when you start a paid plan.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── Saved cards ──────────────────────────────────────────────── */}
        <div>
          <SectionHeader
            title="Saved for top-ups"
            description="Cards you save at checkout, reused for one-click credit purchases."
            actions={
              <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
                <RefreshCw size={15} aria-hidden="true" className={refreshing ? 'animate-spin' : undefined} />
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </Button>
            }
          />

          {error && (
            <p role="alert" className="mt-2 text-[12px] text-[var(--ds-danger)]">
              {error}
            </p>
          )}

          {methods === null ? (
            <p className="mt-4 text-[13px] text-[var(--ds-text-muted)]">Loading…</p>
          ) : methods.length === 0 ? (
            <p className="mt-4 text-[13px] text-[var(--ds-text-muted)]">
              Nothing saved yet. Tick “save this card” when you buy credits and it’ll appear here.
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {methods.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 rounded-lg border border-[var(--ds-border)] px-3.5 py-2.5"
                >
                  {m.type === 'upi' ? (
                    <Smartphone size={16} aria-hidden="true" className="shrink-0 text-[var(--ds-text-muted)]" />
                  ) : (
                    <CreditCard size={16} aria-hidden="true" className="shrink-0 text-[var(--ds-text-muted)]" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">
                      {methodLabel(m)}
                    </p>
                    {m.issuer && (
                      <p className="truncate text-[12px] text-[var(--ds-text-subtle)]">{m.issuer}</p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!m.token_id || busyToken === m.token_id}
                    onClick={() => m.token_id && void handleRemove(m.token_id)}
                    aria-label={`Remove ${methodLabel(m)}`}
                  >
                    {busyToken === m.token_id ? (
                      <Loader2 size={15} aria-hidden="true" className="animate-spin" />
                    ) : (
                      <Trash2 size={15} aria-hidden="true" />
                    )}
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <p className={cn('mt-5 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]')}>
            We never see or store your card number. Only the last four digits, the network and the
            issuing bank are kept — RBI rules prohibit storing anything more.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
