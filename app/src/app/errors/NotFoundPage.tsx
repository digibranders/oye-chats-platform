import { Compass, Home } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState, PageContainer, buttonVariants } from '../../design-system';

/**
 * NotFoundPage — the in-shell 404 for unknown authenticated routes.
 *
 * Replaces the previous silent redirect-to-home so a mistyped or stale URL is
 * acknowledged (and stays in the address bar) rather than quietly bouncing the
 * user. Renders inside the shell via the splat child route, keeping navigation
 * available.
 */
export function NotFoundPage() {
  return (
    <PageContainer>
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="The page you're looking for doesn't exist or may have moved. Check the URL, or head back to a familiar place."
        action={
          <Link to="/" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
            <Home size={14} />
            Back to Home
          </Link>
        }
      />
    </PageContainer>
  );
}
