import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { TabPanel, Tabs } from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { DunningTab } from './DunningTab';
import { ReconciliationTab } from './ReconciliationTab';
import { GstrExportTab } from './GstrExportTab';
import { SellerProfileTab } from './SellerProfileTab';
import { WebhooksTab } from './WebhooksTab';
import {
  BILLING_OPS_BASE,
  BILLING_OPS_TABS,
  billingOpsTabFor,
  billingOpsTabPath,
} from './tabs';

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
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const current = billingOpsTabFor(pathname);

  return (
    <PlatformPage
      eyebrow="Money"
      title="Billing operations"
      description="Dunning, refunds, reconciliation, GSTR export and the seller profile."
    >
      <Tabs
        label="Billing operations views"
        value={current}
        onValueChange={(next) => {
          const path = billingOpsTabPath(next);
          if (path) navigate(path);
        }}
        items={BILLING_OPS_TABS.map(({ value, label }) => ({ value, label }))}
      >
        <TabPanel value={current}>
          <Routes>
            <Route index element={<DunningTab />} />
            <Route path="reconciliation" element={<ReconciliationTab />} />
            <Route path="gstr" element={<GstrExportTab />} />
            <Route path="seller" element={<SellerProfileTab />} />
            <Route path="webhooks" element={<WebhooksTab />} />
            <Route path="*" element={<Navigate to={BILLING_OPS_BASE} replace />} />
          </Routes>
        </TabPanel>
      </Tabs>
    </PlatformPage>
  );
}
