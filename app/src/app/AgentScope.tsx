import { Outlet } from 'react-router-dom';
import { AgentProvider } from '../context/AgentContext';
import { useWorkspace } from '../context/WorkspaceContext';
import { SetupJourney } from '../onboarding/SetupJourney';

/**
 * The chatbot scope boundary.
 *
 * It mounts `AgentProvider` — which resolves the chatbot from the URL — and
 * renders almost nothing else. There is no header and no tab row here on
 * purpose: the rail carries the chatbot's destinations now, and the top bar
 * names the chatbot in the breadcrumb. The layout this replaces rendered its own
 * `h1` with the chatbot's name, which meant the Overview page had two `h1`s and
 * the other four tabs had none.
 *
 * The one exception is `SetupJourney`, and it earns the place by being
 * temporary. The first run ends on this chatbot's Knowledge page with a crawl
 * running, and until now nothing on that page said anything followed it: the
 * checklist that knows lived in the rail's ring, on Home and on `/setup`, none
 * of which is where the customer is standing. Mounting it here puts it above
 * every chatbot page for exactly as long as the work is unfinished, and it
 * removes itself the moment the steps are done. It is not a header, and it is
 * not a wizard — it gates nothing and every step links into the real surface.
 */
export function AgentScope() {
  const { currentWorkspaceId } = useWorkspace();

  return (
    <AgentProvider>
      <SetupJourney workspaceId={currentWorkspaceId} />
      <Outlet />
    </AgentProvider>
  );
}
