import { RouterProvider } from 'react-router-dom';
import { ThemeProvider } from '../design-system';
import { router } from './routes';

/**
 * Application root (Admin Platform 2.0 foundation).
 *
 * Composes the global providers and the route architecture. Phase 1 keeps the
 * provider tree intentionally lean (theme only) — data contexts (Workspace,
 * Agent, Notifications, etc.) are mounted as the pages that need them are built
 * in later phases, per the strangler-fig migration (decision #3).
 */
export default function App() {
  return (
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  );
}
