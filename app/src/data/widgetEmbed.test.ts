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

  it('cannot be used to inject markup via a hostile bot key', () => {
    const hostileKey = 'x" onmouseover="alert(1)';
    const html = attributionAnchorHtml(hostileKey);

    // The hostile key fails BOT_KEY_PATTERN, so `ref` is omitted entirely -
    // the output must be byte-identical to the "no ref" anchor.
    expect(html).toBe(attributionAnchorHtml(''));
    expect(html).not.toContain('onmouseover');

    // Exactly six `"` - one opening/closing pair each for href, rel, and
    // style - all belonging to the three expected attributes, nothing else.
    expect((html.match(/"/g) ?? []).length).toBe(6);
    // The only `<` and `>` are the anchor's own opening and closing tags.
    expect((html.match(/</g) ?? []).length).toBe(2);
    expect((html.match(/>/g) ?? []).length).toBe(2);
  });
});

describe('attributionAnchorJsx', () => {
  it('emits JSX-shaped style and rel attributes', () => {
    const jsx = attributionAnchorJsx(KEY);
    expect(jsx).toContain('rel="nofollow"');
    expect(jsx).toContain('style={{');
    expect(jsx).toContain('Powered by OyeChats');
    expect(jsx).toContain(attributionHref(KEY));
  });

  it('cannot be used to inject markup via a hostile bot key', () => {
    const hostileKey = 'x" onmouseover="alert(1)';
    const jsx = attributionAnchorJsx(hostileKey);

    expect(jsx).toBe(attributionAnchorJsx(''));
    expect(jsx).not.toContain('onmouseover');
  });
});

describe('MANUAL_ATTRIBUTION_NOTE', () => {
  it('warns that tag-manager injection is not crawlable', () => {
    expect(MANUAL_ATTRIBUTION_NOTE).toMatch(/crawler/i);
  });
});
