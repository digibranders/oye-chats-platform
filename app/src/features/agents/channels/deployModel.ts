/**
 * Deploy — the pure logic behind "is my chatbot actually live on my site?".
 *
 * Everything here is a function of data. No React, no DOM, no clipboard, so the
 * three things that decide whether a customer ever becomes a customer — the
 * snippet, the install state machine, and whether an allow-list is about to
 * block the customer's own website — are testable without rendering anything.
 *
 * The domain helpers mirror `api/app/core/origin_check.py` deliberately and
 * exactly, including its one sharp edge: `normalize_domain_input` strips a
 * leading `www.` before storing, while `extract_hostname` does **not** strip it
 * from the browser's `Origin` header. So an allow-list of `acme.com` does not
 * admit a site served at `www.acme.com` — only `*.acme.com` does. That single
 * asymmetry is the most likely way a customer takes their own widget offline,
 * so it is modelled here rather than left for them to discover in production.
 */
import { attributionAnchorHtml } from '../../../data/widgetEmbed';
import { widgetScriptUrl, type PlatformEnv } from '../../../data/platformIntegrations';
import { formatDateTime, type Tone } from '../../../ui';
import { t as translateNow } from '../../../i18n/i18n';

/** Mirrors `_MAX_ALLOWED_DOMAINS` in `api/app/api/bot_routes.py`. */
export const MAX_DOMAINS = 50;

/** How long we keep looking after the customer says they have installed it. */
export const VERIFY_TIMEOUT_MS = 90_000;
/** How often we re-ask the backend during that window. */
export const VERIFY_POLL_MS = 5_000;

/* ------------------------------------------------------------------ install */

/**
 * The five ways this page can answer its one question.
 *
 * `waiting` is deliberately **not** an error. A chatbot created two minutes ago
 * is not broken because nobody has pasted a script tag yet, and painting that
 * amber teaches people to ignore the colour. It only becomes a problem once the
 * customer has told us they installed it and we still cannot see it.
 *
 * `stale` is the other end of the same honesty rule. See {@link STALE_AFTER_MS}.
 */
export type InstallState = 'installed' | 'stale' | 'checking' | 'not-detected' | 'waiting';

export interface InstallStatus {
  state: InstallState;
  /** The word. Colour is never the only signal. */
  label: string;
  tone: Tone;
  detail: string;
}

/**
 * How quiet the heartbeat has to go before the green light is a lie.
 *
 * The stamp behind it (`widget_last_seen_at`) is written at most twice per bot
 * per hour, so a live site on a slow week still reports within a day or two.
 * Seven days is well past any plausible write cadence and short enough that a
 * customer who removed the snippet hears about it in the same sprint.
 */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface InstallStatusInput {
  /** `Bot.widget_installed_at` — a first-seen stamp, or null. */
  installedAt: string | null | undefined;
  /**
   * `Bot.widget_last_seen_at`, the liveness stamp, refreshed as the widget
   * boots. Optional: a chatbot installed before the heartbeat shipped has none,
   * and that absence is NOT evidence of an outage. See {@link widgetHeartbeat}.
   */
  lastSeenAt?: string | null | undefined;
  /** The customer has pressed "I've added it". */
  claimed: boolean;
  /** A verification poll is running right now. */
  checking: boolean;
  /** Injectable clock, so the staleness boundary is testable. */
  now?: number;
}

