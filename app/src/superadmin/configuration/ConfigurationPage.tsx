import { Navigate, Route, Routes } from 'react-router-dom';
import { NavTabs } from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { PLATFORM_ROOT } from '../nav';
import { useUrlState } from '../usePlatform';
import { AiScreen } from './AiScreen';
import { AuditScreen } from './AuditScreen';
import { FlagsScreen } from './FlagsScreen';
import { LogsScreen } from './LogsScreen';
import { OutboundScreen } from './OutboundScreen';
import { RuntimeScreen } from './RuntimeScreen';

/**
 * Configuration — the machine, rather than the product.
 *
 * Six screens, ordered by how far each one reaches: switches that change
 * behaviour for everyone, the model and RAG runtime the next request reads, what
 * the models cost, what the platform sends outward, the journals, and the record
 * of every write made from this console.
 *
 * One route each, one `NavTabs` row above them — the same mechanism the other
 * five sections use.
 */

const BASE = `${PLATFORM_ROOT}/platform`;

const TABS = [
  { to: BASE, label: 'Flags', end: true },
  { to: `${BASE}/runtime`, label: 'Runtime' },
  { to: `${BASE}/ai`, label: 'AI cost' },
  // The four outbound surfaces are peers of the rest, not children of a fifth
  // thing behind a segmented control inside one of them.
  { to: `${BASE}/deliveries`, label: 'Deliveries' },
  { to: `${BASE}/registrations`, label: 'Registrations' },
  { to: `${BASE}/dead-letters`, label: 'Dead letters' },
  { to: `${BASE}/email`, label: 'Email' },
  { to: `${BASE}/logs`, label: 'Logs' },
  { to: `${BASE}/audit`, label: 'Audit' },
];

/** The AI screen's two scopes live in the URL, so a spend view is as shareable as everything else. */
function AiRoute() {
  const url = useUrlState();
  return (
    <AiScreen
      days={url.get('days', '30')}
      by={url.get('by', 'model')}
      onDaysChange={(next) => url.set({ days: next === '30' ? null : next })}
      onByChange={(next) => url.set({ by: next === 'model' ? null : next })}
    />
  );
}

export function ConfigurationPage() {
  return (
    <PlatformPage
      title="Configuration"
      // Forms and switch tables, not record books: capped at the page measure
      // so a field does not stretch to 1,800px on a wide monitor.
      width="page"
      toolbarBleed
      toolbar={<NavTabs label="Configuration sections" items={TABS} />}
    >
      <Routes>
        <Route index element={<FlagsScreen />} />
        <Route path="runtime" element={<RuntimeScreen />} />
        <Route path="ai" element={<AiRoute />} />
        <Route path="deliveries" element={<OutboundScreen view="deliveries" />} />
        <Route path="registrations" element={<OutboundScreen view="registrations" />} />
        <Route path="dead-letters" element={<OutboundScreen view="failed" />} />
        <Route path="email" element={<OutboundScreen view="email" />} />
        <Route path="logs" element={<LogsScreen />} />
        <Route path="audit" element={<AuditScreen />} />
        <Route path="*" element={<Navigate to={BASE} replace />} />
      </Routes>
    </PlatformPage>
  );
}
