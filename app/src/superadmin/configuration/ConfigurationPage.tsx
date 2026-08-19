import { Route, Routes } from 'react-router-dom';
import { TabPanel, Tabs, type TabItem } from '../../ui';
import { PlatformPage } from '../PlatformPage';
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
 * Tabs held in the query string, for the same reason the catalogue uses them:
 * `Tabs` already owns the keyboard contract, its inactive panels unmount so only
 * the visible screen fetches, and a query string still deep-links — which is the
 * property that matters when the point of a filtered log view is to send it to
 * somebody.
 */

const TABS: TabItem[] = [
  { value: 'flags', label: 'Flags' },
  { value: 'runtime', label: 'Runtime' },
  { value: 'ai', label: 'AI cost' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'logs', label: 'Logs' },
  { value: 'audit', label: 'Audit' },
];

const DESCRIPTIONS: Record<string, string> = {
  flags: 'Switches that change platform behaviour for every customer at once.',
  runtime: 'Models, retrieval and the crawler, read by the next request without a deploy.',
  ai: 'What the models cost, where the cost sits, and what the safety nets caught.',
  outbound: 'Webhook deliveries, customer registrations, dead-lettered billing events and transactional email.',
  logs: 'The API and worker journals, read on request.',
  audit: 'Every write made from this console, with its before and after.',
};

function ConfigurationSection() {
  const url = useUrlState();
  const raw = url.get('view', 'flags');
  const view = TABS.some((tab) => tab.value === raw) ? raw : 'flags';

  // The AI screen's two scopes live in the URL alongside the tab, so a spend
  // view is as shareable as everything else in the console.
  const days = url.get('days', '30');
  const by = url.get('by', 'model');

  return (
    <PlatformPage eyebrow="Machine" title="Configuration" description={DESCRIPTIONS[view]}>
      <Tabs
        label="Configuration sections"
        items={TABS}
        value={view}
        onValueChange={(next) => url.set({ view: next === 'flags' ? null : next })}
      >
        <TabPanel value="flags">
          <FlagsScreen />
        </TabPanel>
        <TabPanel value="runtime">
          <RuntimeScreen />
        </TabPanel>
        <TabPanel value="ai">
          <AiScreen
            days={days}
            by={by}
            onDaysChange={(next) => url.set({ days: next === '30' ? null : next })}
            onByChange={(next) => url.set({ by: next === 'model' ? null : next })}
          />
        </TabPanel>
        <TabPanel value="outbound">
          <OutboundScreen />
        </TabPanel>
        <TabPanel value="logs">
          <LogsScreen />
        </TabPanel>
        <TabPanel value="audit">
          <AuditScreen />
        </TabPanel>
      </Tabs>
    </PlatformPage>
  );
}

export function ConfigurationPage() {
  return (
    <Routes>
      <Route path="/" element={<ConfigurationSection />} />
      <Route path="*" element={<ConfigurationSection />} />
    </Routes>
  );
}
