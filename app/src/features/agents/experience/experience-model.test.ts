import { describe, expect, it } from 'vitest';
import {
  answerIsStale,
  changedSections,
  defaultBusinessHours,
  draftFromBot,
  draftsEqual,
  isHttpUrl,
  metaFromBot,
  normalizeDraft,
  patchFromDraft,
  sectionsWithErrors,
  validateDraft,
  type ExperienceDraft,
} from './experience-model';

/**
 * The model is where every promise this page makes is actually kept: that a
 * save sends only what changed, that a business-hours payload is the shape the
 * server reads, and that an invalid value is caught before it becomes a 422.
 */

const RAW: Record<string, unknown> = {
  id: 7,
  bot_key: 'bot-abc123',
  name: 'Acme Assistant',
  website: 'https://acme.test',
  plan_slug: 'standard',
  plan_name: 'Standard',
  crawl_completed_at: '2026-08-01T10:00:00Z',
  primary_color: '#2b66bc',
  user_bubble_color: '#dbe9ff',
  avatar_type: 'upload',
  orb_color: null,
  bot_logo: 'https://cdn.test/logo.png',
  bot_logo_source: 'derived',
  recommended_colors: ['#2b66bc', 'not-a-colour', '#1b6b4c'],
  branding_text: 'Powered by Acme',
  branding_url: 'https://acme.test',
  feature_flags: { show_branding: false, something_else: true },
  widget_messages: {
    welcome_greeting: 'Hello',
    welcome_suggestions: ['What do you cost?'],
    welcome_suggestions_layout: 'vertical',
    offline_message: 'Back soon',
    unknown_key_owned_by_nobody: 'keep me',
  },
  system_prompt: 'Be brief.',
  brand_tone: 'Warm',
  brand_tone_preset: 'friendly',
  company_name: 'Acme',
  company_description: 'We make things',
  services: [{ name: 'SEO', url: 'https://acme.test/seo' }, 'Legacy string service'],
  answer_links: [{ keyword: 'pricing', url: 'https://acme.test/pricing' }],
  live_chat_enabled: true,
  waiting_message: 'One moment',
  offline_message: 'Nobody is here',
  handoff_delay_seconds: 5,
  live_chat_queue_timeout_seconds: 30,
  live_chat_max_queue_size: 5,
  business_hours: { timezone: 'Asia/Kolkata', mon: { start: '09:00', end: '17:00' }, sun: null },
  lead_form_enabled: true,
  lead_form_fields: [{ field: 'email', required: true }, { field: 'nope' }],
};

function load(): ExperienceDraft {
  return draftFromBot(RAW);
}

describe('draftFromBot', () => {
  it('reads the two offline messages as the two different fields they are', () => {
    const draft = load();
    // The widget's own banner lives in `widget_messages`; the live-chat handoff
    // reply is a top-level column. Reading either into both is how one edit
    // silently overwrote the other.
    expect(draft.offlineBanner).toBe('Back soon');
    expect(draft.handoffOfflineMessage).toBe('Nobody is here');
  });

  it('normalises a legacy string service into a row the editor can edit', () => {
    expect(load().services).toEqual([
      { name: 'SEO', url: 'https://acme.test/seo' },
      { name: 'Legacy string service', url: '' },
    ]);
  });

  it('drops a lead-form row naming a field that does not exist', () => {
    expect(load().leadFormFields).toEqual([{ field: 'email', required: true }]);
  });

  it('falls back to a colour the picker can edit when the stored one is junk', () => {
    expect(draftFromBot({ primary_color: 'rebeccapurple' }).primaryColor).toBe('#a21caf');
  });

  it('reads business hours as the flat shape the server stores', () => {
    const hours = load().businessHours;
    expect(hours?.timezone).toBe('Asia/Kolkata');
    expect(hours?.days.mon).toEqual({ start: '09:00', end: '17:00' });
    expect(hours?.days.sun).toBeNull();
    // A day the payload never mentioned is closed, not open.
    expect(hours?.days.sat).toBeNull();
  });

  it('treats an absent schedule as always available', () => {
    expect(draftFromBot({}).businessHours).toBeNull();
    expect(draftFromBot({ business_hours: {} }).businessHours).toBeNull();
  });
});

