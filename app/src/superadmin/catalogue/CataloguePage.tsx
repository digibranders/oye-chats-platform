import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
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

/**
 * The one screen here that is a form.
 *
 * `width="page"` was declared for all five on the reasoning that a field should
 * not stretch on a wide monitor. It does not cap anything at 1440: the token is
 * 90rem and the content column is 1,192px. The pricing-page copy editor takes
 * the reading measure; the four record books take every pixel they can get.
 */
const FORM_ROUTES = new Set([`${BASE}/content`]);

export function CataloguePage() {
  const { pathname } = useLocation();

  return (
    <PlatformPage
      title="Catalogue"
      width={FORM_ROUTES.has(pathname.replace(/\/$/, '')) ? 'default' : 'full'}
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