export function installStatus({
  installedAt,
  lastSeenAt,
  claimed,
  checking,
  now = Date.now(),
}: InstallStatusInput): InstallStatus {
  if (installedAt) {
    // `installedAt` is stamped once and never refreshed, so on its own it only
    // proves the widget loaded at least once, at some point. Reading it as
    // "live" put a green "we have seen this load on a real page of your site"
    // directly above a "Last seen: 7 months ago", for a customer who had
    // removed the snippet. Where a heartbeat exists it is the newer fact and it
    // wins; where it does not, the original reading stands, because no
    // heartbeat is not the same as a silent one.
    const seen = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
    if (Number.isFinite(seen) && now - seen > STALE_AFTER_MS) {
      return {
        state: 'stale',
        label: 'Not seen recently',
        tone: 'warning',
        detail: `We last saw this chatbot load on ${formatDateTime(lastSeenAt as string)}. If it should be live, check the snippet is still on your site.`,
      };
    }
    return {
      state: 'installed',
      label: translateNow('agents.liveOnYourWebsite') || 'Live on your website',
      tone: 'success',
      detail: translateNow('agents.weHaveSeenThisChatbot') || 'We have seen this chatbot load on a real page of your site.',
    };
  }
  if (checking) {
    return {
      state: 'checking',
      label: translateNow('agents.lookingForYourWidget') || 'Looking for your widget',
      tone: 'neutral',
      detail: translateNow('agents.openAPageOfYour') || 'Open a page of your site in another tab. We check every few seconds.',
    };
  }
  if (claimed) {
    return {
      state: 'not-detected',
      label: translateNow('agents.notDetectedYet') || 'Not detected yet',
      tone: 'warning',
      detail: translateNow('agents.theSnippetIsOnYour') || 'The snippet is on your site, but nothing has reached us from it yet.',
    };
  }
  return {
    state: 'waiting',
    label: translateNow('agents.waitingToBeInstalled') || 'Waiting to be installed',
    tone: 'neutral',
    detail: translateNow('agents.pasteTheSnippetOnYour') || 'Paste the snippet on your website and visitors can start chatting.',
  };
}

/**
 * `widget_installed_at` is stamped **once**, by a guarded `UPDATE ... WHERE
 * widget_installed_at IS NULL` in `api/app/api/bot_routes.py`. It is a
 * first-seen timestamp and nothing refreshes it, so labelling it "last seen"
 * would be a lie the customer would act on — they would read a stale date as an
 * outage. It is captioned for what it is.
 *
 * Liveness is a different column now: `widget_last_seen_at`, refreshed at most
 * twice per bot per hour. See {@link widgetHeartbeat}, which is careful about
 * everything that stamp cannot tell you.
 */
export const INSTALL_STAMP_CAPTION = 'First seen';

/* ---------------------------------------------------------------- heartbeat */

export interface WidgetHeartbeat {
  /** `null` when the backend has never recorded a bootstrap for this chatbot. */
  seenAt: string | null;
  /** What the reader should take from it, including when there is nothing. */
  detail: string;
  /** The hostname of the last bootstrap, or `null`. Diagnostic only. */
  origin: string | null;
}

/**
 * What the widget's liveness heartbeat does — and does not — prove.
 *
 * `widget_last_seen_at` is rate-limited to at most two writes per bot per hour,
 * so it answers "is this thing still out there?" and never "how busy is it?". A
 * missing value is the sharp edge: there is **no backfill**, so a chatbot
 * installed last year reads `null` until its widget next boots. Rendering that
 * as "the widget is down" would send a customer to debug a working site, so the
 * copy for the empty case says what is actually true — we have not recorded one
 * yet — and carries no alarm.
 *
 * `widget_last_origin` is taken from the browser's own `Origin` header, which
 * anyone can forge with two lines of curl. It is presented as a support
 * diagnostic and labelled as reported rather than verified, and nothing in this
 * console may branch on it. Enforcement of where the widget may run is
 * `allowed_domains`, which is configured under Access on this same page.
 */
export function widgetHeartbeat({
  installedAt,
  lastSeenAt,
  lastOrigin,
}: {
  installedAt: string | null | undefined;
  lastSeenAt: string | null | undefined;
  lastOrigin: string | null | undefined;
}): WidgetHeartbeat {
  const seenAt = lastSeenAt ?? null;
  const origin = lastOrigin?.trim() ? lastOrigin.trim() : null;

  if (!seenAt) {
    return {
      seenAt: null,
      origin,
      detail: installedAt
        ? translateNow('agents.weHaveNotRecordedA') || 'We have not recorded a load since this check was added. It appears the next time somebody opens a page with your chatbot on it. An empty reading here does not mean the chatbot is down.'
        : translateNow('agents.nothingHasLoadedYourChatbot') || 'Nothing has loaded your chatbot yet.',
    };
  }

  return {
    seenAt,
    origin,
    detail:
      translateNow('agents.recordedAtMostTwiceAn') || 'Recorded at most twice an hour, so it shows that your chatbot is still on your site, not how busy it has been.',
  };
}

