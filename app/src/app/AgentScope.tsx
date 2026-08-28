import { Outlet } from 'react-router-dom';
import { AgentProvider } from '../context/AgentContext';

/**
 * The chatbot scope boundary.
 *
 * It mounts `AgentProvider` — which resolves the chatbot from the URL — and
 * renders nothing else. There is no header and no tab row here on purpose: the
 * rail carries the chatbot's destinations now, and the top bar names the chatbot
 * in the breadcrumb. The layout this replaces rendered its own `h1` with the
 * chatbot's name, which meant the Overview page had two `h1`s and the other four
 * tabs had none.
 */
export function AgentScope() {
  return (
    <AgentProvider>
      <Outlet />
    </AgentProvider>
  );
}