describe('metaFromBot', () => {
  it('keeps the saved wording for the preview, but never as an editable field', () => {
    /* The credit line is show-or-hide only: the wording is OyeChats' own mark,
       so it is read for display via the meta and is not part of the editable
       draft. The draft carries just the on/off switch. */
    expect(metaFromBot(RAW).brandingText).toBe('Powered by Acme');
    const draft = draftFromBot(RAW);
    expect(draft.showBranding).toBe(false);
    expect('brandingText' in draft).toBe(false);
    expect('brandingUrl' in draft).toBe(false);
  });

  it('drops a recommended colour that is not a colour', () => {
    expect(metaFromBot(RAW).recommendedColors).toEqual(['#2b66bc', '#1b6b4c']);
  });

  it('reads "trained" from the crawl having finished', () => {
    expect(metaFromBot(RAW).trained).toBe(true);
    expect(metaFromBot({}).trained).toBe(false);
  });
});

describe('patchFromDraft', () => {
  it('sends nothing at all when nothing changed', () => {
    const draft = load();
    expect(patchFromDraft(draft, load())).toEqual({});
  });

  it('sends only the field that changed', () => {
    const baseline = load();
    const patch = patchFromDraft({ ...baseline, welcomeGreeting: 'Hi!' }, baseline);
    expect(patch).toEqual({ widget_messages: { welcome_greeting: 'Hi!' } });
  });

  it('never re-sends an unchanged avatar', () => {
    // A crawl can derive an avatar from the site's favicon while this editor is
    // open. Re-sending the value the page loaded before that happened writes
    // the derived avatar back off, because the PATCH merges by key.
    const baseline = load();
    const patch = patchFromDraft({ ...baseline, primaryColor: '#111111' }, baseline);
    expect(patch).not.toHaveProperty('bot_logo');
  });

  it('sends a cleared avatar, because removing one is a real edit', () => {
    const baseline = load();
    expect(patchFromDraft({ ...baseline, botLogo: null }, baseline)).toEqual({ bot_logo: null });
  });

  it('sends feature flags as a partial the server merges, not a replacement', () => {
    const baseline = load();
    const patch = patchFromDraft({ ...baseline, showBranding: true }, baseline);
    // `something_else` is untouched and absent: the handler merges this into
    // the stored map, so listing only what changed preserves the rest.
    expect(patch).toEqual({ feature_flags: { show_branding: true } });
  });

  it('leaves widget-message keys this page does not own alone', () => {
    const baseline = load();
    const patch = patchFromDraft({ ...baseline, inputPlaceholder: 'Ask me' }, baseline);
    expect(patch.widget_messages).toEqual({ input_placeholder: 'Ask me' });
  });

  it('writes business hours flat, with a closed day as null and no wrapper', () => {
    const baseline = load();
    const patch = patchFromDraft(
      { ...baseline, businessHours: defaultBusinessHours('Europe/London') },
      baseline,
    );
    // `bot_routes.BusinessHours` sets `extra="forbid"`, so an `enabled` flag or
    // a `days` wrapper is a 422 rather than a value that is merely ignored.
    expect(patch.business_hours).toEqual({
      timezone: 'Europe/London',
      mon: { start: '09:00', end: '17:00' },
      tue: { start: '09:00', end: '17:00' },
      wed: { start: '09:00', end: '17:00' },
      thu: { start: '09:00', end: '17:00' },
      fri: { start: '09:00', end: '17:00' },
      sat: null,
      sun: null,
    });
  });

  it('clears the schedule with an explicit null so the chatbot is always open', () => {
    const baseline = load();
    expect(patchFromDraft({ ...baseline, businessHours: null }, baseline)).toEqual({
      business_hours: null,
    });
  });

  it('sends an empty orb colour as null, which is what the hex validator takes', () => {
    const baseline = { ...load(), orbColor: '#123456' };
    expect(patchFromDraft({ ...baseline, orbColor: '' }, baseline)).toEqual({ orb_color: null });
  });

  it('sends a service with no link as an explicit null rather than an empty string', () => {
    const baseline = load();
    const patch = patchFromDraft(
      { ...baseline, services: [{ name: 'Audit', url: '' }] },
      baseline,
    );
    expect(patch.services).toEqual([{ name: 'Audit', url: null }]);
  });
});

