import { describe, expect, it } from 'vitest';
import { AGENT_NAV, NAV_SECTIONS } from './nav';
import { AGENT_SETTINGS, WORKSPACE_SETTINGS } from './searchIndex';

const VALID_SETTINGS_SEGMENTS = new Set(Object.keys(NAV_SECTIONS['/settings'] ?? {}));
const VALID_AGENT_SEGMENTS = new Set(AGENT_NAV.map((item) => item.segment));

describe('searchIndex shape', () => {
  it('has the launch-set counts the spec commits to', () => {
    expect(WORKSPACE_SETTINGS).toHaveLength(9);
    expect(AGENT_SETTINGS).toHaveLength(30);
  });

  it('has no duplicate ids within either array', () => {
    const workspaceIds = WORKSPACE_SETTINGS.map((item) => item.id);
    const agentIds = AGENT_SETTINGS.map((item) => item.id);
    expect(new Set(workspaceIds).size).toBe(workspaceIds.length);
    expect(new Set(agentIds).size).toBe(agentIds.length);
  });
});

/**
 * `WORKSPACE_SETTINGS.to` targets `/settings/<section>`, so the section must
 * be one `NAV_SECTIONS['/settings']` already names as a real route.
 * `AGENT_SETTINGS.segment` must be one `AGENT_NAV` already names as a real
 * chatbot tab. Both are the SAME canonical lists the rail itself is built
 * from, so a renamed or removed page fails this test rather than shipping a
 * dead palette result.
 */
describe('every indexed setting resolves to a route that actually exists', () => {
  it('every workspace setting points at a real /settings sub-route', () => {
    const offenders = WORKSPACE_SETTINGS.filter((item) => {
      const [path] = item.to.split('?');
      const segments = (path ?? '').split('/').filter(Boolean);
      return segments[0] !== 'settings' || !VALID_SETTINGS_SEGMENTS.has(segments[1] ?? '');
    }).map((item) => `${item.id} -> ${item.to}`);
    expect(offenders).toEqual([]);
  });

  it('every per-chatbot setting points at a real agent tab', () => {
    const offenders = AGENT_SETTINGS.filter((item) => !VALID_AGENT_SEGMENTS.has(item.segment)).map(
      (item) => `${item.id} -> ${item.segment}`,
    );
    expect(offenders).toEqual([]);
  });

  it('the guard can still fail, so it is worth having', () => {
    expect(VALID_SETTINGS_SEGMENTS.has('not-a-real-section')).toBe(false);
    expect(VALID_AGENT_SEGMENTS.has('not-a-real-tab')).toBe(false);
  });
});
