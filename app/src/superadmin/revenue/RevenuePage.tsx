import { EmptyState } from '../../ui';
import { PlatformPage } from '../PlatformPage';

/**
 * Revenue — not built yet.
 *
 * Deliberately an honest placeholder rather than a half-built screen. The rail
 * lists this section because the endpoints behind it exist and are part of the
 * console's scope; the page says plainly that the UI does not, which is a fact
 * an operator can act on. A screen that renders a chrome of empty tables over
 * calls nobody wired reads as "there is no data", and that is a lie.
 */
export function RevenuePage() {
  return (
    <PlatformPage title="Revenue" description="Subscriptions, invoices, credits and the funnels behind them.">
      <EmptyState
        title="This section is still being built"
        description="The endpoints behind it exist and are in scope; the screens are not written yet. Nothing here is broken — there is simply nothing to show."
      />
    </PlatformPage>
  );
}