describe('normalizeDraft', () => {
  it('drops the empty rows the server would refuse', () => {
    const draft = normalizeDraft({
      ...load(),
      quickActions: ['  ', 'Real question', ''],
      services: [{ name: '  ', url: '' }],
      smartLinks: [
        { keyword: 'pricing', url: 'not a url' },
        { keyword: '', url: 'https://x.test' },
      ],
    });
    expect(draft.quickActions).toEqual(['Real question']);
    expect(draft.services).toEqual([]);
    expect(draft.smartLinks).toEqual([]);
  });

  it('keeps the first of two rows with the same keyword, as the server does', () => {
    const draft = normalizeDraft({
      ...load(),
      smartLinks: [
        { keyword: 'Pricing', url: 'https://a.test' },
        { keyword: 'pricing', url: 'https://b.test' },
      ],
    });
    expect(draft.smartLinks).toEqual([{ keyword: 'Pricing', url: 'https://a.test' }]);
  });

  it('clamps the queue numbers into the range the server accepts', () => {
    const draft = normalizeDraft({ ...load(), queueTimeoutSeconds: 9000, maxQueueSize: 0 });
    expect(draft.queueTimeoutSeconds).toBe(600);
    expect(draft.maxQueueSize).toBe(1);
  });
});

describe('changedSections', () => {
  it('names the tab the unsaved work is on', () => {
    const baseline = load();
    expect(changedSections({ ...baseline, primaryColor: '#000000' }, baseline)).toEqual(['branding']);
    expect(
      changedSections({ ...baseline, primaryColor: '#000000', systemPrompt: 'x' }, baseline),
    ).toEqual(['branding', 'voice']);
    expect(changedSections(baseline, baseline)).toEqual([]);
  });

  it('sees a change inside an array, not only a replaced field', () => {
    const baseline = load();
    expect(draftsEqual({ ...baseline, quickActions: ['Different'] }, baseline)).toBe(false);
    expect(draftsEqual({ ...baseline, quickActions: [...baseline.quickActions] }, baseline)).toBe(true);
  });
});

describe('answerIsStale', () => {
  it('is true only for edits that change what the chatbot would say', () => {
    const baseline = load();
    expect(answerIsStale({ ...baseline, systemPrompt: 'Be terse.' }, baseline)).toBe(true);
    expect(answerIsStale({ ...baseline, services: [] }, baseline)).toBe(true);
    // A colour cannot change a reply, so the preview must not nag about it.
    expect(answerIsStale({ ...baseline, primaryColor: '#000000' }, baseline)).toBe(false);
  });
});

describe('validateDraft', () => {
  it('accepts the loaded record', () => {
    expect(validateDraft(load())).toEqual({});
  });

  it('refuses to let the chatbot lose its name', () => {
    expect(validateDraft({ ...load(), displayName: '   ' }).displayName).toBeTruthy();
  });

  it('catches a colour the server would reject', () => {
    expect(validateDraft({ ...load(), primaryColor: 'blue' }).primaryColor).toBeTruthy();
    expect(validateDraft({ ...load(), orbColor: '' }).orbColor).toBeUndefined();
  });

  it('points a smart-link error at the row that caused it', () => {
    const errors = validateDraft({
      ...load(),
      smartLinks: [
        { keyword: 'ok', url: 'https://fine.test' },
        { keyword: 'bad', url: 'ftp://nope.test' },
      ],
    });
    expect(errors['smartLinks:0']).toBeUndefined();
    expect(errors['smartLinks:1']).toBeTruthy();
  });

  it('names a duplicate keyword rather than silently dropping the second row', () => {
    const errors = validateDraft({
      ...load(),
      smartLinks: [
        { keyword: 'pricing', url: 'https://a.test' },
        { keyword: 'Pricing', url: 'https://b.test' },
      ],
    });
    expect(errors['smartLinks:1']).toContain('already mapped');
  });

  it('rejects a schedule with every day closed instead of taking the chatbot offline forever', () => {
    const hours = defaultBusinessHours('UTC');
    const closed = {
      ...hours,
      days: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
    };
    expect(validateDraft({ ...load(), businessHours: closed }).businessHours).toBeTruthy();
  });

  it('rejects a day whose open and close times are identical', () => {
    const hours = defaultBusinessHours('UTC');
    hours.days.mon = { start: '09:00', end: '09:00' };
    expect(validateDraft({ ...load(), businessHours: hours })['businessHours:mon']).toBeTruthy();
  });

  it('allows a shift that runs past midnight', () => {
    const hours = defaultBusinessHours('UTC');
    hours.days.mon = { start: '22:00', end: '02:00' };
    expect(validateDraft({ ...load(), businessHours: hours })['businessHours:mon']).toBeUndefined();
  });
});

