import { describe, expect, it } from 'vitest';
import { buildInstallPrompt } from './installPrompt';
import { platforms } from '../../../data/platformIntegrations';

const BOT_KEY = 'bot-11a026a4b8b3';

function prompt(overrides: Partial<Parameters<typeof buildInstallPrompt>[0]> = {}): string {
  return buildInstallPrompt({
    botKey: BOT_KEY,
    apiBaseUrl: 'https://api.oyechats.com',
    env: 'production',
    platform: null,
    ...overrides,
  });
}

const nextjs = platforms.find((p) => p.id === 'nextjs');
const wordpress = platforms.find((p) => p.id === 'wordpress');

describe('buildInstallPrompt', () => {
  it('carries the live key, bundle URL, and API base', () => {
    const text = prompt();
    expect(text).toContain(BOT_KEY);
    expect(text).toContain('https://cdn.oyechats.com/oyechats-widget.js');
    expect(text).toContain('https://api.oyechats.com/bots/settings/public');
  });

  it('embeds the selected platform steps verbatim so the prompt cannot drift from the UI', () => {
    const text = prompt({ platform: nextjs });
    for (const step of nextjs!.getSteps(BOT_KEY, 'production')) {
      expect(text).toContain(step.title);
      if (step.code) expect(text).toContain(step.code);
    }
    expect(text).toContain('Installation Steps (Next.js)');
  });

  it('uses each platform its own snippet, not a generic one', () => {
    const wp = prompt({ platform: wordpress });
    expect(wp).toContain('oyechats_enqueue_widget');
    expect(wp).not.toContain('next/script');
  });

  it('asks the agent to detect the stack when no platform is selected', () => {
    const text = prompt();
    expect(text).toContain('detect the stack yourself');
    expect(text).toContain(`<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="${BOT_KEY}"></script>`);
  });

  it('points at the local widget preview and local API in a development dashboard', () => {
    const text = prompt({
      env: 'development',
      apiBaseUrl: 'http://localhost:8000',
      platform: nextjs,
    });
    expect(text).toContain('http://localhost:4173/oyechats-widget.js');
    expect(text).toContain('http://localhost:8000/chat');
    expect(text).not.toContain('cdn.oyechats.com');
  });

  it('normalizes a trailing slash on the API base so curl URLs stay clean', () => {
    const text = prompt({ apiBaseUrl: 'https://api.oyechats.com/' });
    expect(text).toContain('https://api.oyechats.com/chat');
    expect(text).not.toContain('https://api.oyechats.com//');
  });

  it('flags the paid probe and forbids spoofing the install origin', () => {
    const text = prompt({ platform: nextjs });
    expect(text).toMatch(/consumes one message credit/);
    expect(text).toMatch(/Do not add an `Origin` or `Referer` header/);
  });

  it('derives CSP hosts from the same URLs it tells the agent to call', () => {
    const text = prompt({ platform: nextjs });
    expect(text).toContain('script-src https://cdn.oyechats.com');
    expect(text).toContain('connect-src https://api.oyechats.com');
  });
});

describe('attribution', () => {
  it('documents the attribution anchor by default', () => {
    const text = prompt();
    expect(text).toContain('Powered by OyeChats');
    expect(text).toContain('rel="nofollow"');
    expect(text).toContain(`ref=${BOT_KEY}`);
  });

  it('omits the attribution anchor when attribution is off', () => {
    const text = prompt({ attribution: false });
    expect(text).not.toContain('Powered by OyeChats');
    expect(text).not.toContain('rel="nofollow"');
  });

  it('keeps every platform snippet free of hidden-text styling', () => {
    for (const platform of platforms) {
      const text = prompt({ platform });
      expect(text).not.toContain('display:none');
      expect(text).not.toContain('visibility:hidden');
    }
  });

  it('tells the agent the anchor must survive with JavaScript disabled', () => {
    const text = prompt();
    expect(text).toMatch(/curl/i);
    expect(text).toMatch(/server/i);
  });

  it('does not instruct the agent to remove an existing anchor when attribution is off', () => {
    const text = prompt({ attribution: false });
    const guideline = text.slice(text.indexOf('Attribution Link'));
    expect(guideline).not.toMatch(/\bremove\b/i);
    expect(guideline).not.toMatch(/\bdelete\b/i);
    expect(guideline).toMatch(/do not add/i);
  });
});
