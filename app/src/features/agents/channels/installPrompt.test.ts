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

describe('the customer page gets the tag and nothing else', () => {
  it('never asks the agent to add markup of ours to the page', () => {
    const text = prompt();
    expect(text).not.toContain('Powered by OyeChats');
    expect(text).not.toContain('rel="nofollow"');
  });

  it('holds for every platform, not just the generic path', () => {
    for (const platform of platforms) {
      const text = prompt({ platform });
      expect(text).not.toContain('Powered by OyeChats');
      expect(text).not.toContain('rel="nofollow"');
    }
  });
});

/**
 * The prompt is pasted into someone else's coding agent, which has no other
 * source of truth about this product. If it does not carry the failure modes,
 * the agent reports "installed" for a tag in `<head>`, a blocked CSP, or a
 * localhost check that could never have registered.
 */
describe('buildInstallPrompt. Known failure modes', () => {
  it('warns that the tag in <head> never mounts', () => {
    expect(prompt()).toContain('<head>');
  });

  it('names the CSP directives rather than saying "check your CSP"', () => {
    const text = prompt();
    expect(text).toContain('script-src https://cdn.oyechats.com');
    expect(text).toContain('connect-src https://api.oyechats.com');
  });

  it('carries the exact www asymmetry that breaks the origin allow-list', () => {
    const text = prompt();
    expect(text).toContain('www.acme.com');
    expect(text).toContain('*.acme.com');
    expect(text).toContain('origin_not_allowed');
  });

  it('tells the agent localhost can never mark the widget installed', () => {
    expect(prompt()).toContain('localhost never counts as installed');
  });
});
