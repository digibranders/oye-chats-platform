import { type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Button, EmptyState, PageContainer } from '../../design-system';

/**
 * NotFoundPage — the catch-all `*` route. Renders inside the app shell (so a
 * mistyped or stale URL still keeps the sidebar/topbar for navigation) rather
 * than silently redirecting to Home, which hid broken links instead of
 * surfacing them.
 */
export function NotFoundPage(): ReactElement {
  const navigate = useNavigate();

  return (
    <PageContainer title="Page not found">
      <EmptyState
        icon={Compass}
        title="We couldn’t find that page"
        description="The link you followed may be broken, or the page may have moved."
        action={<Button onClick={() => navigate('/')}>Back to Home</Button>}
      />
    </PageContainer>
  );
}
