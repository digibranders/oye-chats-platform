import { Navigate, Route, Routes } from 'react-router-dom';
import { NavTabs } from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { OverviewTab } from './OverviewTab';
import { SubscriptionsTab } from './SubscriptionsTab';
import { InvoicesTab } from './InvoicesTab';
import { UsageCreditsTab } from './UsageCreditsTab';
import { PaymentsTab } from './PaymentsTab';
import { GrowthTab } from './GrowthTab';
import { REVENUE_BASE, REVENUE_TABS, revenueTabPath } from './tabs';

/**
 * Revenue — the money as it is *reported*.
 *
 * Six screens, one per question an operator actually arrives with: what is the
 * business worth, who is subscribed, what have we invoiced, what are people
 * consuming, how are they paying, and where are they coming from. Each is its
 * own URL, because every one of these lists is something somebody will want to
 * send to a colleague, and a tab held in component state cannot be sent to
 * anyone.
 *
 * The line this section holds throughout: **aggregates are normalised USD, and
 * documents are not.** The two are never placed in the same column, and every
 * figure says which it is. Getting that wrong is not a formatting bug — it is a
 * support agent quoting a customer a refund amount in the wrong currency.
 *
 * What is deliberately *not* here: the actions that change an invoice. Those
 * live in Billing operations and are reached through the shared invoice drawer,
 * so there is exactly one place in the console where money moves.
 */
export function RevenuePage() {
  return (
    <PlatformPage
      title="Revenue"
      toolbarBleed
      toolbar={
        // Links, not tabs. Every one of these views is a different route, so a
        // `tablist` would stamp `aria-controls` on six tabs while only one
        // panel is ever in the document — and the five dead references were
        // there until this line replaced them.
        <NavTabs
          label="Revenue views"
          items={REVENUE_TABS.map((tab) => ({
            to: revenueTabPath(tab.value) ?? REVENUE_BASE,
            label: tab.label,
            end: tab.path === '',
          }))}
        />
      }
    >
      <Routes>
        <Route index element={<OverviewTab />} />
        <Route path="subscriptions" element={<SubscriptionsTab />} />
        <Route path="invoices" element={<InvoicesTab />} />
        <Route path="usage" element={<UsageCreditsTab />} />
        <Route path="payments" element={<PaymentsTab />} />
        <Route path="growth" element={<GrowthTab />} />
        {/* A mistyped sub-path is a wrong URL, not an error state: send it to
            the section's own first screen rather than showing a dead page
            inside a working section. */}
        <Route path="*" element={<Navigate to={REVENUE_BASE} replace />} />
      </Routes>
    </PlatformPage>
  );
}
