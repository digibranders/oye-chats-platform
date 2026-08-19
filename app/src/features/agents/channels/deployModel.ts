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
import type { Tone } from '../../../ui';

/** Mirrors `_MAX_ALLOWED_DOMAINS` in `api/app/api/bot_routes.py`. */
export const MAX_DOMAINS = 50;

/** How long we keep looking after the customer says they have installed it. */
export const VERIFY_TIMEOUT_MS = 90_000;
/** How often we re-ask the backend during that window. */
export const VERIFY_POLL_MS = 5_000;

/* ------------------------------------------------------------------ install */

/**
 * The four ways this page can answer its one question.
 *
 * `waiting` is deliberately **not** an error. A chatbot created two minutes ago
 * is not broken because nobody has pasted a script tag yet, and painting that
 * amber teaches people to ignore the colour. It only becomes a problem once the
 * customer has told us they installed it and we still cannot see it.
 */
export type InstallState = 'installed' | 'checking' | 'not-detected' | 'waiting';

export interface InstallStatus {
  state: InstallState;
  /** The word. Colour is never the only signal. */
  label: string;
  tone: Tone;
  detail: string;
}

export interface InstallStatusInput {
  /** `Bot.widget_installed_at` — a first-seen stamp, or null. */
  installedAt: string | null | undefined;
  /** The customer has pressed "I've added it". */
  claimed: boolean;
  /** A verification poll is running right now. */
  checking: boolean;
}

export function installStatus({ installedAt, claimed, checking }: InstallStatusInput): InstallStatus {
  if (installedAt) {
    return {
      state: 'installed',
      label: 'Live on your website',
      tone: 'success',
      detail: 'We have seen this chatbot load on a real page of your site.',
    };
  }
  if (checking) {
    return {
      state: 'checking',
      label: 'Looking for your widget',
      tone: 'neutral',
      detail: 'Open a page of your site in another tab — we check every few seconds.',
    };
  }
  if (claimed) {
    return {
      state: 'not-detected',
      label: 'Not detected yet',
      tone: 'warning',
      detail: 'The snippet is on your site, but nothing has reached us from it yet.',
    };
  }
  return {
    state: 'waiting',
    label: 'Waiting to be installed',
    tone: 'neutral',
    detail: 'Add the snippet below to your website and visitors can start chatting.',
  };
}

/**
 * `widget_installed_at` is stamped **once**, by a guarded `UPDATE ... WHERE
 * widget_installed_at IS NULL` in `api/app/api/bot_routes.py`. It is a
 * first-seen timestamp and nothing in the schema ever refreshes it, so labelling
 * it "last seen" would be a lie the customer would act on — they would read a
 * stale date as an outage. It is captioned for what it is.
 */
export const INSTALL_STAMP_CAPTION = 'First seen';

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
  return [apex, `*.${apex}`];
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
      title: 'Any website can embed this chatbot',
      body: 'Your embed key is visible in your page source, so anyone who copies it can run your chatbot — and spend your credits — on their own site.',
    };
  }
  if (domains.length === 0) {
    return {
      id: 'empty',
      tone: 'warning',
      title: 'Nothing is being enforced yet',
      body: 'The check is on but the list is empty, and an empty list lets every origin through. Add your website below to actually lock it down.',
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
    body: 'Requests from any other website are rejected.',
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
      body: `Allowed domains is on, and ${risk.host} does not match any entry, so every request from your own site is rejected before it reaches your chatbot. Add ${risk.suggestions.join(' and ') || 'your website'} under Allowed domains below.`,
    });
  } else if (domainCheckEnabled && domainsConfigured > 0) {
    items.push({
      id: 'allow-list-subdomain',
      title: 'Check the exact address the page is served from',
      body: 'Allowed domains is on. An entry for acme.com does not cover www.acme.com or shop.acme.com — only *.acme.com does. Compare the address bar on the page you installed to the list below, character for character.',
    });
  }

  items.push(
    {
      id: 'external',
      title: 'We only count a real page on your own domain',
      body: 'A load from localhost, from a file:// page, or from the preview on this dashboard never counts as installed — that is deliberate, so a preview cannot mark you live. Open the page on the domain your visitors use.',
    },
    {
      id: 'body',
      title: 'The tag has to be in <body>, not <head>',
      body: 'In <head> the script runs before there is a document to mount into, so the launcher never appears. Paste it immediately before the closing </body> tag.',
    },
    {
      id: 'bot-key',
      title: 'Check the key on the tag character for character',
      body: 'A snippet copied from a different chatbot loads a widget that works perfectly and reports to the wrong place. This chatbot is:',
      code: botKey,
    },
    {
      id: 'csp',
      title: 'A Content-Security-Policy will block the bundle silently',
      body: 'If your site sends a CSP header, the browser refuses the script with a console error and nothing else. Allow both of these:',
      code: `script-src ${scriptOrigin(env)};\nconnect-src ${apiOrigin(apiBaseUrl)};`,
    },
    {
      id: 'cache',
      title: 'A cache may still be serving the old page',
      body: 'Cloudflare, Varnish, a WordPress cache plugin or your host’s own CDN can keep serving the HTML from before you added the tag. Purge the cache, then reload the page with a hard refresh.',
    },
    {
      id: 'blockers',
      title: 'Check it in a clean browser window',
      body: 'An ad blocker or a privacy extension on your own machine can remove the widget for you and nobody else. Open the page in a private window with extensions off before concluding it is not installed.',
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
          `Please keep it in the served HTML and do not hide it with CSS — a hidden`,
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
