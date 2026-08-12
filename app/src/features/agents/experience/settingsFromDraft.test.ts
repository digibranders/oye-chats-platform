/**
 * The avatar image is only written when the user changed it here.
 *
 * A crawl can set the agent's avatar from the site's favicon at any point after
 * this editor loaded its draft. Re-sending the loaded value on save wrote that
 * derived avatar straight back off — the PATCH merges by key, so including
 * `bot_logo: null` is an instruction to clear it, not an absence of opinion.
 *
 * The guard is "unchanged", not "empty": removing the avatar is a deliberate
 * edit and must still be sent.
 */

import { describe, expect, it } from 'vitest';
import {
  draftFromSettings,
  experienceDraftErrors,
  settingsFromDraft,
  type ExperienceDraft,
} from './types';

function draftWith(overrides: Partial<ExperienceDraft> = {}): ExperienceDraft {
  return {
    displayName: 'Acme Assistant',
    launcherName: 'Have Questions?',
    brandTonePreset: 'friendly',
    primaryColor: '#7C3AED',
    userBubbleColor: '#DBE9FF',
    avatarType: 'upload',
    orbColor: '',
    botLogo: null,
    botLogoSource: null,
    showBranding: true,
    brandingText: 'Powered by OyeChats',
    brandingUrl: 'https://www.oyechats.com',
    welcomeGreeting: 'Hi there',
    welcomeSubtitle: 'How can I help?',
    quickActions: [],
    suggestionsLayout: 'stacked',
    inputPlaceholder: 'Ask anything',
    companyName: 'Acme',
    companyDescription: 'We make things',
    extraWidgetMessages: {},
    ...overrides,
  } as ExperienceDraft;
}

describe('settingsFromDraft avatar handling', () => {
  it('omits the avatar image when it is unchanged from the loaded baseline', () => {
    const baseline = draftWith({ botLogo: null });
    const draft = draftWith({ botLogo: null, primaryColor: '#059669' });

    const payload = settingsFromDraft(draft, baseline);

    expect('bot_logo' in payload).toBe(false);
    expect('launcher_logo' in payload).toBe(false);
    // The edit the user actually made still goes.
    expect(payload.primary_color).toBe('#059669');
  });

  it('does not clobber an avatar derived after the editor loaded', () => {
    // Editor opened before the crawl finished, so it loaded no avatar. The
    // crawl then derived one. Saving an unrelated colour change must not
    // reach back and clear it.
    const baseline = draftWith({ botLogo: null });
    const draft = draftWith({ botLogo: null, userBubbleColor: '#eeeeee' });

    const payload = settingsFromDraft(draft, baseline);

    expect(payload).not.toHaveProperty('bot_logo');
    expect(payload).not.toHaveProperty('launcher_logo');
  });

  it('sends a newly uploaded avatar', () => {
    const baseline = draftWith({ botLogo: null });
    const draft = draftWith({ botLogo: 'logos/new.png' });

    const payload = settingsFromDraft(draft, baseline);

    expect(payload.bot_logo).toBe('logos/new.png');
    expect(payload.launcher_logo).toBe('logos/new.png');
  });

  it('sends a removal, because removing is a change and not an absence of one', () => {
    const baseline = draftWith({ botLogo: 'logos/old.png' });
    const draft = draftWith({ botLogo: null });

    const payload = settingsFromDraft(draft, baseline);

    expect('bot_logo' in payload).toBe(true);
    expect(payload.bot_logo).toBeNull();
    expect(payload.launcher_logo).toBeNull();
  });

  it('never sends provenance back — the server owns it', () => {
    // `bot_logo_source` is derived state stamped server-side on write. Echoing
    // a page-load snapshot of it would let the client assert a provenance it
    // has no authority over, including re-asserting 'derived' after the
    // customer replaced the image.
    const payload = settingsFromDraft(
      draftWith({ botLogo: 'logos/new.png', botLogoSource: 'derived' }),
      draftWith({ botLogo: null, botLogoSource: 'derived' }),
    );

    expect(payload).not.toHaveProperty('bot_logo_source');
    expect(payload).not.toHaveProperty('botLogoSource');
  });

  it('sends the avatar when no baseline is available to compare against', () => {
    // Without a baseline there is nothing to call "unchanged", so the caller's
    // value is authoritative — the pre-existing behaviour.
    const payload = settingsFromDraft(draftWith({ botLogo: 'logos/x.png' }));

    expect(payload.bot_logo).toBe('logos/x.png');
  });
});

describe('branding text/url round-trip', () => {
  it('reads a stored custom badge label and link from the raw settings payload', () => {
    const raw = {
      branding_text: 'Powered by Acme',
      branding_url: 'https://acme.example',
    };

    const draft = draftFromSettings(raw);

    expect(draft.brandingText).toBe('Powered by Acme');
    expect(draft.brandingUrl).toBe('https://acme.example');
  });

  it('falls back to the OyeChats defaults when the raw payload has no branding fields', () => {
    const draft = draftFromSettings({});

    expect(draft.brandingText).toBe('Powered by OyeChats');
    expect(draft.brandingUrl).toBe('https://www.oyechats.com');
  });

  it('falls back to the defaults when the stored values are blank', () => {
    const draft = draftFromSettings({ branding_text: '   ', branding_url: '' });

    expect(draft.brandingText).toBe('Powered by OyeChats');
    expect(draft.brandingUrl).toBe('https://www.oyechats.com');
  });

  it('persists a custom badge label and link unchanged', () => {
    const payload = settingsFromDraft(
      draftWith({ brandingText: 'Powered by Acme', brandingUrl: 'https://acme.example' }),
    );

    expect(payload.branding_text).toBe('Powered by Acme');
    expect(payload.branding_url).toBe('https://acme.example');
  });

  it('saves whitespace-only input as the default rather than a blank value', () => {
    const payload = settingsFromDraft(draftWith({ brandingText: '   ', brandingUrl: '   ' }));

    expect(payload.branding_text).toBe('Powered by OyeChats');
    expect(payload.branding_url).toBe('https://www.oyechats.com');
  });
});

describe('experienceDraftErrors', () => {
  it('passes a valid https badge URL when the fields are visible', () => {
    const draft = draftWith({ brandingUrl: 'https://acme.example' });

    expect(experienceDraftErrors(draft, true).brandingUrl).toBeNull();
  });

  it('passes an empty badge URL - clearing the field means "use the default", not a mistake', () => {
    const draft = draftWith({ brandingUrl: '' });

    expect(experienceDraftErrors(draft, true).brandingUrl).toBeNull();
  });

  it('passes a whitespace-only badge URL for the same reason', () => {
    const draft = draftWith({ brandingUrl: '   ' });

    expect(experienceDraftErrors(draft, true).brandingUrl).toBeNull();
  });

  it('fails a bare word that is not an absolute URL', () => {
    const draft = draftWith({ brandingUrl: 'not-a-url' });

    expect(experienceDraftErrors(draft, true).brandingUrl).not.toBeNull();
  });

  it('fails a javascript: URL', () => {
    const draft = draftWith({ brandingUrl: 'javascript:alert(1)' });

    expect(experienceDraftErrors(draft, true).brandingUrl).not.toBeNull();
  });

  it('reports no error for an invalid URL when the white-label fields are not visible', () => {
    // Not entitled, or entitled but branding switched back on - either way the
    // customer can't see or edit this field, so a stale invalid value left
    // over in the draft must never block them from saving unrelated changes.
    const draft = draftWith({ brandingUrl: 'not-a-url' });

    expect(experienceDraftErrors(draft, false).brandingUrl).toBeNull();
  });
});
