import { Navigate, Route, Routes } from 'react-router-dom';
import { NavTabs } from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { PLATFORM_ROOT } from '../nav';
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
 * Each is a route, and the row above them is `NavTabs`. The console had five
 * sub-navigation mechanisms and two query-parameter names for one control, so a
 * colleague could not be sent a link by pattern and nobody could predict whether
 * the view was in the path or the query. It is always the path now.
 */

const BASE = `${PLATFORM_ROOT}/catalogue`;

const TABS = [
  { to: BASE, label: 'Plans', end: true },
  { to: `${BASE}/pricing`, label: 'Credit pricing' },
  { to: `${BASE}/content`, label: 'Pricing page copy' },
  { to: `${BASE}/coupons`, label: 'Coupons' },
  { to: `${BASE}/promotions`, label: 'Promotions' },
];

export function CataloguePage() {
  return (
    <PlatformPage
      title="Catalogue"
      // Forms and switch tables, not record books: capped at the page measure
      // so a field does not stretch to 1,800px on a wide monitor.
      width="page"
      toolbarBleed
      toolbar={<NavTabs label="Catalogue sections" items={TABS} />}
    >
      <Routes>
        <Route index element={<PlansScreen />} />
        <Route path="pricing" element={<PricingConfigScreen />} />
        <Route path="content" element={<PricingContentScreen />} />
        <Route path="coupons" element={<CouponsScreen />} />
        <Route path="promotions" element={<PromotionsScreen />} />
        <Route path="*" element={<Navigate to={BASE} replace />} />
      </Routes>
    </PlatformPage>
  );
}