describe('sectionsWithErrors', () => {
  it('is empty when nothing is invalid', () => {
    expect(sectionsWithErrors({})).toEqual([]);
  });

  it('maps a bare-field error to its tab', () => {
    expect(sectionsWithErrors({ displayName: 'required' })).toEqual(['messages']);
    expect(sectionsWithErrors({ primaryColor: 'bad hex' })).toEqual(['branding']);
  });

  it('resolves an indexed or day-suffixed key by its prefix', () => {
    expect(sectionsWithErrors({ 'smartLinks:1': 'bad' })).toEqual(['voice']);
    expect(sectionsWithErrors({ 'businessHours:mon': 'bad' })).toEqual(['handoff']);
  });

  it('dedupes and returns tabs in canonical order', () => {
    expect(
      sectionsWithErrors({
        'businessHours:mon': 'bad',
        primaryColor: 'bad',
        'services:0': 'bad',
        'services:2': 'bad',
      }),
    ).toEqual(['branding', 'voice', 'handoff']);
  });
});

describe('isHttpUrl', () => {
  it('takes only what the server’s HttpUrlStr takes', () => {
    expect(isHttpUrl('https://acme.test/x')).toBe(true);
    expect(isHttpUrl('http://acme.test')).toBe(true);
    expect(isHttpUrl('acme.test')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

// The pricing restriction is unconditional: there is no toggle, and the URL is
// the only control. An empty URL is a valid configuration meaning every pricing
// question routes to the team rather than being answered from the rest of the
// knowledge base.
describe('pricing page', () => {
  it('parses the pricing page off the bot payload', () => {
    const draft = draftFromBot({ ...RAW, pricing_url: 'https://acme.test/pricing' });
    expect(draft.pricingUrl).toBe('https://acme.test/pricing');
  });

  it('defaults the pricing page to empty when the payload omits it', () => {
    const draft = draftFromBot({ ...RAW });
    expect(draft.pricingUrl).toBe('');
  });

  it('patches only the changed pricing fields', () => {
    const baseline = draftFromBot({ ...RAW });
    const draft = { ...baseline, pricingUrl: 'https://acme.test/pricing' };
    const patch = patchFromDraft(draft, baseline);
    expect(patch.pricing_url).toBe('https://acme.test/pricing');
    expect(Object.keys(patch)).toEqual(['pricing_url']);
  });

  it('sends nothing when the pricing page did not change', () => {
    const baseline = draftFromBot({ ...RAW, pricing_url: 'https://acme.test/pricing' });
    expect(patchFromDraft({ ...baseline }, baseline)).toEqual({});
  });

  it('accepts an empty pricing page, which routes every pricing question to the team', () => {
    const baseline = draftFromBot({ ...RAW });
    expect(baseline.pricingUrl).toBe('');
    expect(validateDraft(baseline).pricingUrl).toBeUndefined();
    expect(validateDraft({ ...baseline, pricingUrl: '   ' }).pricingUrl).toBeUndefined();
  });

  it('rejects a non-empty pricing page that is not a usable link', () => {
    const baseline = draftFromBot({ ...RAW });
    expect(validateDraft({ ...baseline, pricingUrl: 'acme.test/pricing' }).pricingUrl).toBeTruthy();
    expect(
      validateDraft({ ...baseline, pricingUrl: 'javascript:alert(1)' }).pricingUrl,
    ).toBeTruthy();
  });

  it('accepts a well-formed pricing page link', () => {
    const baseline = draftFromBot({ ...RAW });
    expect(
      validateDraft({ ...baseline, pricingUrl: 'https://acme.test/pricing' }).pricingUrl,
    ).toBeUndefined();
  });
});
