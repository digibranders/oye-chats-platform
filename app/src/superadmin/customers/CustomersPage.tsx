import { Navigate, Route, Routes } from 'react-router-dom';
import { CustomerDetailPage } from './CustomerDetailPage';
import { CustomerListPage } from './CustomerListPage';
import { SupportSessionsProvider } from './SupportSessions';

/**
 * The Support section: everything about a customer and everyone in it.
 *
 * The provider wraps both screens rather than sitting on the detail page,
 * because an impersonation token outlives the screen that minted it. A
 * super-admin who opens a support session, navigates back to the list and then
 * into a second account must not lose the only control that ends the first one.
 */
export function CustomersPage() {
  return (
    <SupportSessionsProvider>
      <Routes>
        <Route index element={<CustomerListPage />} />
        <Route path=":clientId" element={<CustomerDetailPage />} />
        {/* An unknown sub-path is a stale link, not a dead end. */}
        <Route path="*" element={<Navigate to="." replace />} />
      </Routes>
    </SupportSessionsProvider>
  );
}
