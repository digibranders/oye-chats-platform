/**
 * The install email a customer forwards to whoever maintains their website.
 *
 * @i18n-exempt-file: this is not dashboard chrome. It is INSTRUCTIONS sent to a
 * third party: an HTML snippet, `<body>` versus `<head>`, and a
 * Content-Security-Policy header with literal directive names. The recipient
 * may not share the sender's language, and a translated `script-src` is a
 * broken install. Same reasoning as `installPrompt.ts` beside it: the operator
 * reads the dashboard in their language, their developer reads this in English.
 *
 * Its own module rather than a marker inside `deployModel`, because an exempt
 * comment covers a statement and this is a function body full of them.
 */

import { apiOrigin, scriptOrigin } from './deployModel';
import type { PlatformEnv } from '../../../data/platformIntegrations';
/**
 * For an SMB the person who signs up very often cannot edit the website.
 * "Email this to whoever runs your site" is a first-class install path, not a
 * fallback — the previous onboarding assumed the buyer was the installer and
 * dead-ended everyone who was not.
 * It is an email the customer
 * forwards to whoever maintains their website, and it is instructions: an HTML
 * snippet, `<body>` versus `<head>`, a Content-Security-Policy header with
 * literal directive names. The recipient is a third party who may not share
 * the sender's language, and a translated `script-src` is a broken install.
 * Same reasoning as `installPrompt.ts` beside it.
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
