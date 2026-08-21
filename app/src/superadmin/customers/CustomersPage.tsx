import { Navigate, Route, Routes } from 'react-router-dom';
import { CustomerDetailPage } from './CustomerDetailPage';
import { CustomerListPage, DIRECTORY_SEGMENTS } from './CustomerListPage';
import { SupportSessionsProvider } from './SupportSessions';

/**
 * The Support section: everything about a customer and everyone in it.
 *
 * The provider wraps both screens rather than sitting on the detail page,
 * because an impersonation token outlives the screen that minted it. A
 * super-admin who opens a support session, navigates back to the list and then
 * into a second account must not lose the only control that ends the first one.
 *
 * **The five directory segments are declared before `:clientId`.** They were not,
 * and a dynamic segment matches any single word: `/customers/operators` resolved
 * as the account whose id is "operators" and every one of the five tabs rendered
 * "That is not a valid account id". Five lists — operators, sign-in identities,
 * API keys, devices and notifications — had no reachable UI at all. Route order
 * is the fix rather than a regex on the param, because the directory names are a
 * closed set the list page already owns and an id is whatever is left.
 */
export function CustomersPage() {
  return (
    <SupportSessionsProvider>
      <Routes>
        <Route index element={<CustomerListPage />} />
        {DIRECTORY_SEGMENTS.map((segment) => (
          <Route key={segment} path={segment} element={<CustomerListPage />} />
        ))}
        <Route path=":clientId" element={<CustomerDetailPage />} />
        {/* An unknown sub-path is a stale link, not a dead end. */}
        <Route path="*" element={<Navigate to="." replace />} />
      </Routes>
    </SupportSessionsProvider>
  );
}
