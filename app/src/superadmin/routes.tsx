import { lazy, Suspense } from 'react';
import { type RouteObject } from 'react-router-dom';
import { PlatformLoading, PlatformShell } from './PlatformShell';
import { CommandCentrePage } from './watch/CommandCentrePage';

/**
 * The platform console's routes, mounted at `/platform`.
 *
 * Every section but the command centre is lazily loaded. The console is a
 * support tool used by a handful of people and its sections are dense; making
 * every customer download them is how the main bundle got to two megabytes.
 */
const CustomersPage = lazy(() =>
  import('./customers/CustomersPage').then((module) => ({ default: module.CustomersPage })),
);
const RevenuePage = lazy(() =>
  import('./revenue/RevenuePage').then((module) => ({ default: module.RevenuePage })),
);
const BillingOpsPage = lazy(() =>
  import('./billing-ops/BillingOpsPage').then((module) => ({ default: module.BillingOpsPage })),
);
const CataloguePage = lazy(() =>
  import('./catalogue/CataloguePage').then((module) => ({ default: module.CataloguePage })),
);
const RecordsPage = lazy(() =>
  import('./records/RecordsPage').then((module) => ({ default: module.RecordsPage })),
);
const ConfigurationPage = lazy(() =>
  import('./configuration/ConfigurationPage').then((module) => ({ default: module.ConfigurationPage })),
);

function lazily(element: React.ReactNode) {
  return <Suspense fallback={<PlatformLoading />}>{element}</Suspense>;
}

export const platformRoutes: RouteObject = {
  path: '/platform',
  element: <PlatformShell />,
  children: [
    { index: true, element: <CommandCentrePage /> },
    { path: 'customers/*', element: lazily(<CustomersPage />) },
    { path: 'revenue/*', element: lazily(<RevenuePage />) },
    { path: 'billing-ops/*', element: lazily(<BillingOpsPage />) },
    { path: 'catalogue/*', element: lazily(<CataloguePage />) },
    { path: 'records/*', element: lazily(<RecordsPage />) },
    { path: 'platform/*', element: lazily(<ConfigurationPage />) },
  ],
};
