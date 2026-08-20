import { Navigate, Route, Routes } from 'react-router-dom';
import { NavTabs } from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { DunningTab } from './DunningTab';
import { ReconciliationTab } from './ReconciliationTab';
import { GstrExportTab } from './GstrExportTab';
import { SellerProfileTab } from './SellerProfileTab';
import { WebhooksTab } from './WebhooksTab';
import { BILLING_OPS_BASE, BILLING_OPS_TABS, billingOpsTabPath } from './tabs';

/**
 * Billing operations — the money as something you *act on*.
 *
 * Revenue reports; this section intervenes. Its five screens are ordered by how
 * time-critical they are, and dunning is first for that reason: everything else
 * here can wait until tomorrow, and a customer three days into a seven-day
 * grace period cannot.
 *
 * The two irreversible actions in the whole console — refunding an invoice and
 * recording an unpaid one as paid — live behind the invoice drawer this section
 * owns, so there is exactly one confirmation path to get right rather than one
 * per screen.
 */
export function BillingOpsPage() {
  return (
    <PlatformPage
      title="Billing operations"
      toolbarBleed
      toolbar={
        <NavTabs
          label="Billing operations views"
          items={BILLING_OPS_TABS.map((tab) => ({
            to: billingOpsTabPath(tab.value) ?? BILLING_OPS_BASE,
            label: tab.label,
            end: tab.path === '',
          }))}
        />
      }
    >
      <Routes>
        <Route index element={<DunningTab />} />
        <Route path="reconciliation" element={<ReconciliationTab />} />
        <Route path="gstr" element={<GstrExportTab />} />
        <Route path="seller" element={<SellerProfileTab />} />
        <Route path="webhooks" element={<WebhooksTab />} />
        <Route path="*" element={<Navigate to={BILLING_OPS_BASE} replace />} />
      </Routes>
    </PlatformPage>
  );
}
