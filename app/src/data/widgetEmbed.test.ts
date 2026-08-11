import { describe, it, expect } from 'vitest';
import {
  attributionHref,
  attributionAnchorHtml,
  attributionAnchorJsx,
  MANUAL_ATTRIBUTION_NOTE,
} from './widgetEmbed';

const KEY = 'bot-11a026a4b8b3';

describe('attributionHref', () => {
  it('tags the link with the bot key and utm params', () => {
    const url = new URL(attributionHref(KEY));
    expect(url.origin + url.pathname).toBe('https://www.oyechats.com/');
    expect(url.searchParams.get('ref')).toBe(KEY);
    expect(url.searchParams.get('utm_source')).toBe('widget');
    expect(url.searchParams.get('utm_medium')).toBe('referral');
  });

  it('omits ref for a malformed key', () => {
    expect(new URL(attributionHref('bad key!')).searchParams.get('ref')).toBeNull();
  });
});

describe('attributionAnchorHtml', () => {
  it('is a visible nofollow anchor carrying the brand name', () => {
    const html = attributionAnchorHtml(KEY);
    expect(html).toContain('rel="nofollow"');
    expect(html).toContain('>Powered by OyeChats</a>');
    expect(html).toContain(`ref=${KEY}`);
    expect(html).not.toContain('display:none');
  });
});

describe('attributionAnchorJsx', () => {
  it('emits JSX-shaped style and rel attributes', () => {
    const jsx = attributionAnchorJsx(KEY);
    expect(jsx).toContain('rel="nofollow"');
    expect(jsx).toContain('style={{');
    expect(jsx).toContain('Powered by OyeChats');
  });
});

describe('MANUAL_ATTRIBUTION_NOTE', () => {
  it('warns that tag-manager injection is not crawlable', () => {
    expect(MANUAL_ATTRIBUTION_NOTE).toMatch(/crawler/i);
  });
});