/* ------------------------------------------------------------------ domains */

const HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Reduce free-form input to what the backend will actually store.
 *
 * Mirrors `normalize_domain_input`: scheme, port, path and a leading `www.` all
 * come off, a deliberate `*.` prefix survives. Returns `null` when the result
 * could not be a hostname, so the caller can explain the failure instead of
 * posting something the API will reject.
 */
export function normalizeDomain(input: string): string | null {
  let value = String(input ?? '').trim().toLowerCase();
  if (!value) return null;

  let wildcard = false;
  if (value.startsWith('*.')) {
    wildcard = true;
    value = value.slice(2);
  }
  value = value.replace(/^https?:\/\//, '');
  value = value.split('/')[0];
  value = value.split(':')[0];
  if (value.startsWith('www.')) value = value.slice(4);
  if (!value) return null;
  if (LOCAL_HOSTS.has(value)) return wildcard ? null : value;
  if (!HOSTNAME_PATTERN.test(value)) return null;
  return wildcard ? `*.${value}` : value;
}

/**
 * The hostname a browser will put in the `Origin` header for this address.
 *
 * Mirrors `extract_hostname`, and critically does **not** strip `www.` — that
 * is the whole point of keeping it separate from `normalizeDomain`.
 */
export function originHost(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const candidate = raw.includes('://') ? raw : `https://${raw}`;
  try {
    const host = new URL(candidate).hostname.trim().toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

/** Mirrors `is_origin_allowed`. A wildcard matches a strict subdomain, never the apex. */
export function isOriginAllowed(host: string | null, allowed: readonly string[]): boolean {
  if (!host) return false;
  const target = host.trim().toLowerCase();
  if (!target) return false;

  for (const raw of allowed) {
    const entry = String(raw ?? '').trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".acme.com"
      if (target.endsWith(suffix) && target !== suffix.slice(1)) return true;
      continue;
    }
    if (target === entry) return true;
  }
  return false;
}

/**
 * The allow-list entries that cover a website, apex and subdomains alike.
 *
 * Always both, never just the apex: `*.acme.com` is what admits `www.acme.com`,
 * and `www` is the single most common way a site is actually served.
 */
export function entriesForWebsite(website: string | null | undefined): string[] {
  const apex = normalizeDomain(website ?? '');
  if (!apex) return [];
  if (apex.startsWith('*.') || LOCAL_HOSTS.has(apex)) return [apex];
  // `localhost` rides along so the customer can try the widget on a dev server
  // before it is live. The backend auto-allows localhost only when APP_ENV is
  // not production, so against the real API it is blocked the moment the
  // allow-list stops being empty, which is exactly when the customer adds
  // their own domains. Without this, turning the allow-list on is what breaks
  // local testing, and the failure is silent: the launcher simply never
  // appears.
  //
  // It is a suggestion, not a hidden grant: it lands as a chip the customer
  // can see and delete before going live. The access it opens is narrow.
  // An attacker holding the public bot key could embed the bot on their own
  // machine, where only they can see it, while the same bot already answers
  // anyone who visits the customer's real site. What the allow-list actually
  // defends is a stolen key embedded on another PUBLIC site, which localhost
  // is not, and scripted abuse was never covered here at all because a
  // non-browser client can forge `Origin` (see api/app/core/origin_check.py).
  return [apex, `*.${apex}`, 'localhost'];
}

export interface DomainRisk {
  /** The host that would be turned away. */
  host: string;
  /** The entries that would let it back in. */
  suggestions: string[];
}

/**
 * Would saving this configuration lock the customer out of their own website?
 *
 * Only ever non-null when enforcement is on **and** the list is non-empty,
 * because `_enforce_bot_origin` fails open on an empty allow-list — an empty
 * list blocks nobody, so warning about one would be crying wolf.
 */
export function ownSiteRisk({
  website,
  domains,
  enabled,
}: {
  website: string | null | undefined;
  domains: readonly string[];
  enabled: boolean;
}): DomainRisk | null {
  if (!enabled || domains.length === 0) return null;
  const host = originHost(website);
  if (!host) return null;
  if (isOriginAllowed(host, domains)) return null;
  const apex = normalizeDomain(host);
  const suggestions = apex ? (apex === host ? [apex] : [apex, `*.${apex}`]) : [];
  return { host, suggestions };
}

export interface DomainNotice {
  id: string;
  tone: Extract<Tone, 'neutral' | 'warning' | 'danger'>;
  title: string;
  body: string;
}

/** What the current allow-list actually does, said in one line. */
export function domainNotice({
  website,
  domains,
  enabled,
}: {
  website: string | null | undefined;
  domains: readonly string[];
  enabled: boolean;
}): DomainNotice {
  if (!enabled) {
    return {
      id: 'off',
      tone: 'warning',
      title: translateNow('agents.anyWebsiteCanEmbedThis') || 'Any website can embed this chatbot',
      body: translateNow('agents.yourEmbedKeyIsVisible') || 'Your embed key is visible in your page source, so anyone who copies it can run your chatbot, and spend your credits, on their own site.',
    };
  }
  if (domains.length === 0) {
    return {
      id: 'empty',
      tone: 'warning',
      title: translateNow('agents.nothingIsBeingEnforcedYet') || 'Nothing is being enforced yet',
      body: translateNow('agents.theCheckIsOnBut') || 'The check is on but the list is empty, and an empty list lets every origin through. Add your website to actually lock it down.',
    };
  }
  const risk = ownSiteRisk({ website, domains, enabled });
  if (risk) {
    return {
      id: 'locked-out',
      tone: 'danger',
      title: `${risk.host} is not on this list`,
      body: `Your chatbot is set up for ${risk.host}, and requests from it would be turned away. Add ${risk.suggestions.join(' and ') || 'it'} before saving.`,
    };
  }
  return {
    id: 'ok',
    tone: 'neutral',
    title: `Locked to ${domains.length} ${domains.length === 1 ? 'domain' : 'domains'}`,
    body: translateNow('agents.requestsFromAnyOtherWebsite') || 'Requests from any other website are rejected.',
  };
}

/* ------------------------------------------------------------------ snippet */

export interface SnippetInput {
  botKey: string;
  env: PlatformEnv;
  /** Include the crawlable attribution anchor. */
  attribution: boolean;
}

/**
 * The markup a customer pastes. One builder, so the page, the platform guide,
 * the developer email and the AI prompt can never quote three different things.
 *
 * The anchor is not decoration. The widget mounts into a shadow root from
 * JavaScript after a visitor clicks the launcher, so its in-widget badge is
 * invisible to every crawler — this anchor is the only attribution that lands in
 * the HTML the customer's server sends.
 */
export function embedSnippet({ botKey, env, attribution }: SnippetInput): string {
  const tag = `<script src="${widgetScriptUrl(env)}" data-bot-key="${botKey}"></script>`;
  return attribution ? `${tag}\n${attributionAnchorHtml(botKey)}` : tag;
}

/** The origin a Content-Security-Policy has to allow for the bundle to load. */
export function scriptOrigin(env: PlatformEnv): string {
  try {
    return new URL(widgetScriptUrl(env)).origin;
  } catch {
    return widgetScriptUrl(env);
  }
}

/** The origin a Content-Security-Policy has to allow for the widget to answer. */
export function apiOrigin(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    return apiBaseUrl.replace(/\/+$/, '');
  }
}

/* ---------------------------------------------------------- troubleshooting */

export interface TroubleshootItem {
  id: string;
  title: string;
  body: string;
  /** A value the customer needs to paste or compare. Rendered as a code block. */
  code?: string;
}

export interface TroubleshootInput {
  botKey: string;
  env: PlatformEnv;
  apiBaseUrl: string;
  domainCheckEnabled: boolean;
  domainsConfigured: number;
  website: string | null | undefined;
  domains: readonly string[];
}

/**
 * The failure modes we actually know about, in the order they actually happen.
 *
 * Not "contact support". Every entry is something the customer can check in
 * under a minute, and the two that are specific to this product — the origin
 * allow-list, and the fact that we only count an install seen from a real
 * external site — lead, because nothing else on the internet will tell them.
 */
export function troubleshootItems(input: TroubleshootInput): TroubleshootItem[] {
  const {
    botKey,
    env,
    apiBaseUrl,
    domainCheckEnabled,
    domainsConfigured,
    website,
    domains,
  } = input;

  const items: TroubleshootItem[] = [];

  const risk = ownSiteRisk({ website, domains, enabled: domainCheckEnabled });
  if (risk) {
    items.push({
      id: 'allow-list',
      title: `Your allow-list is turning away ${risk.host}`,
      body: `Allowed domains is on, and ${risk.host} does not match any entry, so every request from your own site is rejected before it reaches your chatbot. Add ${risk.suggestions.join(' and ') || 'your website'} under Access, further up this page.`,
    });
  } else if (domainCheckEnabled && domainsConfigured > 0) {
    items.push({
      id: 'allow-list-subdomain',
      title: translateNow('agents.checkTheExactAddressThe') || 'Check the exact address the page is served from',
      body: translateNow('agents.allowedDomainsIsOnAn') || 'Allowed domains is on. An entry for acme.com does not cover www.acme.com or shop.acme.com; only *.acme.com does. Compare the address bar on the page you installed to your allowed domains, character for character.',
    });
  }

  items.push(
    {
      id: 'external',
      title: translateNow('agents.weOnlyCountAReal') || 'We only count a real page on your own domain',
      body: translateNow('agents.aLoadFromLocalhostFrom') || 'A load from localhost, from a file:// page, or from the preview on this dashboard never counts as installed. That is deliberate, so a preview cannot mark you live. Open the page on the domain your visitors use.',
    },
    {
      id: 'body',
      title: translateNow('agents.theTagHasToBe') || 'The tag has to be in <body>, not <head>',
      body: translateNow('agents.inHeadTheScriptRuns') || 'In <head> the script runs before there is a document to mount into, so the launcher never appears. Paste it immediately before the closing </body> tag.',
    },
    {
      id: 'bot-key',
      title: translateNow('agents.checkTheKeyOnThe') || 'Check the key on the tag character for character',
      body: translateNow('agents.aSnippetCopiedFromA') || 'A snippet copied from a different chatbot loads a widget that works perfectly and reports to the wrong place. This chatbot is:',
      code: botKey,
    },
    {
      id: 'csp',
      title: translateNow('agents.aContentSecurityPolicyWill') || 'A Content-Security-Policy will block the bundle silently',
      body: translateNow('agents.ifYourSiteSendsA') || 'If your site sends a CSP header, the browser refuses the script with a console error and nothing else. Allow both of these:',
      code: `script-src ${scriptOrigin(env)};\nconnect-src ${apiOrigin(apiBaseUrl)};`,
    },
    {
      id: 'cache',
      title: translateNow('agents.aCacheMayStillBe') || 'A cache may still be serving the old page',
      body: translateNow('agents.cloudflareVarnishAWordpressCache') || 'Cloudflare, Varnish, a WordPress cache plugin or your host’s own CDN can keep serving the HTML from before you added the tag. Purge the cache, then reload the page with a hard refresh.',
    },
    {
      id: 'blockers',
      title: translateNow('agents.checkItInAClean') || 'Check it in a clean browser window',
      body: translateNow('agents.anAdBlockerOrA') || 'An ad blocker or a privacy extension on your own machine can remove the widget for you and nobody else. Open the page in a private window with extensions off before concluding it is not installed.',
    },
  );

  return items;
}

/* ------------------------------------------------- send it to your developer */

/**
 * For an SMB the person who signs up very often cannot edit the website.
 * "Email this to whoever runs your site" is a first-class install path, not a
 * fallback — the previous onboarding assumed the buyer was the installer and
 * dead-ended everyone who was not.
 */
export function developerEmail({
  botName,
  snippet,
  env,
  apiBaseUrl,
  platformName,
  attribution,
}: {
  botName: string;
  snippet: string;
  env: PlatformEnv;
  apiBaseUrl: string;
  platformName?: string | null;
  /** True when the snippet carries the attribution anchor, so the note applies. */
  attribution: boolean;
}): { subject: string; body: string; href: string } {
  const subject = `Please add the ${botName} chat widget to our website`;
  const body = [
    `Hi,`,
    ``,
    `We use OyeChats for the chat assistant on our website. Could you add this to`,
    `every page, immediately before the closing </body> tag?`,
    ``,
    snippet,
    ``,
    platformName
      ? `Our site runs on ${platformName}.`
      : `It goes in the shared layout or footer template, so it loads site-wide.`,
    ``,
    `Two things that catch people out:`,
    `- It must be in <body>, not <head>.`,
    `- If we send a Content-Security-Policy header, it needs`,
    `  script-src ${scriptOrigin(env)} and connect-src ${apiOrigin(apiBaseUrl)}.`,
    ...(attribution
      ? [
          ``,
          `The second line is a small visible "Powered by OyeChats" credit link.`,
          `Please keep it in the served HTML and do not hide it with CSS. A hidden`,
          `link is a Google policy violation against our own domain.`,
        ]
      : []),
    ``,
    `Thanks!`,
  ].join('\n');

  return {
    subject,
    body,
    href: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
  };
}

// ── Hosted demo page ────────────────────────────────────────────────────────

/**
 * How long a stored capture stays fresh. Mirrors `DEMO_SCREENSHOT_TTL_DAYS`
 * on the API, which is the side that actually decides what the demo link
 * renders. Duplicated as a constant rather than fetched because it changes
 * about never, and a wrong guess here only mislabels a notice.
 */
export const DEMO_CAPTURE_TTL_DAYS = 30;

export type DemoPreviewState =
  /** No website on the chatbot, so there is nothing to capture. */
  | { kind: 'no-website' }
  /** A capture is queued or running. */
  | { kind: 'pending' }
  /** A usable, current capture: the demo link shows the customer's own site. */
  | { kind: 'ready' }
  /** Captured, but old enough that the site may have changed since. */
  | { kind: 'stale'; capturedAt: string }
  /** The site could not be rendered, or has never been captured. */
  | { kind: 'unavailable' };

/**
 * What the shared demo link will actually show a recipient.
 *
 * This exists because the answer is not "whatever the customer's website is".
 * The demo page renders a stored screenshot of their site, and when there
 * isn't one it falls back to a generic page. Reporting that plainly is the
 * difference between a customer who recaptures and one who sends a prospect a
 * link to a stand-in without realising.
 */
export function demoPreviewState({
  website,
  status,
  capturedAt,
  now = new Date(),
  ttlDays = DEMO_CAPTURE_TTL_DAYS,
}: {
  website: string | null | undefined;
  status: string | null | undefined;
  capturedAt: string | null | undefined;
  now?: Date;
  ttlDays?: number;
}): DemoPreviewState {
  if (!website || !website.trim()) return { kind: 'no-website' };
  if (status === 'pending') return { kind: 'pending' };
  if (status !== 'ready') return { kind: 'unavailable' };
  if (!capturedAt) return { kind: 'unavailable' };

  const taken = new Date(capturedAt);
  // An unparseable timestamp is not evidence of freshness. Treat the capture
  // as present but undateable rather than silently calling it current.
  if (Number.isNaN(taken.getTime())) return { kind: 'ready' };

  const ageDays = (now.getTime() - taken.getTime()) / 86_400_000;
  return ageDays > ttlDays ? { kind: 'stale', capturedAt } : { kind: 'ready' };
}
