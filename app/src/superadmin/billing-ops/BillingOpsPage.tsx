import { EmptyState } from '../../ui';
import { PlatformPage } from '../PlatformPage';

/**
 * Billing operations — not built yet.
 *
 * Deliberately an honest placeholder rather than a half-built screen. The rail
 * lists this section because the endpoints behind it exist and are part of the
 * console's scope; the page says plainly that the UI does not, which is a fact
 * an operator can act on. A screen that renders a chrome of empty tables over
 * calls nobody wired reads as "there is no data", and that is a lie.
 */
export function BillingOpsPage() {
  return (
    <PlatformPage title="Billing operations" description="Dunning, refunds, reconciliation, GSTR export and the seller profile.">
      <EmptyState
        title="This section is still being built"
        description="The endpoints behind it exist and are in scope; the screens are not written yet. Nothing here is broken — there is simply nothing to show."
      />
    </PlatformPage>
  );
}
