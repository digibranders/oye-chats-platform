import { Route, Routes } from 'react-router-dom';
import { TabPanel, Tabs, type TabItem } from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { useUrlState } from '../usePlatform';
import { CouponsScreen } from './CouponsScreen';
import { PlansScreen } from './PlansScreen';
import { PricingConfigScreen } from './PricingConfigScreen';
import { PricingContentScreen } from './PricingContentScreen';
import { PromotionsScreen } from './PromotionsScreen';

/**
 * Catalogue — everything that decides what is sold and at what price.
 *
 * Five screens, in the order the money flows: what a plan grants, what a credit
 * costs, what the pricing page says about both, and the two discount objects.
 *
 * They are tabs held in the query string rather than nested paths, for one
 * reason. The tab row is `Tabs` from the design system, whose panels give each
 * screen a real `tabpanel` with the arrow-key, Home/End and manual-activation
 * contract already correct, and whose inactive panels unmount, so only the
 * visible screen fetches. Driving the same row from nested routes would mean
 * either re-implementing that contract over links or rendering tabs whose
 * `aria-controls` points at panels that do not exist. The query string still
 * deep-links, which is the property that actually mattered: a filtered screen in
 * this console exists to be sent to a colleague.
 *
 * The section is still mounted at `catalogue/*`, so a stale sub-path renders the
 * section rather than an empty splat.
 */

const TABS: TabItem[] = [
  { value: 'plans', label: 'Plans' },
  { value: 'pricing', label: 'Credit pricing' },
  { value: 'content', label: 'Pricing page copy' },
  { value: 'coupons', label: 'Coupons' },
  { value: 'promotions', label: 'Promotions' },
];

const DESCRIPTIONS: Record<string, string> = {
  plans: 'What each tier grants and charges. Editing a plan changes what live customers may do.',
  pricing: 'The credit economics every metered action is billed against.',
  content: 'The copy the public pricing page renders — marketing, not entitlements.',
  coupons: 'Recorded discounts. There is no online redemption path for them.',
  promotions: 'Time-boxed free-cycle offers, resolved live at checkout.',
};

function CatalogueSection() {
  const url = useUrlState();
  const raw = url.get('view', 'plans');
  const view = TABS.some((tab) => tab.value === raw) ? raw : 'plans';

  return (
    <PlatformPage eyebrow="Money" title="Catalogue" description={DESCRIPTIONS[view]}>
      <Tabs
        label="Catalogue sections"
        items={TABS}
        value={view}
        onValueChange={(next) => url.set({ view: next === 'plans' ? null : next })}
      >
        <TabPanel value="plans">
          <PlansScreen />
        </TabPanel>
        <TabPanel value="pricing">
          <PricingConfigScreen />
        </TabPanel>
        <TabPanel value="content">
          <PricingContentScreen />
        </TabPanel>
        <TabPanel value="coupons">
          <CouponsScreen />
        </TabPanel>
        <TabPanel value="promotions">
          <PromotionsScreen />
        </TabPanel>
      </Tabs>
    </PlatformPage>
  );
}

export function CataloguePage() {
  return (
    <Routes>
      <Route path="/" element={<CatalogueSection />} />
      <Route path="*" element={<CatalogueSection />} />
    </Routes>
  );
}
